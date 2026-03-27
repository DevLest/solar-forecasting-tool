"""HTTP routes and JSON API (same contract as legacy ``run_dashboard.py``)."""
from __future__ import annotations

import io
import json
import os
import re
from datetime import date, datetime
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

from app.config import DATA_DIR, ROOT, nomination_export_dir, settlement_zip_passwords_from_env
from app.services.env_config import ALLOWED_ENV_KEYS, merge_env_updates, read_env_file_dict
from app.services.billing_settlement_extract import extract_settlement_master
from app.services.history import load_historical_exports, save_historical_export
from app.services.nomination_accuracy import analyze_uploads
from app.services.nomination_accuracy_dates import resolve_storage_trade_date
from app.services.nomination_accuracy_store import (
    calendar_annual_rollup,
    calendar_month_detail,
    calendar_monthly_rollup,
    list_runs_with_billing_meta,
    save_run,
)
from app.services.weather import get_weather_forecast

bp = Blueprint("main", __name__)

_NOM_XML_FILENAME = re.compile(r"^ARECO_\d{2}_\d{2}_\d{4}\.xml$")


def _valid_nomination_export_filename(name: str) -> bool:
    bn = os.path.basename(name or "")
    if _NOM_XML_FILENAME.match(bn):
        return True
    if bn.startswith("VRE_NOM_") and bn.endswith(".csv"):
        if ".." in bn or "/" in bn or "\\" in bn:
            return False
        return True
    return False


def _settlement_export_subdir_from_upload(filename: str) -> str:
    """
    Folder name placed under the user-chosen export path, derived from the master zip name
    (stem only, no .zip). Safe for a single path segment on Windows.
    """
    base = os.path.splitext(os.path.basename(filename or ""))[0].strip()
    slug = secure_filename(base) if base else ""
    if not slug:
        slug = "settlement_master"
    max_len = 120
    if len(slug) > max_len:
        slug = slug[:max_len].rstrip("._- ")
    if not slug:
        slug = "settlement_master"
    return slug


def _merge_settlement_zip_passwords(form) -> list[str]:
    """Env defaults (B2/B3 order); optional form fields override slot 1 and/or 2."""
    env = settlement_zip_passwords_from_env()
    o1 = (form.get("zip_password1") or "").strip()
    o2 = (form.get("zip_password2") or "").strip()
    legacy = (form.get("zip_password") or "").strip()
    if legacy and not o1 and not o2:
        return [legacy]
    if not o1 and not o2:
        return env
    b1 = o1 or (env[0] if len(env) > 0 else "")
    b2 = o2 or (env[1] if len(env) > 1 else "")
    seen: set[str] = set()
    out: list[str] = []
    for p in (b1, b2):
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


