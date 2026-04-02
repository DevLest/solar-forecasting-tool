"""HTTP routes and JSON API (same contract as legacy ``run_dashboard.py``)."""
from __future__ import annotations

import io
import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, abort, jsonify, redirect, render_template, request, send_from_directory, url_for
from flask_login import current_user, login_required, login_user, logout_user
from werkzeug.utils import secure_filename

from app.auth import ROLE_ADMIN, api_forbidden, authenticate, request_allowed_for_role, unauthorized_callback
from app.config import DATA_DIR, ROOT, nomination_export_dir, settlement_zip_passwords_from_env
from app.services.env_config import ALLOWED_ENV_KEYS, merge_env_updates, read_env_file_dict
from app.services.billing_invoice_extract import extract_invoice_pdf, merge_input_patches, merge_period_metas
from app.services.billing_history_store import (
    compute_display_totals,
    delete_row,
    display_layout,
    fetch_input_row,
    list_input_rows,
    record_upload,
    update_row_amounts,
    update_row_status,
    upsert_input_row,
)
from app.services.billing_settlement_extract import extract_settlement_master
from app.services.history import (
    filter_historical_exports_nomination_window,
    load_historical_exports,
    save_historical_export,
)
from app.services.nomination_accuracy import (
    analyze_rtd_dispatch_workbook,
    analyze_uploads,
    compliance_blob_must_match_trade_day,
    dominant_day_from_compliance_csv_bytes,
)
from app.services.nomination_accuracy_dates import (
    resolve_mq_forecast_lookup_date,
    resolve_rtd_backfill_storage,
    resolve_storage_trade_date,
)
from app.services.reporting_marketplace import (
    build_marketplace_chart_payload,
    dominant_day_from_market_result_bytes,
)
from app.services.nomination_accuracy_store import (
    calendar_annual_rollup,
    calendar_month_detail,
    calendar_monthly_rollup,
    compliance_day_exists,
    delete_run,
    get_compliance_csv_blob,
    get_market_result_csv_blob,
    list_runs_with_billing_meta,
    list_stored_compliance_csv_days,
    list_stored_market_result_days,
    list_uploaded_compliance_days,
    save_compliance_csv_blob,
    save_market_result_csv_blob,
    save_run,
)
from app.services.users_store import ROLES, create_user, delete_user, list_users_public, update_user
from app.services.weather import get_weather_forecast

bp = Blueprint("main", __name__)


@bp.before_request
def enforce_access():
    if request.endpoint == "main.login":
        return None
    if not current_user.is_authenticated:
        return unauthorized_callback()
    if request.endpoint == "main.logout":
        return None
    if not request_allowed_for_role(request.endpoint, request.method, current_user.role):
        if request.path.startswith("/api/"):
            return api_forbidden()
        abort(403)


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
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS, PATCH, DELETE"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@bp.route("/assets/<path:filename>")
def assets(filename: str):
    return send_from_directory(os.path.join(ROOT, "assets"), filename)


@bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    err: str | None = None
    if request.method == "POST":
        user = authenticate(
            request.form.get("username", ""),
            request.form.get("password", ""),
        )
        if user:
            login_user(user, remember=False)
            nxt = (request.args.get("next") or request.form.get("next") or "").strip() or url_for("main.index")
            if not nxt.startswith("/") or nxt.startswith("//"):
                nxt = url_for("main.index")
            return redirect(nxt)
        err = "Invalid username or password."
    return render_template("pages/login.html", error=err)


@bp.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("main.login"))


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
        records = filter_historical_exports_nomination_window(load_historical_exports())
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


@bp.route("/api/nomination-accuracy/uploaded-dates", methods=["GET"])
def api_nomination_accuracy_uploaded_dates():
    try:
        dates = list_uploaded_compliance_days()
        return jsonify({"ok": True, "dates": dates})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/nomination-reporting/compliance-csv/days", methods=["GET"])
