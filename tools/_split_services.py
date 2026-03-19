"""One-off helper: build app/services from run_dashboard.py (run from repo root)."""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
text = (root / "run_dashboard.py").read_text(encoding="utf-8")
lines = text.splitlines()
w = lines[34:398]
header = '''"""Weather forecast service (OpenAI + fallbacks, daily cache)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import date

from app.config import (
    ACCUWEATHER_KEY_FILE,
    CACHE_PREFIX,
    DATA_DIR,
    KEY_FILE,
    LAT,
    LON,
    PLANT_MAX_MW,
)

'''
(root / "app" / "services").mkdir(parents=True, exist_ok=True)
(root / "app" / "services" / "weather.py").write_text(header + "\n".join(w), encoding="utf-8")

hlines = lines[400:464]
hh = '''"""Historical export persistence."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta

from app.config import DATA_DIR, HISTORICAL_EXPORTS_FILE, MAX_HISTORY_DAYS

'''
(root / "app" / "services" / "history.py").write_text(hh + "\n".join(hlines), encoding="utf-8")
print("OK:", root / "app" / "services")
