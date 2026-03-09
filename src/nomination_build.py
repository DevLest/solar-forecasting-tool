"""
Build RawBidSet in-memory structure from forecast date and 288 MW values.
No XML here; output is a nested dict for nomination_xml to serialize.
"""
from datetime import date, datetime, timezone, timedelta
from typing import List, Optional

# Intervals per day: 00:05, 00:10, ..., 23:55, 24:00 → 288 slots
# Index i → hour = i // 12, minuteOfHour = 5 * (i % 12 + 1) for i 0..287
# Last slot (i=287): hour 23, minute 60 (end of hour 23)
MINUTES_OF_HOUR = (5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60)
INTERVALS_PER_DAY = 24 * 12  # 288


def _format_datetime(dt: datetime, tz_offset: str) -> str:
    """Format as xs:dateTime with offset, e.g. 2026-02-21T00:00:00.000+08:00"""
    # We have a naive datetime; append the offset as string
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000") + tz_offset


def _parse_timezone_offset(tz_str: str) -> str:
    """Return offset string like +08:00 or -05:00 for use in dateTime."""
    tz_str = (tz_str or "+08:00").strip()
    if tz_str.startswith("+") or tz_str.startswith("-"):
        return tz_str if ":" in tz_str else tz_str + ":00"
    if tz_str.upper() == "Z":
        return "Z"
    # Assume +08:00 if unclear
    return "+08:00"


def build_raw_bid_set(
    forecast_date: date,
    mw_by_interval: List[float],
    generator_mrid: str,
    participant_mrid: str,
    timezone_str: str = "+08:00",
    name: Optional[str] = None,
    source: str = "Default",
) -> dict:
    """
    Build the RawBidSet structure (nested dicts) for nomination-only submission.
    mw_by_interval: 288 floats in order 00:05, 00:10, ..., 24:00 (indices 0..287).
    """
    # Normalize to 288 values; default 0.0 for missing
    mw = list(mw_by_interval)
    while len(mw) < INTERVALS_PER_DAY:
        mw.append(0.0)
    mw = mw[:INTERVALS_PER_DAY]

    tz_offset = _parse_timezone_offset(timezone_str)
    bid_name = (name or generator_mrid or "").strip() or (generator_mrid or "").strip()
    if not bid_name:
        bid_name = None

    # MessageHeader: TimeDate = now (UTC), Source
    now = datetime.now(timezone.utc)
    time_date_str = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    # GeneratingBid: startTime = forecast_date 00:00, stopTime = forecast_date + 1 day 00:00
    start_dt = datetime.combine(forecast_date, datetime.min.time())
    stop_dt = start_dt + timedelta(days=1)
    start_str = _format_datetime(start_dt, tz_offset)
    stop_str = _format_datetime(stop_dt, tz_offset)

    # ProductBid: 24 Nominations
    nominations = []
    for h in range(24):
        interval_start = datetime.combine(forecast_date, datetime.min.time()) + timedelta(hours=h)
        interval_end = interval_start + timedelta(hours=1)
        minute_mw_list = []
        for j, minute in enumerate(MINUTES_OF_HOUR):
            idx = h * 12 + j
            qty = float(mw[idx]) if idx < len(mw) else 0.0
            minute_mw_list.append({"minuteOfHour": minute, "quantity": round(qty, 6)})
        nominations.append({
            "timeIntervalStart": _format_datetime(interval_start, tz_offset),
            "timeIntervalEnd": _format_datetime(interval_end, tz_offset),
            "minuteMW": minute_mw_list,
        })

    return {
        "MessageHeader": {
            "TimeDate": time_date_str,
            "Source": source or "Default",
        },
        "MessagePayload": {
            "GeneratingBid": {
                "name": bid_name[:32] if bid_name else None,  # omit if empty (XSD minLength 1)
                "startTime": start_str,
                "stopTime": stop_str,
                "RegisteredGenerator": {"mrid": generator_mrid.strip()[:32]},
                "MarketParticipant": {"mrid": participant_mrid.strip()[:32]},
                "ProductBid": {
                    "Nomination": nominations,
                },
            },
        },
    }
