"""Application paths and constants (project root = parent of ``app/``)."""
from __future__ import annotations

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PORT = int(os.environ.get("ARECO_PORT", "8765"))

KEY_FILE = os.path.join(ROOT, "openai_api_key.txt")
ACCUWEATHER_KEY_FILE = os.path.join(ROOT, "accuweather_api_key.txt")
DATA_DIR = os.path.join(ROOT, "data")
CACHE_PREFIX = "weather_forecast_"
HISTORICAL_EXPORTS_FILE = os.path.join(DATA_DIR, "historical_exports.json")
MAX_HISTORY_DAYS = 7

PLANT_MAX_MW = 50.0
DEFAULT_LAT = 10.638755644610793
DEFAULT_LON = 123.00417639451439
LAT, LON = DEFAULT_LAT, DEFAULT_LON
