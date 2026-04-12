"""Trade-day and billing-period helpers for nomination accuracy storage."""
from __future__ import annotations

import math
import re
from datetime import date, timedelta
from typing import Any

from app.services.nomination_accuracy import linear_perc95_from_values


def parse_trade_date_from_mq_filename(filename: str) -> date | None:
    """e.g. ARECO_20260320_MIRF_MT_WESM_DailyMQ.xlsx → 2026-03-20."""
    if not filename:
        return None
    m = re.search(r"ARECO_(\d{8})_", filename, re.I)
    if not m:
        return None
    s = m.group(1)
    try:
        y, mo, d = int(s[:4]), int(s[4:6]), int(s[6:8])
        return date(y, mo, d)
    except ValueError:
        return None


_MONTH_NAMES = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)


def parse_trade_date_from_rtd_dispatch_filename(filename: str) -> date | None:
    """e.g. ``RTD and Actual Dispatch_26 March 2026.xlsm`` → 2026-03-26."""
    if not filename:
        return None
    base = filename.rsplit("/", 1)[-1]
    m = re.search(
        r"_(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})",
        base,
        re.I,
    )
    if m:
        d, mon_s, y = int(m.group(1)), m.group(2).lower(), int(m.group(3))
        try:
            mi = _MONTH_NAMES.index(mon_s.lower()) + 1
            return date(y, mi, d)
        except ValueError:
            pass
    m = re.search(r"(20\d{2})(\d{2})(\d{2})", base)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", base)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    return None


def resolve_storage_trade_date_rtd_dispatch(
    filename: str,
    data_day: date,
) -> tuple[date, list[str]]:
    """Prefer date embedded in workbook filename; else use dominant day from parsed rows."""
    warnings: list[str] = []
    fn_d = parse_trade_date_from_rtd_dispatch_filename(filename)
    if fn_d:
        if fn_d != data_day:
            warnings.append(
                f"Filename date ({fn_d.isoformat()}) differs from day inferred from row times "
                f"({data_day.isoformat()}). Using the filename date as the storage key."
            )
        return fn_d, warnings
    warnings.append(
        "No trade date found in filename (e.g. _26 March 2026); using the day from interval times."
    )
    return data_day, warnings


def parse_date_from_compliance_filename(filename: str) -> date | None:
    """Best-effort: ISO date before 'T', or YYYYMMDD in name."""
    if not filename:
        return None
    m = re.search(r"(20\d{2})-(\d{2})-(\d{2})T", filename)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    m = re.search(r"(20\d{2})(\d{2})(\d{2})", filename)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    return None


def resolve_mq_forecast_lookup_date(
    mq_filename: str,
    trade_date_raw: str,
) -> tuple[date | None, str | None]:
    """
    Trade day used to load stored MPI compliance CSV when the MQ file is uploaded alone.

    **Primary:** ``ARECO_YYYYMMDD`` in the MIRF MQ filename — this is the **intended schedule /
    trade day** for DEL and for the MPI export (RTD in Market DOT), even if the workbook is only
    downloadable the next calendar day.

    **Fallback:** optional ``trade_date_raw`` (YYYY-MM-DD) when the filename has no ARECO date.

    Returns ``(date, None)`` on success, or ``(None, error_message)``.
    """
    mq_d = parse_trade_date_from_mq_filename(mq_filename)
    if mq_d:
        return mq_d, None
    raw = (trade_date_raw or "").strip()
    if raw:
        try:
            return date.fromisoformat(raw), None
        except ValueError:
            return None, "trade_date must be YYYY-MM-DD."
    return (
        None,
        "Add ARECO_YYYYMMDD to the MQ filename, or set Trade date when the filename has no date.",
    )


def resolve_storage_trade_date(
    mq_filename: str,
    compliance_filename: str,
    data_compliance_day: str | date,
) -> tuple[date, list[str]]:
    """
    One row per trade day. Prefer MIRF MQ filename date (ARECO_YYYYMMDD_);
    otherwise fall back to dominant day from CSV data.
    """
    warnings: list[str] = []
    if isinstance(data_compliance_day, date):
        data_d = data_compliance_day
    else:
        data_d = date.fromisoformat(str(data_compliance_day))

    mq_d = parse_trade_date_from_mq_filename(mq_filename)
    fn_c = parse_date_from_compliance_filename(compliance_filename)

    if mq_d:
        chosen = mq_d
        if data_d != mq_d:
            warnings.append(
                f"MQ filename date ({mq_d.isoformat()}) differs from dominant date in "
                f"compliance CSV ({data_d.isoformat()}). Using the MQ filename date as the storage key."
            )
        if fn_c and fn_c not in (mq_d, data_d):
            warnings.append(
                f"Compliance filename contains {fn_c.isoformat()} (often export time); storage key remains {chosen.isoformat()}."
            )
        return chosen, warnings

    warnings.append(
        "No ARECO_YYYYMMDD date found in MQ filename; using the dominant date from the compliance CSV as the storage key."
    )
    return data_d, warnings


