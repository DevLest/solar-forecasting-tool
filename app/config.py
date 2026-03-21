"""Application paths and constants (project root = parent of ``app/``)."""
from __future__ import annotations

import os
from pathlib import Path

_ROOT_PATH = Path(__file__).resolve().parent.parent
ROOT = str(_ROOT_PATH)

try:
    from dotenv import load_dotenv

    load_dotenv(_ROOT_PATH / ".env")
except ImportError:
    pass

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


def settlement_zip_passwords_from_env() -> list[str]:
    """Password 1 then 2, matching Excel ``Sheet1`` B2 / B3 and the generated WinRAR batch."""
    p1 = os.environ.get("ARECO_SETTLEMENT_ZIP_PASSWORD1", "").strip()
    p2 = os.environ.get("ARECO_SETTLEMENT_ZIP_PASSWORD2", "").strip()
    out: list[str] = []
    if p1:
        out.append(p1)
    if p2 and p2 != p1:
        out.append(p2)
    return out
