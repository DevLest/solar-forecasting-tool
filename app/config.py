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

# PaaS (e.g. Render, Heroku) set PORT; ARECO_PORT overrides for local dev when PORT is unset.
PORT = int(os.environ.get("PORT", os.environ.get("ARECO_PORT", "8765")))

KEY_FILE = os.path.join(ROOT, "openai_api_key.txt")
ACCUWEATHER_KEY_FILE = os.path.join(ROOT, "accuweather_api_key.txt")
# ARECO_DATA_DIR overrides where synced/generated data lives - e.g. a Render
# persistent Disk mount path on the hosted Viewer - instead of <project>/data.
DATA_DIR = os.environ.get("ARECO_DATA_DIR", "").strip() or os.path.join(ROOT, "data")
CACHE_PREFIX = "weather_forecast_"
HISTORICAL_EXPORTS_FILE = os.path.join(DATA_DIR, "historical_exports.json")
MAX_HISTORY_DAYS = 7

# Nomination dashboard: Resource Nomination History shows this many days by forecast date
# (3 days through today + 8 days ahead = 11 calendar days; aligns with advance uploads up to 8 days).
NOMINATION_HISTORY_PAST_DAYS = 3
NOMINATION_HISTORY_FUTURE_DAYS = 8

PLANT_MAX_MW = 50.0
# Free NWP forecast (app.services.nwp_forecast). Plant: 65 MWp DC / 50 MW AC, 167 inverters.
# ARECO_PV_PERFORMANCE_RATIO excludes temperature loss (modelled separately), so it sits above the
# site PR: 0.975 x ~0.90 average temperature factor ~= the 87.6% site PR. Recalibrate with
# ``python -m app.services.pv_calibration``.
PLANT_DC_MWP = float(os.environ.get("ARECO_PLANT_DC_MWP", "65") or 65)
PV_PERFORMANCE_RATIO = float(os.environ.get("ARECO_PV_PERFORMANCE_RATIO", "0.85") or 0.85)
# Installed inverters. The Weather models panel scales DC and AC capacity by available / installed.
PLANT_INVERTERS = int(os.environ.get("ARECO_PLANT_INVERTERS", "167") or 167)
LOCAL_UTC_OFFSET_HOURS = 8  # Philippines, no DST
DEFAULT_LAT = 10.63782595665277
DEFAULT_LON = 123.00456203862562
LAT, LON = DEFAULT_LAT, DEFAULT_LON


def nomination_export_dir() -> str:
    """
    Folder where nomination XML / VRE CSV are written by the server (default: ``<project>/automate``).
    Set ``ARECO_NOMINATION_EXPORT_DIR`` in ``.env`` to an absolute path or a path relative to the project root.
    """
    raw = os.environ.get("ARECO_NOMINATION_EXPORT_DIR", "").strip()
    if not raw:
        return os.path.join(ROOT, "automate")
    if os.path.isabs(raw):
        return os.path.abspath(os.path.normpath(raw))
    return os.path.abspath(os.path.normpath(os.path.join(ROOT, raw)))


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