def resolve_rtd_backfill_storage(
    rtd_filename: str,
    mq_filename: str,
    chosen: date,
) -> tuple[date, list[str]]:
    """Storage key is the selected trade date; warn if workbook names imply another day."""
    warnings: list[str] = []
    rtd_d = parse_trade_date_from_rtd_dispatch_filename(rtd_filename)
    mq_d = parse_trade_date_from_mq_filename(mq_filename)
    if rtd_d and rtd_d != chosen:
        warnings.append(
            f"RTD workbook filename suggests {rtd_d.isoformat()}, but the selected trade date "
            f"({chosen.isoformat()}) is used as the storage key."
        )
    if mq_d and mq_d != chosen:
        warnings.append(
            f"MIRF MQ filename suggests {mq_d.isoformat()}, but the selected trade date "
            f"({chosen.isoformat()}) is used as the storage key."
        )
    return chosen, warnings


def billing_period_containing(d: date) -> tuple[date, date]:
    """
    Billing period: 26th of one month through 25th of the next (inclusive).

    Examples:
      2026-03-20 → 2026-02-26 .. 2026-03-25
      2026-03-26 → 2026-03-26 .. 2026-04-25
      2026-04-25 → 2026-03-26 .. 2026-04-25
    """
    if d.day >= 26:
        start = date(d.year, d.month, 26)
        if d.month == 12:
            end = date(d.year + 1, 1, 25)
        else:
            end = date(d.year, d.month + 1, 25)
        return start, end
    if d.month == 1:
        start = date(d.year - 1, 12, 26)
    else:
        start = date(d.year, d.month - 1, 26)
    end = date(d.year, d.month, 25)
    return start, end


def billing_period_for_end_month(year: int, month: int) -> tuple[date, date]:
    """
    Billing period named by the calendar month in which it ends (the 25th).

    From the 26th of the previous month through the 25th of ``month`` (inclusive).
    Example: (2026, 3) → 2026-02-26 .. 2026-03-25 (the “March” row on the schedule).
    """
    end = date(year, month, 25)
    if month == 1:
        start = date(year - 1, 12, 26)
    else:
        start = date(year, month - 1, 26)
    return start, end


def billing_period_label(start: date, end: date) -> str:
    return f"{start.isoformat()}_{end.isoformat()}"


def billing_year_trade_day_span(year: int) -> tuple[date, date]:
    """
    Inclusive trade-day range covered by all billing periods whose end (25th) falls in ``year``.

    Example: ``2026`` → ``2025-12-26`` .. ``2026-12-25`` (same union as the 12 monthly rows for
    that year in ``calendar_monthly_rollup``).
    """
    if year < 1990 or year > 2100:
        raise ValueError("year out of range")
    return date(year - 1, 12, 26), date(year, 12, 25)


def billing_end_year_from_run(row: dict[str, Any]) -> int | None:
    """Calendar year of the billing period end date (the 25th), matching monthly rollup labels."""
    be = row.get("billing_period_end")
    if be:
        try:
            return date.fromisoformat(str(be)).year
        except ValueError:
            pass
    cd = str(row.get("compliance_day") or "").strip()
    if not cd:
        return None
    try:
        d = date.fromisoformat(cd)
    except ValueError:
        return None
    _start, end = billing_period_containing(d)
    return end.year