def api_nomination_reporting_compliance_csv_days():
    try:
        dates = list_stored_compliance_csv_days()
        return jsonify({"ok": True, "dates": dates})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/nomination-reporting/compliance-csv", methods=["POST", "OPTIONS"])
def api_nomination_reporting_compliance_csv():
    """Store MPI compliance export CSV by dominant trade day (for Forecast Percentage + reports)."""
    if request.method == "OPTIONS":
        return "", 204
    comp_f = request.files.get("compliance_csv")
    if not comp_f or not comp_f.filename:
        return jsonify({"ok": False, "error": "Missing compliance export (.csv)."}), 400
    if not comp_f.filename.lower().endswith(".csv"):
        return jsonify({"ok": False, "error": "Compliance file must be .csv."}), 400
    raw = comp_f.read()
    try:
        day = dominant_day_from_compliance_csv_bytes(raw)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    if not day:
        return jsonify({"ok": False, "error": "No compliance rows with a parseable date."}), 400
    try:
        _, overwritten = save_compliance_csv_blob(
            day.isoformat(),
            raw,
            os.path.basename(comp_f.filename or "") or "compliance.csv",
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify(
        {
            "ok": True,
            "compliance_day": day.isoformat(),
            "overwritten": overwritten,
        }
    )


def _marketplace_ready_trade_days() -> list[str]:
    c = set(list_stored_compliance_csv_days())
    m = set(list_stored_market_result_days())
    return sorted(c & m)


@bp.route("/api/nomination-reporting/marketplace-ready-days", methods=["GET"])
def api_nomination_reporting_marketplace_ready_days():
    try:
        return jsonify({"ok": True, "dates": _marketplace_ready_trade_days()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/nomination-reporting/market-result-csv/days", methods=["GET"])
def api_nomination_reporting_market_result_csv_days():
    try:
        dates = list_stored_market_result_days()
        return jsonify({"ok": True, "dates": dates})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/nomination-reporting/market-result-csv", methods=["POST", "OPTIONS"])
def api_nomination_reporting_market_result_csv():
    """Store MPI Market Result — Energy Schedules CSV by dominant trade day."""
    if request.method == "OPTIONS":
        return "", 204
    f = request.files.get("market_result_csv")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "Missing Market Result export (.csv)."}), 400
    if not f.filename.lower().endswith(".csv"):
        return jsonify({"ok": False, "error": "File must be .csv."}), 400
    raw = f.read()
    try:
        day = dominant_day_from_market_result_bytes(raw)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    if not day:
        return jsonify({"ok": False, "error": "No usable Interval End dates in file."}), 400
    try:
        _, overwritten = save_market_result_csv_blob(
            day.isoformat(),
            raw,
            os.path.basename(f.filename or "") or "market_result.csv",
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify(
        {"ok": True, "compliance_day": day.isoformat(), "overwritten": overwritten}
    )


@bp.route("/api/nomination-reporting/marketplace-chart", methods=["GET"])
def api_nomination_reporting_marketplace_chart():
    """Charts: compliance (RTD/Actual) + Market Result (day-ahead MW, LMP). Requires both CSVs for ``day``."""
    day_raw = (request.args.get("day") or "").strip()
    if not day_raw:
        return jsonify({"ok": False, "error": "Query parameter day=YYYY-MM-DD is required."}), 400
    try:
        trade_day = date.fromisoformat(day_raw)
    except ValueError:
        return jsonify({"ok": False, "error": "day must be YYYY-MM-DD."}), 400
    comp_b, _ = get_compliance_csv_blob(trade_day.isoformat())
    mkt_b, _ = get_market_result_csv_blob(trade_day.isoformat())
    if not comp_b:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": f"No MPI compliance CSV stored for {trade_day.isoformat()}. Upload it under Reporting first.",
                }
            ),
            400,
        )
    try:
        if mkt_b:
            payload = build_marketplace_chart_payload(comp_b, trade_day, mkt_b)
        else:
            payload = build_marketplace_chart_payload(comp_b, trade_day, None)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, **payload})


