"""Short-term RTD (MW) prediction: blends live OCR trend with historical same-time-of-day shape.

No ML/regression - plain arithmetic, same spirit as the weather.py heuristic forecast:
a live-reading trend extrapolated a few minutes ahead, blended with the average RTD this
plant actually ran at the same 5-minute interval label over the last few days.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.config import PLANT_MAX_MW
from app.services.history import load_historical_exports

_MIN_POINTS_FOR_TREND = 3        # need >=3 OCR readings to trust a slope
_HISTORY_LOOKBACK_DAYS = 7       # matches MAX_HISTORY_DAYS retention
_NEXT_HOUR_STEPS = 12            # 12 x 5-min = 1 hour
_STEP_MINUTES = 5
_LIVE_WEIGHT_AT_T0 = 0.7         # weight of the live-based estimate at the very next interval
_LIVE_WEIGHT_DECAY_PER_STEP = 0.12  # live influence fades out across the next-hour curve


def _clamp(mw: float) -> float:
    return round(max(0.0, min(PLANT_MAX_MW, mw)), 3)


def _minutes_since_midnight(label: str) -> int | None:
    label = (label or "").strip()
    if label == "24:00":
        return 24 * 60
    parts = label.split(":")
    if len(parts) != 2:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
    except ValueError:
        return None
    if h < 0 or h > 24 or m < 0 or m > 59:
        return None
    return h * 60 + m


def _label_from_minutes(mins: int) -> str:
    mins = mins % (25 * 60)
    if mins >= 24 * 60:
        return "24:00"
    return f"{mins // 60:02d}:{mins % 60:02d}"


def _next_labels(start_label: str, steps: int) -> list[str]:
    start = _minutes_since_midnight(start_label)
    if start is None:
        return []
    return [_label_from_minutes(start + i * _STEP_MINUTES) for i in range(steps)]


def compute_live_trend(readings: list[tuple[float, float]]) -> dict:
    """
    readings: (unix_ts, mw) oldest-first.
    Least-squares slope (mw per minute) over elapsed seconds.
    Returns {"mw_per_min": float | None, "latest_mw": float | None, "n": int}.
    """
    n = len(readings)
    if n == 0:
        return {"mw_per_min": None, "latest_mw": None, "n": 0}
    latest_mw = readings[-1][1]
    if n < _MIN_POINTS_FOR_TREND:
        return {"mw_per_min": None, "latest_mw": latest_mw, "n": n}

    t0 = readings[0][0]
    xs = [(ts - t0) / 60.0 for ts, _ in readings]  # minutes elapsed
    ys = [mw for _, mw in readings]

    span = xs[-1] - xs[0]
    if span <= 0:
        return {"mw_per_min": None, "latest_mw": latest_mw, "n": n}

    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((x - mean_x) ** 2 for x in xs)
    if den == 0:
        return {"mw_per_min": None, "latest_mw": latest_mw, "n": n}

    slope = num / den
    return {"mw_per_min": slope, "latest_mw": latest_mw, "n": n}


def historical_shape_for_interval(
    interval_label: str,
    records: list[dict] | None = None,
    lookback_days: int = _HISTORY_LOOKBACK_DAYS,
) -> dict:
    """Average `rtd` at this exact interval label across the last `lookback_days` historical exports."""
    if records is None:
        records = load_historical_exports()
    recent = records[-lookback_days:] if records else []
    samples: list[float] = []
    for r in recent:
        for iv in r.get("intervals", []) if isinstance(r, dict) else []:
            if iv.get("interval") == interval_label:
                val = iv.get("rtd")
                if isinstance(val, (int, float)):
                    samples.append(float(val))
                break
    if not samples:
        return {"avg_rtd": None, "n_days": 0, "samples": []}
    return {"avg_rtd": sum(samples) / len(samples), "n_days": len(samples), "samples": samples}


def _predict_point(
    interval_label: str,
    live_component: float | None,
    hist: dict,
    live_weight: float,
    trend_mw_per_min: float | None,
) -> dict:
    hist_avg = hist.get("avg_rtd")
    if live_component is not None and hist_avg is not None:
        predicted = live_weight * live_component + (1 - live_weight) * hist_avg
        basis = "live+historical"
    elif live_component is not None:
        predicted = live_component
        basis = "live_only"
    elif hist_avg is not None:
        predicted = hist_avg
        basis = "historical_only"
    else:
        predicted = None
        basis = "insufficient_data"

    return {
        "interval": interval_label,
        "predicted_mw": _clamp(predicted) if predicted is not None else None,
        "basis": basis,
        "live_component_mw": _clamp(live_component) if live_component is not None else None,
        "historical_avg_mw": round(hist_avg, 3) if hist_avg is not None else None,
        "historical_days_used": hist.get("n_days", 0),
        "trend_mw_per_min": round(trend_mw_per_min, 4) if trend_mw_per_min is not None else None,
    }


def predict_next_interval(
    current_mw: float | None,
    recent_readings: list[tuple[float, float]],
    next_interval_label: str,
    historical_records: list[dict] | None = None,
) -> dict:
    trend = compute_live_trend(recent_readings)
    slope = trend["mw_per_min"]
    live_component = None
    if current_mw is not None:
        live_component = current_mw + slope * _STEP_MINUTES if slope is not None else current_mw

    hist = historical_shape_for_interval(next_interval_label, historical_records)
    return _predict_point(next_interval_label, live_component, hist, _LIVE_WEIGHT_AT_T0, slope)


def predict_next_hour(
    current_mw: float | None,
    recent_readings: list[tuple[float, float]],
    start_interval_label: str,
    historical_records: list[dict] | None = None,
    steps: int = _NEXT_HOUR_STEPS,
) -> list[dict]:
    trend = compute_live_trend(recent_readings)
    slope = trend["mw_per_min"]
    labels = _next_labels(start_interval_label, steps)
    points = []
    for i, label in enumerate(labels):
        live_component = None
        if current_mw is not None:
            minutes_ahead = (i + 1) * _STEP_MINUTES
            raw = current_mw + slope * minutes_ahead if slope is not None else current_mw
            live_component = max(0.0, min(PLANT_MAX_MW, raw))  # pre-clamp so a runaway slope can't blow up the blend
        hist = historical_shape_for_interval(label, historical_records)
        weight = max(0.0, _LIVE_WEIGHT_AT_T0 - i * _LIVE_WEIGHT_DECAY_PER_STEP)
        points.append(_predict_point(label, live_component, hist, weight, slope))
    return points


def get_rtd_forecast(
    current_mw: float | None,
    recent_readings: list[tuple[float, float]],
    next_interval_label: str,
) -> dict:
    """Top-level entry point for the /api/rtd-forecast route. Never raises."""
    try:
        historical_records = load_historical_exports()
        next_interval = predict_next_interval(current_mw, recent_readings, next_interval_label, historical_records)
        next_hour = predict_next_hour(current_mw, recent_readings, next_interval_label, historical_records)

        trend = compute_live_trend(recent_readings)
        parts = []
        if current_mw is not None:
            if trend["mw_per_min"] is not None:
                parts.append(f"live OCR trend ({trend['n']} readings, last ~10 min)")
            else:
                parts.append("live OCR reading (flat)")
        n_days = next_interval.get("historical_days_used", 0)
        if n_days:
            parts.append(f"{n_days}-day historical average at this interval")
        basis_note = " blended with ".join(parts) if parts else "no live or historical data available"

        return {
            "current_mw": _clamp(current_mw) if current_mw is not None else None,
            "next_interval": next_interval,
            "next_hour": next_hour,
            "basis_note": basis_note[0].upper() + basis_note[1:] + "." if basis_note else basis_note,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    except Exception as e:
        return {"error": str(e)}
