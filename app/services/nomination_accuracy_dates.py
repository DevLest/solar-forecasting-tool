"""Trade-day and billing-period helpers for nomination accuracy storage."""
from __future__ import annotations

import re
from datetime import date
from typing import Any


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
    }