@bp.route("/api/nomination-accuracy", methods=["POST", "OPTIONS"])
def api_nomination_accuracy():
    if request.method == "OPTIONS":
        return "", 204
    mq_f = request.files.get("mq_xlsx")
    comp_f = request.files.get("compliance_csv")
    if not mq_f or not mq_f.filename:
        return jsonify({"ok": False, "error": "Missing MQ workbook (.xlsx)."}), 400
    if not mq_f.filename.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"ok": False, "error": "MQ file must be .xlsx or .xlsm."}), 400

    mq_bytes = mq_f.read()
    stored_comp_filename = ""
    used_db_compliance = False
    lookup_trade_date_iso: str | None = None
    if comp_f and comp_f.filename:
        if not comp_f.filename.lower().endswith(".csv"):
            return jsonify({"ok": False, "error": "Compliance file must be .csv."}), 400
        comp_bytes = comp_f.read()
        stored_comp_filename = comp_f.filename or ""
    else:
        used_db_compliance = True
        trade_raw = (request.form.get("trade_date") or "").strip()
        lookup_d, err = resolve_mq_forecast_lookup_date(mq_f.filename or "", trade_raw)
        if err or lookup_d is None:
            return jsonify({"ok": False, "error": err or "Could not determine trade date."}), 400
        lookup_trade_date_iso = lookup_d.isoformat()
        comp_bytes, fn = get_compliance_csv_blob(lookup_trade_date_iso)
        if not comp_bytes:
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": (
                            f"No MPI compliance CSV saved for {lookup_trade_date_iso}. "
                            "Upload it under Reporting first."
                        ),
                    }
                ),
                400,
            )
        stored_comp_filename = fn or ""
        mismatch = compliance_blob_must_match_trade_day(comp_bytes, lookup_d)
        if mismatch:
            return jsonify({"ok": False, "error": mismatch}), 400

    try:
        result = analyze_uploads(mq_bytes, comp_bytes)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    storage_day, date_warnings = resolve_storage_trade_date(
        mq_f.filename or "",
        stored_comp_filename,
        result["summary"]["compliance_day"],
    )
    if used_db_compliance and lookup_trade_date_iso:
        date_warnings = [
            (
                f"Trade day {lookup_trade_date_iso} is taken from the MIRF MQ filename "
                f"(ARECO_YYYYMMDD when present — the intended schedule day, even if the file was "
                f"downloaded later). RTD (Market DOT) and Actual are loaded from the MPI compliance "
                f"export stored in the database for that same day."
            ),
            *date_warnings,
        ]
    row = {
        **result["summary"],
        "mape_ok": result["policy"]["mape_ok"],
        "perc95_ok": result["policy"]["perc95_ok"],
        "day_compliant": result["policy"]["day_compliant"],
        "policy": result["policy"],
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


@bp.route("/api/nomination-accuracy/rtd-dispatch-backfill", methods=["POST", "OPTIONS"])
def api_nomination_accuracy_rtd_dispatch_backfill():
    """
    One trade day per request: ``RTD … Day Ahead`` workbook (RTD + Actual) plus MIRF Daily MQ
    workbook. MQ DEL MW uses the same grid as MPI+MIRF analysis; storage key is the form
    ``trade_date`` (calendar).
    """
    if request.method == "OPTIONS":
        return "", 204
    rtd_f = request.files.get("rtd_file") or request.files.get("file")
    mq_f = request.files.get("mq_xlsx")
    trade_raw = (request.form.get("trade_date") or "").strip()
    if not rtd_f or not rtd_f.filename:
        return (
            jsonify({"ok": False, "error": "Missing RTD / Actual / Day Ahead workbook (.xlsx / .xlsm)."}),
            400,
        )
    if not mq_f or not mq_f.filename:
        return jsonify({"ok": False, "error": "Missing MIRF Daily MQ workbook (.xlsx / .xlsm)."}), 400
    if not trade_raw:
        return jsonify({"ok": False, "error": "trade_date is required (YYYY-MM-DD)."}), 400
    try:
        chosen = date.fromisoformat(trade_raw)
    except ValueError:
        return jsonify({"ok": False, "error": "trade_date must be YYYY-MM-DD."}), 400
    if compliance_day_exists(chosen.isoformat()):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "A saved run already exists for this trade date. "
                    "Delete it in Saved runs before uploading again.",
                }
            ),
            409,
        )
    if not rtd_f.filename.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"ok": False, "error": "RTD workbook must be .xlsx or .xlsm."}), 400
    if not mq_f.filename.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"ok": False, "error": "MIRF MQ file must be .xlsx or .xlsm."}), 400
    raw_rtd = rtd_f.read()
    raw_mq = mq_f.read()
    storage_day, date_warnings = resolve_rtd_backfill_storage(
        rtd_f.filename or "",
        mq_f.filename or "",
        chosen,
    )
    try:
        result = analyze_rtd_dispatch_workbook(
            raw_rtd,
            rtd_f.filename or "",
            storage_day,
            mq_xlsx_bytes=raw_mq,
        )
        row = {
            **result["summary"],
            "mape_ok": result["policy"]["mape_ok"],
            "perc95_ok": result["policy"]["perc95_ok"],
            "day_compliant": result["policy"]["day_compliant"],
            "policy": result["policy"],
            "analytics": result["analytics"],
            "compliance_day": storage_day.isoformat(),
        }
        run_id, overwritten = save_run(row)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify(
        {
            "ok": True,
            "filename": rtd_f.filename,
            "storage_day": storage_day.isoformat(),
            "date_warnings": date_warnings,
            "run_id": run_id,
            "overwritten": overwritten,
            "summary": result["summary"],
            "policy": result["policy"],
            "analytics": result.get("analytics"),
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


@bp.route("/api/nomination-accuracy/runs/<int:run_id>", methods=["DELETE", "OPTIONS"])
def api_nomination_accuracy_run_delete(run_id: int):
    if request.method == "OPTIONS":
        return "", 204
    try:
        removed = delete_run(run_id)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    if not removed:
        return jsonify({"ok": False, "error": "No saved run with that id."}), 404
    return jsonify({"ok": True, "deleted_id": run_id})


@bp.route("/api/nomination-accuracy/analytics/monthly", methods=["GET"])
def api_nomination_accuracy_analytics_monthly():
    year = request.args.get("year", type=int)
    if year is None:
        return jsonify(
            {
                "ok": False,
                "error": "Query parameter year is required (billing periods ending in this year, e.g. 2026).",
            }
        ), 400
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
                    "error": "Query parameters year and month are required (billing period end month, e.g. year=2026&month=1 for Dec 26, 2025–Jan 25, 2026).",
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
    """Roll up by billing year (period end on the 25th), not calendar year of trade date."""
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


@bp.route("/api/billing-history/rows", methods=["GET"])
def api_billing_history_rows():
    try:
        year = request.args.get("year", type=int)
        month = (request.args.get("billing_month") or "").strip() or None
        stmt = (request.args.get("statement_ref") or "").strip() or None
        rows = list_input_rows(year=year, billing_month=month, statement_ref=stmt)
        return jsonify({"ok": True, "rows": rows})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/billing-history/display", methods=["GET"])
def api_billing_history_display():
    try:
        year = request.args.get("year", type=int)
        month = (request.args.get("billing_month") or "").strip() or None
        stmt = (request.args.get("statement_ref") or "").strip() or None
        row_id = request.args.get("row_id", type=int)
        rows = list_input_rows(year=year, billing_month=month, statement_ref=stmt)
        if row_id is not None:
            match = next((r for r in rows if int(r["id"]) == row_id), None)
            if match is None:
                return (
                    jsonify(
                        {
                            "ok": False,
                            "error": "That row is not in the current filter results. Adjust filters or clear the row selection.",
                        }
                    ),
                    404,
                )
            totals = compute_display_totals([match])
        else:
            totals = compute_display_totals(rows)
        layout = display_layout(totals)
        return jsonify(
            {
                "ok": True,
                "rows": rows,
                "totals": totals,
                "display": layout,
                "selected_row_id": row_id,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/billing-history/upload", methods=["POST", "OPTIONS"])
def api_billing_history_upload():
    if request.method == "OPTIONS":
        return "", 204
    try:
        bulk_files = [f for f in request.files.getlist("invoices") if f and f.filename]
        if not bulk_files:
            return jsonify({"ok": False, "error": "No PDF uploads. Choose up to five PDF files."}), 400
        if len(bulk_files) > 5:
            return jsonify({"ok": False, "error": "At most 5 invoice PDFs per request."}), 400
        work = [(f, None) for f in bulk_files]
        patches: list[dict] = []
        details: list[dict] = []
        for f, slot in work:
            if not f.filename.lower().endswith(".pdf"):
                return jsonify({"ok": False, "error": f"Not a PDF: {f.filename!r}."}), 400
            raw = f.read()
            if not raw:
                return jsonify({"ok": False, "error": f"Empty file: {f.filename!r}."}), 400
            res = extract_invoice_pdf(f.filename, raw, slot=slot)
            patches.append(res.input_patch)
            details.append(
                {
                    "filename": f.filename,
                    "slot": slot,
                    "kind": res.detected_kind,
                    "patch": res.input_patch,
                    "warnings": res.warnings,
                    "period_meta": res.period_meta,
                }
            )
        inferred, period_warnings = merge_period_metas([d["period_meta"] for d in details])
        year_raw = (request.form.get("year") or "").strip()
        year_form: int | None = int(year_raw) if year_raw.isdigit() else None
        billing_month_form = (request.form.get("billing_month") or "").strip()
        statement_ref_form = (request.form.get("statement_ref") or "").strip()
        year = year_form if year_form is not None else inferred.get("year")
        billing_month = billing_month_form if billing_month_form else (inferred.get("billing_month") or "")
        statement_ref = statement_ref_form if statement_ref_form else (inferred.get("statement_ref") or "")
        if year is None or not billing_month or not statement_ref:
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": (
                            "Could not determine year, billing month, and Prelim/Final from the PDFs. "
                            "Set those fields manually or use PDFs with a readable billing period and statement type."
                        ),
                        "inferred_partial": inferred,
                    }
                ),
                400,
            )
        merged = merge_input_patches(patches)
        import_notes: list[str] = []
        emf_kinds = ("emf_regular", "emf_iemms", "emf_supplemental")
        if any(d.get("kind") in emf_kinds for d in details) and all(
            merged.get(k) is None for k in ("aa", "ab", "ac")
        ):
            import_notes.append(
                "No market fee amounts (EMF regular, IEMMS, supplemental) were extracted. Final TS-WF "
                "PDFs are often scanned; the server can OCR them if optional packages are installed "
                "(see requirements.txt: pymupdf, pillow, pytesseract, numpy, and Tesseract OCR, or rapidocr on "
                "supported Python versions). Otherwise use a text-based export from IEMOP or enter the three "
                "lines manually in Input. Include the main EMF statement for the regular fee (PS_EMF/FS_EMF), "
                "same as Prelim."
            )
        row_id, amounts = upsert_input_row(
            year=year,
            billing_month=billing_month,
            statement_ref=statement_ref,
            patch=merged,
        )
        for d in details:
            record_upload(row_id, d["filename"], d["kind"], {"patch": d["patch"], "warnings": d["warnings"]})
        rows = list_input_rows(year=year, billing_month=billing_month, statement_ref=statement_ref)
        totals = compute_display_totals(rows)
        layout = display_layout(totals)
        return jsonify(
            {
                "ok": True,
                "row_id": row_id,
                "amounts": amounts,
                "extracted": details,
                "rows": rows,
                "totals": totals,
                "display": layout,
                "applied_period": {
                    "year": year,
                    "billing_month": billing_month,
                    "statement_ref": statement_ref,
                },
                "period_warnings": period_warnings,
                "import_notes": import_notes,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/billing-history/rows/<int:row_id>", methods=["PATCH", "DELETE", "OPTIONS"])
def api_billing_history_row(row_id: int):
    if request.method == "OPTIONS":
        return "", 204
    if request.method == "DELETE":
        try:
            ok = delete_row(row_id)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
        if not ok:
            return jsonify({"ok": False, "error": "Row not found."}), 404
        return jsonify({"ok": True, "deleted_id": row_id})
    data = request.get_json(silent=True) or {}
    try:
        row = None
        if "amounts" in data and isinstance(data["amounts"], dict):
            row = update_row_amounts(row_id, data["amounts"])
        if any(
            k in data
            for k in ("status_sales", "status_purchases", "remarks_sales", "remarks_purchases")
        ):
            row = update_row_status(
                row_id,
                status_sales=data.get("status_sales"),
                status_purchases=data.get("status_purchases"),
                remarks_sales=data.get("remarks_sales"),
                remarks_purchases=data.get("remarks_purchases"),
            )
        if row is None:
            row = fetch_input_row(row_id)
        if not row:
            return jsonify({"ok": False, "error": "Row not found."}), 404
        rows = list_input_rows()
        hit = [r for r in rows if r["id"] == row_id]
        context = hit[0] if hit else row
        totals = compute_display_totals([context])
        layout = display_layout(totals)
        return jsonify({"ok": True, "row": row, "totals": totals, "display": layout})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


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


def _require_admin_api():
    if getattr(current_user, "role", None) != ROLE_ADMIN:
        return api_forbidden("Administrator access required.")


@bp.route("/api/admin/users", methods=["GET", "OPTIONS"])
def api_admin_users_list():
    if request.method == "OPTIONS":
        return "", 204
    gate = _require_admin_api()
    if gate:
        return gate
    try:
        users = list_users_public()
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "users": users, "roles": list(ROLES)})


