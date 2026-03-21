"""HTTP routes and JSON API (same contract as legacy ``run_dashboard.py``)."""
from __future__ import annotations

import json
import os
from datetime import date, datetime

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory

from app.config import ROOT
from app.services.history import load_historical_exports, save_historical_export
from app.services.nomination_accuracy import analyze_uploads
from app.services.nomination_accuracy_dates import resolve_storage_trade_date
from app.services.nomination_accuracy_store import list_runs_with_billing_meta, save_run
from app.services.weather import get_weather_forecast

bp = Blueprint("main", __name__)


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