@bp.after_request
def _no_cache(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@bp.route("/assets/<path:filename>")
def assets(filename: str):
    return send_from_directory(os.path.join(ROOT, "assets"), filename)


@bp.route("/")
def index():
    return render_template("pages/home.html")


@bp.route("/dashboard.html")
def legacy_dashboard():
    """Old bookmark URL still works."""
    return render_template("pages/home.html")


@bp.route("/api/historical-exports", methods=["GET"])
def api_historical_exports():
    try:
        records = load_historical_exports()
        return Response(
            json.dumps(records, indent=2, ensure_ascii=False),
            mimetype="application/json",
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/save-export", methods=["POST", "OPTIONS"])
def api_save_export():
    if request.method == "OPTIONS":
        return "", 204
    data = request.get_json(silent=True) or {}
    if not data.get("exportedAt"):
        data["exportedAt"] = datetime.now().isoformat()
    try:
        records = save_historical_export(data)
        return jsonify({"ok": True, "count": len(records)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/nomination-save-file", methods=["POST", "OPTIONS"])
def api_nomination_save_file():
    if request.method == "OPTIONS":
        return "", 204
    data = request.get_json(silent=True) or {}
    filename = (data.get("filename") or "").strip()
    content = data.get("content")
    if not filename or content is None:
        return jsonify({"ok": False, "error": "Missing filename or content."}), 400
    if not isinstance(content, str):
        return jsonify({"ok": False, "error": "Content must be a string."}), 400
    if not _valid_nomination_export_filename(filename):
        return jsonify({"ok": False, "error": "Invalid export filename."}), 400
    out_dir = nomination_export_dir()
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        return jsonify({"ok": False, "error": f"Cannot create export folder: {e}"}), 500
    safe_name = os.path.basename(filename)
    out_path = os.path.join(out_dir, safe_name)
    try:
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
    except OSError as e:
        return jsonify({"ok": False, "error": f"Could not write file: {e}"}), 500
    return jsonify({"ok": True, "path": out_path, "dir": out_dir, "filename": safe_name})


@bp.route("/api/app-config", methods=["GET", "POST", "OPTIONS"])
def api_app_config():
    if request.method == "OPTIONS":
        return "", 204
    if request.method == "GET":
        file_vals = read_env_file_dict()
        merged = {k: file_vals.get(k, os.environ.get(k, "")) for k in sorted(ALLOWED_ENV_KEYS)}
        return jsonify({"ok": True, "values": merged})
    data = request.get_json(silent=True) or {}
    updates = data.get("values")
    if not isinstance(updates, dict):
        return jsonify({"ok": False, "error": "Expected JSON object { \"values\": { KEY: value } }."}), 400
    to_write: dict[str, str] = {}
    for key, raw in updates.items():
        if key not in ALLOWED_ENV_KEYS:
            continue
        if raw is None:
            continue
        val = str(raw).strip()
        if val == "":
            continue
        to_write[key] = val
    try:
        merge_env_updates(to_write)
    except OSError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True})


@bp.route("/api/nomination-accuracy", methods=["POST", "OPTIONS"])
def api_nomination_accuracy():
    if request.method == "OPTIONS":
        return "", 204
    mq_f = request.files.get("mq_xlsx")
    comp_f = request.files.get("compliance_csv")
    if not mq_f or not mq_f.filename:
        return jsonify({"ok": False, "error": "Missing MQ workbook (.xlsx)."}), 400
    if not comp_f or not comp_f.filename:
        return jsonify({"ok": False, "error": "Missing compliance export (.csv)."}), 400
    if not mq_f.filename.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"ok": False, "error": "MQ file must be .xlsx or .xlsm."}), 400
    if not comp_f.filename.lower().endswith(".csv"):
        return jsonify({"ok": False, "error": "Compliance file must be .csv."}), 400
    try:
        result = analyze_uploads(mq_f.read(), comp_f.read())
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    storage_day, date_warnings = resolve_storage_trade_date(
        mq_f.filename or "",
        comp_f.filename or "",
        result["summary"]["compliance_day"],
    )
    row = {
        **result["summary"],
        "mape_ok": result["policy"]["mape_ok"],
        "perc95_ok": result["policy"]["perc95_ok"],
        "day_compliant": result["policy"]["day_compliant"],
        "analytics": result["analytics"],
        "compliance_day": storage_day.isoformat(),
    }
    try:
        run_id, overwritten = save_run(row)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Saved analysis failed: {e}"}), 500
    return jsonify(
        {
            "ok": True,
            **result,
            "storage_day": storage_day.isoformat(),
            "date_warnings": date_warnings,
            "run_id": run_id,
            "overwritten": overwritten,
        }
    )


@bp.route("/api/nomination-accuracy/runs", methods=["GET"])
def api_nomination_accuracy_runs():
    year = request.args.get("year", type=int)
    month = request.args.get("month", type=int)
    billing_period_year = request.args.get("billing_period_year", type=int)
    billing_period_month = request.args.get("billing_period_month", type=int)
    limit = request.args.get("limit", 200, type=int)
    if limit is None or limit < 1:
        limit = 200
    limit = min(limit, 2000)
    try:
        payload = list_runs_with_billing_meta(
            year=year,
            month=month,
            billing_period_year=billing_period_year,
            billing_period_month=billing_period_month,
            limit=limit,
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, **payload})


@bp.route("/api/nomination-accuracy/analytics/monthly", methods=["GET"])
def api_nomination_accuracy_analytics_monthly():
    year = request.args.get("year", type=int)
    if year is None:
        return jsonify({"ok": False, "error": "Query parameter year is required (calendar year, e.g. 2026)."}), 400
    try:
        payload = calendar_monthly_rollup(year)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, **payload})


@bp.route("/api/nomination-accuracy/analytics/month-detail", methods=["GET"])
def api_nomination_accuracy_analytics_month_detail():
    year = request.args.get("year", type=int)
    month = request.args.get("month", type=int)
    if year is None or month is None:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Query parameters year and month are required (calendar month, e.g. year=2026&month=3).",
                }
            ),
            400,
        )
    try:
        payload = calendar_month_detail(year, month)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, **payload})


