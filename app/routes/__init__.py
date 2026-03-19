"""HTTP routes and JSON API (same contract as legacy ``run_dashboard.py``)."""
from __future__ import annotations

import json
import os
from datetime import date, datetime

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory

from app.config import ROOT
from app.services.history import load_historical_exports, save_historical_export
from app.services.weather import get_weather_forecast

bp = Blueprint("main", __name__)


@bp.after_request
def _no_cache(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
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