def aggregate_run_stats_for_billing_window(
    runs: list[dict[str, Any]], period_start: date, period_end: date
) -> dict[str, Any]:
    """
    Same keys as ``aggregate_run_stats``, but ``days_in_selection`` counts every trade day in the
    inclusive billing window; ``compliant_days`` is days with a saved run that passed policy;
    ``non_compliant_days`` is the rest (missing uploads or saved non-compliance). MAPE/PERC95
    averages are over saved rows only.

    **Billing-period (WESM-style) rollups** (``mape_bp_pooled``, ``perc95_bp_pooled``): common
    denominator ``bp_max_mq`` is ``max(max_mq_mw)`` over **runs present in this rollup** (saved
    trade days only), not necessarily the ISO filing maximum if some period days have no save.
    Pooled MAPE equals the mean over those days of ``mape * day_max_mq / bp_max_mq`` (same as
    mean of per-interval FPE re-scaled from each day’s template). PERC95 applies the same linear
    percentile rule to all pooled scaled FPEs when ``analytics.fpe_by_interval`` exists (stored
    as full-precision floats in JSON; tiny drift vs Excel can still come from binary floats / file
    sources).
    """
    period_days = (period_end - period_start).days + 1
    if period_days < 1:
        return aggregate_run_stats([])

    by_day: dict[str, dict[str, Any]] = {}
    for r in runs:
        cd = str(r.get("compliance_day") or "").strip()
        if cd:
            by_day[cd] = r

    compliant_days = 0
    d = period_start
    while d <= period_end:
        row = by_day.get(d.isoformat())
        if row and row.get("day_compliant"):
            compliant_days += 1
        d += timedelta(days=1)

    mapes = [float(r["mape"]) for r in runs if r.get("mape") is not None]
    p95s = [float(r["perc95"]) for r in runs if r.get("perc95") is not None]

    mq_peaks = [float(r["max_mq_mw"]) for r in runs if r.get("max_mq_mw") is not None]
    bp_max_mq = max(mq_peaks) if mq_peaks else None

    mape_bp_pooled = None
    mape_bp_days_used = 0
    if bp_max_mq is not None and bp_max_mq > 0:
        weighted: list[float] = []
        for r in runs:
            if r.get("mape") is None or r.get("max_mq_mw") is None:
                continue
            hd = float(r["max_mq_mw"])
            if hd <= 0:
                continue
            weighted.append(float(r["mape"]) * hd / bp_max_mq)
        if weighted:
            mape_bp_pooled = sum(weighted) / len(weighted)
            mape_bp_days_used = len(weighted)

    perc95_bp_pooled = None
    bp_intervals_used = 0
    bp_runs_with_fpe = 0
    if bp_max_mq is not None and bp_max_mq > 0:
        scaled_all: list[float] = []
        for r in runs:
            if r.get("max_mq_mw") is None:
                continue
            hd = float(r["max_mq_mw"])
            if hd <= 0:
                continue
            an = r.get("analytics")
            if not isinstance(an, dict):
                continue
            series = an.get("fpe_by_interval")
            if not isinstance(series, list) or len(series) != 288:
                continue
            bp_runs_with_fpe += 1
            scale = hd / bp_max_mq
            for x in series:
                if x is None:
                    continue
                try:
                    fv = float(x)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(fv):
                    continue
                scaled_all.append(fv * scale)
        bp_intervals_used = len(scaled_all)
        perc95_bp_pooled = linear_perc95_from_values(scaled_all)

    return {
        "days_in_selection": period_days,
        "compliant_days": compliant_days,
        "non_compliant_days": period_days - compliant_days,
        "mape_sum": sum(mapes) if mapes else None,
        "mape_avg": sum(mapes) / len(mapes) if mapes else None,
        "perc95_sum": sum(p95s) if p95s else None,
        "perc95_avg": sum(p95s) / len(p95s) if p95s else None,
        "billing_period_max_mq_mw": bp_max_mq,
        "mape_bp_pooled": mape_bp_pooled,
        "mape_bp_days_used": mape_bp_days_used,
        "perc95_bp_pooled": perc95_bp_pooled,
        "perc95_bp_intervals_used": bp_intervals_used,
        "perc95_bp_runs_with_series": bp_runs_with_fpe,
    }


def aggregate_run_stats(runs: list[dict[str, Any]]) -> dict[str, Any]:
    if not runs:
        return {
            "days_in_selection": 0,
            "compliant_days": 0,
            "non_compliant_days": 0,
            "mape_sum": None,
            "mape_avg": None,
            "perc95_sum": None,
            "perc95_avg": None,
            "billing_period_max_mq_mw": None,
            "mape_bp_pooled": None,
            "mape_bp_days_used": 0,
            "perc95_bp_pooled": None,
            "perc95_bp_intervals_used": 0,
            "perc95_bp_runs_with_series": 0,
        }
    compliant = sum(1 for r in runs if r.get("day_compliant"))
    mapes = [float(r["mape"]) for r in runs if r.get("mape") is not None]
    p95s = [float(r["perc95"]) for r in runs if r.get("perc95") is not None]
    return {
        "days_in_selection": len(runs),
        "compliant_days": compliant,
        "non_compliant_days": len(runs) - compliant,
        "mape_sum": sum(mapes) if mapes else None,
        "mape_avg": sum(mapes) / len(mapes) if mapes else None,
        "perc95_sum": sum(p95s) if p95s else None,
        "perc95_avg": sum(p95s) / len(p95s) if p95s else None,
        # BP rollups only meaningful for a fixed billing window; not computed here.
        "billing_period_max_mq_mw": None,
        "mape_bp_pooled": None,
        "mape_bp_days_used": 0,
        "perc95_bp_pooled": None,
        "perc95_bp_intervals_used": 0,
        "perc95_bp_runs_with_series": 0,
    }