@bp.route("/api/nomination-accuracy/analytics/annual", methods=["GET"])
def api_nomination_accuracy_analytics_annual():
    try:
        payload = calendar_annual_rollup()
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, **payload})


@bp.route("/api/billing/settlement-config", methods=["GET"])
def api_billing_settlement_config():
    p = settlement_zip_passwords_from_env()
    return jsonify(
        {
            "ok": True,
            "zip_password_slots_from_env": len(p),
            "has_zip_passwords": len(p) > 0,
        }
    )


@bp.route("/api/billing/default-export-dir", methods=["GET"])
def api_billing_default_export_dir():
    default = os.path.join(DATA_DIR, "billing_settlement_export")
    try:
        os.makedirs(default, exist_ok=True)
    except OSError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "path": os.path.abspath(default)})


@bp.route("/api/billing/user-export-shortcuts", methods=["GET"])
def api_billing_user_export_shortcuts():
    """
    Real folder paths on the machine running Flask (same as Copy-as-path in Explorer).
    Browsers cannot fill these from a native picker; use these buttons instead.
    """
    shortcuts: list[dict[str, str]] = []
    seen: set[str] = set()
    home = Path.home()

    def add(label: str, folder: Path) -> None:
        try:
            if not folder.is_dir():
                return
            p = os.path.abspath(str(folder.resolve()))
        except OSError:
            return
        if p not in seen:
            seen.add(p)
            shortcuts.append({"label": label, "path": p})

    if os.name == "nt":
        for env_key in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
            base = os.environ.get(env_key)
            if not base:
                continue
            add("Desktop (OneDrive)", Path(base) / "Desktop")
            add("Downloads (OneDrive)", Path(base) / "Downloads")
            add("Documents (OneDrive)", Path(base) / "Documents")

    add("Desktop", home / "Desktop")
    add("Downloads", home / "Downloads")
    add("Documents", home / "Documents")

    return jsonify({"ok": True, "shortcuts": shortcuts})


@bp.route("/api/billing/settlement-extract", methods=["POST", "OPTIONS"])
def api_billing_settlement_extract():
    if request.method == "OPTIONS":
        return "", 204
    zf = request.files.get("settlement_zip")
    output_dir = (request.form.get("output_dir") or "").strip()
    zip_passwords = _merge_settlement_zip_passwords(request.form)
    if not zf or not zf.filename:
        return jsonify({"ok": False, "error": "Missing settlement master .zip upload."}), 400
    if not output_dir:
        return jsonify({"ok": False, "error": "Missing export folder path."}), 400
    if not os.path.isabs(output_dir):
        return jsonify(
            {
                "ok": False,
                "error": "Export path must be absolute (full path on the PC running this app), e.g. C:\\Users\\You\\Desktop\\Settlement.",
            }
        ), 400
    parent_abs = os.path.abspath(output_dir)
    subdir = _settlement_export_subdir_from_upload(zf.filename)
    out_abs = os.path.join(parent_abs, subdir)
    if not zf.filename.lower().endswith(".zip"):
        return jsonify({"ok": False, "error": "Master file must be a .zip archive."}), 400
    try:
        raw = zf.read()
        if not raw:
            return jsonify({"ok": False, "error": "Uploaded zip is empty."}), 400
        result = extract_settlement_master(io.BytesIO(raw), out_abs, zip_passwords=zip_passwords)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    payload = {
        "ok": result.ok,
        "output_dir": result.output_dir,
        "export_parent": parent_abs,
        "export_subdir": subdir,
        "errors": result.errors,
        "warnings": result.warnings,
        "areco_days": result.areco_days,
        "arecoss_days": result.arecoss_days,
        "files_placed": result.files_placed,
        "files_count": len(result.files_placed),
        "zip_password_slots_used": len(zip_passwords),
        "zip_password_attempts_per_daily": len(zip_passwords) + 1 if zip_passwords else 1,
    }
    status = 200 if result.ok else 422
    return jsonify(payload), status


@bp.route("/api/weather-forecast", methods=["POST", "OPTIONS"])
def api_weather_forecast():
    if request.method == "OPTIONS":
        return "", 204
    data = request.get_json(silent=True) or {}
    target = data.get("date") or date.today().isoformat()
    force = bool(data.get("force_refresh"))
    lat = data.get("lat")
    lon = data.get("lon")
    if lat is not None and lon is not None:
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            lat, lon = None, None
    result = get_weather_forecast(target, force_refresh=force, lat=lat, lon=lon)
    status = 200 if "error" not in result else 502
    return jsonify(result), status