@bp.route("/api/admin/users", methods=["POST", "OPTIONS"])
def api_admin_users_create():
    if request.method == "OPTIONS":
        return "", 204
    gate = _require_admin_api()
    if gate:
        return gate
    data = request.get_json(silent=True) or {}
    ok, err = create_user(
        username=str(data.get("username") or ""),
        password=str(data.get("password") or ""),
        role=str(data.get("role") or ""),
    )
    if not ok:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "users": list_users_public()})


@bp.route("/api/admin/users/<username>", methods=["PATCH", "OPTIONS"])
def api_admin_users_update(username: str):
    if request.method == "OPTIONS":
        return "", 204
    gate = _require_admin_api()
    if gate:
        return gate
    data = request.get_json(silent=True) or {}
    role_kw: str | None = None
    if "role" in data:
        role_kw = str(data.get("role") or "").strip()
    password_kw: str | None = None
    if "password" in data:
        password_kw = str(data.get("password") or "")
    ok, err = update_user(
        username=username,
        role=role_kw,
        password=password_kw,
        actor_username=getattr(current_user, "username", "") or "",
    )
    if not ok:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "users": list_users_public()})


@bp.route("/api/admin/users/<username>", methods=["DELETE", "OPTIONS"])
def api_admin_users_delete(username: str):
    if request.method == "OPTIONS":
        return "", 204
    gate = _require_admin_api()
    if gate:
        return gate
    ok, err = delete_user(
        username=username,
        actor_username=getattr(current_user, "username", "") or "",
    )
    if not ok:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "users": list_users_public()})


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
