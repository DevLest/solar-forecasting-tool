"""Marketplace reporting: Energy Schedules CSV + compliance CSV → hourly charts and LMP stats."""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from statistics import mean
from typing import Any

from app.services.nomination_accuracy import parse_compliance_csv

# Compliance window aligned with nomination accuracy paste (MPI rows 05:05–19:00)
T_START = time(5, 5)
T_END = time(19, 0)


def _parse_dt_interval_end(raw: str) -> datetime | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt in ("%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def parse_market_result_energy_schedules(content: bytes) -> list[tuple[datetime, float, float]]:
    """
    MPI Market Result — Energy Schedules CSV.
    Returns rows ``(interval_end, mw, lmp)`` (MW = day-ahead / schedule MW, LMP).
    """
    text = content.decode("utf-8-sig", errors="replace")
    f = io.StringIO(text)
    reader = csv.reader(f)
    rows = list(reader)
    if not rows:
        return []
    header = [str(h).strip().lower() for h in rows[0]]

    def col(*names: str) -> int:
        for i, h in enumerate(header):
            for n in names:
                if n in h:
                    return i
        return -1

    i_end = col("interval end")
    i_mw = col("mw")
    i_lmp = col("lmp")
    if i_end < 0 or i_mw < 0 or i_lmp < 0:
        raise ValueError("Market Result CSV must have Interval End, MW, and LMP columns.")

    out: list[tuple[datetime, float, float]] = []
    for row in rows[1:]:
        if len(row) <= max(i_end, i_mw, i_lmp):
            continue
        dt = _parse_dt_interval_end(row[i_end])
        if dt is None:
            continue
        try:
            mw = float(str(row[i_mw]).replace(",", "").strip() or 0)
            lmp = float(str(row[i_lmp]).replace(",", "").strip() or 0)
        except ValueError:
            continue
        out.append((dt, mw, lmp))
    return out


def dominant_day_from_market_result_rows(rows: list[tuple[datetime, float, float]]) -> date | None:
    if not rows:
        return None
    counts: dict[date, int] = defaultdict(int)
    for dt, _, _ in rows:
        # Trading day for interval-ending-on-day rows
        d = dt.date()
        counts[d] += 1
    return max(counts, key=counts.get) if counts else None


def dominant_day_from_market_result_bytes(content: bytes) -> date | None:
    rows = parse_market_result_energy_schedules(content)
    return dominant_day_from_market_result_rows(rows)


def lmp_average_excel_rows_e7_through_e19(content: bytes) -> float:
    """
    Average LMP for the 13 data rows that fall on Excel rows 7–19 (1-based file lines:
    line 1 = header, so **file lines 7–19** = data row indices 5..17).
    Matches “LMP column E7:E19” when the export matches the standard MPI layout.
    """
    text = content.decode("utf-8-sig", errors="replace")
    f = io.StringIO(text)
    reader = csv.reader(f)
    rows = list(reader)
    if len(rows) < 19:
        raise ValueError("Market Result CSV has too few rows for LMP rows 7–19.")
    header = [str(h).strip().lower() for h in rows[0]]

    def col(*names: str) -> int:
        for i, h in enumerate(header):
            for n in names:
                if n in h:
                    return i
        return -1

    i_lmp = col("lmp")
    if i_lmp < 0:
        raise ValueError("Market Result CSV has no LMP column.")
    data = rows[1:]
    if len(data) < 18:
        raise ValueError("Not enough data rows for LMP rows 7–19.")
    slice_rows = data[5:18]
    lmps: list[float] = []
    for r in slice_rows:
        if len(r) <= i_lmp:
            continue
        try:
            lmps.append(float(str(r[i_lmp]).replace(",", "").strip() or 0))
        except ValueError:
            continue
    if not lmps:
        raise ValueError("Could not read LMP values for rows 7–19.")
    return float(mean(lmps))


def _compliance_rows_for_day(
    parsed: list[tuple[datetime, float, float]], day: date
) -> list[tuple[datetime, float, float]]:
    out: list[tuple[datetime, float, float]] = []
    for dt, rtd, act in parsed:
        if dt.date() != day:
            continue
        t = dt.time()
        if t < T_START or t > T_END:
            continue
        out.append((dt, rtd, act))
    out.sort(key=lambda x: x[0])
    return out


def _hourly_from_compliance(
    parsed: list[tuple[datetime, float, float]], day: date
) -> dict[int, tuple[float, float]]:
    """Hour -> (mean_rtd, mean_actual) from all 5-min samples in that clock hour on ``day``."""
    buckets: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for dt, rtd, act in parsed:
        if dt.date() != day:
            continue
        buckets[dt.hour].append((rtd, act))
    out: dict[int, tuple[float, float]] = {}
    for h, pairs in buckets.items():
        if not pairs:
            continue
        out[h] = (
            float(mean([p[0] for p in pairs])),
            float(mean([p[1] for p in pairs])),
        )
    return out


def _market_maps_for_day(
    rows: list[tuple[datetime, float, float]], day: date
) -> tuple[dict[int, float], dict[int, float]]:
    """Hour -> MW and hour -> LMP for intervals ending on ``day`` (and 00:00 next day as hour 24)."""
    mw_h: dict[int, float] = {}
    lmp_h: dict[int, float] = {}
    next_mid = datetime.combine(day + timedelta(days=1), time(0, 0))
    for dt, mw, lmp in rows:
        if dt.date() == day:
            mw_h[dt.hour] = mw
            lmp_h[dt.hour] = lmp
        elif dt == next_mid:
            mw_h[24] = mw
            lmp_h[24] = lmp
    return mw_h, lmp_h


def build_marketplace_chart_payload(
    compliance_bytes: bytes,
    market_bytes: bytes,
    trade_day: date,
) -> dict[str, Any]:
    """
    Build JSON-serializable chart data: dispatch series, 6AM–6PM hourly chart, LMP stats.
    """
    parsed = parse_compliance_csv(compliance_bytes)
    mrows = parse_market_result_energy_schedules(market_bytes)

    lmp_avg_e7_e19 = lmp_average_excel_rows_e7_through_e19(market_bytes)
    hourly_c = _hourly_from_compliance(parsed, trade_day)
    mw_map, lmp_map = _market_maps_for_day(mrows, trade_day)

    win_rows = _compliance_rows_for_day(parsed, trade_day)
    dispatch: list[dict[str, Any]] = []
    for i, (dt, rtd, act) in enumerate(win_rows, start=1):
        h = dt.hour
        da = mw_map.get(h)
        if da is None and h == 0 and 24 in mw_map:
            da = mw_map.get(24)
        dispatch.append(
            {
                "i": i,
                "interval_end": dt.isoformat(sep=" "),
                "rtd_mw": rtd,
                "actual_mw": act,
                "day_ahead_mw": da,
            }
        )

    hours_6_18 = list(range(6, 19))
    hourly_chart: list[dict[str, Any]] = []
    actual_for_avg: list[float] = []
    for h in hours_6_18:
        rtd_m, act_m = hourly_c.get(h, (None, None))
        if act_m is not None:
            actual_for_avg.append(act_m)
        hourly_chart.append(
            {
                "hour": h,
                "label": _hour_label_ampm(h),
                "rtd_mw_avg": rtd_m,
                "actual_mw_avg": act_m,
                "day_ahead_mw": mw_map.get(h),
                "lmp": lmp_map.get(h),
            }
        )

    actual_avg_6_to_18 = float(mean(actual_for_avg)) if actual_for_avg else None
    total_actual_mwh_hint = None
    if win_rows:
        # MWh from MW over 5-min: each slot = MW/12
        total_actual_mwh_hint = float(sum(act for _, _, act in win_rows) / 12.0)

    return {
        "trade_day": trade_day.isoformat(),
        "lmp_average_e7_e19": lmp_avg_e7_e19,
        "lmp_average_e7_e19_display": round(lmp_avg_e7_e19 / 1000.0, 3),
        "actual_dispatch_avg_mw_6am_6pm": actual_avg_6_to_18,
        "actual_dispatch_mwh_compliance_window": total_actual_mwh_hint,
        "dispatch_series": dispatch,
        "hourly_6am_6pm": hourly_chart,
    }


def _hour_label_ampm(h: int) -> str:
    if h == 0:
        return "12AM"
    if h < 12:
        return str(h) + "AM"
    if h == 12:
        return "12PM"
    return str(h - 12) + "PM"

