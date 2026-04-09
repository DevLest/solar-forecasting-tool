"""Historical export persistence."""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta

from app.config import (
    DATA_DIR,
    HISTORICAL_EXPORTS_FILE,
    MAX_HISTORY_DAYS,
    NOMINATION_HISTORY_FUTURE_DAYS,
    NOMINATION_HISTORY_PAST_DAYS,
)

def load_historical_exports() -> list:
    """Load historical exports from JSON file. Returns list of records (newest last)."""
    if not os.path.isfile(HISTORICAL_EXPORTS_FILE):
        return []
    try:
        with open(HISTORICAL_EXPORTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _parse_forecast_date(record: dict) -> date | None:
    """Forecast delivery date as a date, or None if unknown."""
    key = _forecast_date_key(record)
    if not key:
        return None
    try:
        return date.fromisoformat(key)
    except ValueError:
        return None


def filter_historical_exports_nomination_window(records: list) -> list:
    """
    Keep exports whose forecast date falls in the nomination history window:
    NOMINATION_HISTORY_PAST_DAYS calendar days ending today, plus the next
    NOMINATION_HISTORY_FUTURE_DAYS days (11 days total, matching advance upload horizon).
    """
    if not records:
        return []
    today = date.today()
    start = today - timedelta(days=NOMINATION_HISTORY_PAST_DAYS - 1)
    end = today + timedelta(days=NOMINATION_HISTORY_FUTURE_DAYS)
    out = []
    for r in records:
        d = _parse_forecast_date(r)
        if d is None:
            continue
        if start <= d <= end:
            out.append(r)
    return out


def filter_historical_exports_forecast_date_range(
    records: list,
    start_iso: str | None,
    end_iso: str | None,
) -> list:
    """Filter exports by forecast reference date (YYYY-MM-DD), inclusive.

    If start/end are missing or invalid, the corresponding bound is ignored.
    """
    if not records:
        return []
    start_d: date | None = None
    end_d: date | None = None
    if start_iso:
        try:
            start_d = date.fromisoformat(str(start_iso).strip()[:10])
        except ValueError:
            start_d = None
    if end_iso:
        try:
            end_d = date.fromisoformat(str(end_iso).strip()[:10])
        except ValueError:
            end_d = None
    if start_d is None and end_d is None:
        return list(records)
    out: list = []
    for r in records:
        d = _parse_forecast_date(r if isinstance(r, dict) else {})
        if d is None:
            continue
        if start_d is not None and d < start_d:
            continue
        if end_d is not None and d > end_d:
            continue
        out.append(r)
    return out


def _forecast_date_key(record: dict):
    """Return YYYY-MM-DD for this record, or None. One export per forecast date."""
    iso = record.get("forecastRefDateIso") or record.get("forecastRefDateIso")
    if iso and isinstance(iso, str) and len(iso) >= 10:
        return iso[:10]
    # Try parsing forecastRefDate (e.g. "March 15, 2026")
    ref = record.get("forecastRefDate")
    if not ref:
        return None
    try:
        from datetime import datetime as dt
        d = dt.strptime(str(ref).strip(), "%B %d, %Y")
        return d.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass
    return None


def save_historical_export(record: dict) -> list:
    """
    Replace existing export for the same forecast date, then add this record. Trim to last MAX_HISTORY_DAYS.
    Only one export per forecast date. record should include 'exportedAt' and 'forecastRefDateIso' (YYYY-MM-DD).
    """
    date_key = _forecast_date_key(record)
    records = load_historical_exports()
    if date_key:
        records = [r for r in records if _forecast_date_key(r) != date_key]
    records.append(record)

    cutoff = datetime.utcnow() - timedelta(days=MAX_HISTORY_DAYS)

    def keep(r):
        t = r.get("exportedAt") or r.get("savedAt") or ""
        if not t:
            return True
        try:
            d = datetime.fromisoformat(t.replace("Z", "+00:00"))
            if d.tzinfo:
                d = (d - d.utcoffset()).replace(tzinfo=None)
            return d >= cutoff
        except (ValueError, TypeError):
            return True

    records = [r for r in records if keep(r)]
    records.sort(key=lambda r: (r.get("exportedAt") or r.get("savedAt") or ""))

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(HISTORICAL_EXPORTS_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
    return records