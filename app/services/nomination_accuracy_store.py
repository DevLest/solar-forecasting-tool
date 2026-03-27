"""SQLite persistence: one row per trade day (upsert), billing period 26th–25th."""
from __future__ import annotations

import calendar
import json
import os
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any

from app.config import DATA_DIR
from app.services.nomination_accuracy_dates import (
    aggregate_run_stats,
    billing_period_containing,
    billing_period_for_start_month,
    billing_period_label,
)

DB_FILENAME = "nomination_accuracy.sqlite3"


def db_path() -> str:
    os.makedirs(DATA_DIR, exist_ok=True)
    return os.path.join(DATA_DIR, DB_FILENAME)


def _migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS nomination_accuracy_run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          compliance_day TEXT NOT NULL,
          mape REAL,
          perc95 REAL,
          max_mq_mw REAL,
          n_intervals INTEGER,
          compliance_rows_in_window INTEGER,
          mq_sheet TEXT,
          mape_ok INTEGER NOT NULL,
          perc95_ok INTEGER NOT NULL,
          day_compliant INTEGER NOT NULL,
          analytics_json TEXT NOT NULL,
          billing_period_start TEXT,
          billing_period_end TEXT
        )
        """
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(nomination_accuracy_run)").fetchall()}
    if "billing_period_start" not in cols:
        conn.execute(
            "ALTER TABLE nomination_accuracy_run ADD COLUMN billing_period_start TEXT"
        )
    if "billing_period_end" not in cols:
        conn.execute("ALTER TABLE nomination_accuracy_run ADD COLUMN billing_period_end TEXT")

    for row in conn.execute(
        "SELECT id, compliance_day FROM nomination_accuracy_run WHERE billing_period_start IS NULL OR billing_period_end IS NULL"
    ).fetchall():
        rid, cds = row[0], row[1]
        try:
            d = date.fromisoformat(str(cds))
        except ValueError:
            continue
        bs, be = billing_period_containing(d)
        conn.execute(
            "UPDATE nomination_accuracy_run SET billing_period_start = ?, billing_period_end = ? WHERE id = ?",
            (bs.isoformat(), be.isoformat(), rid),
        )

    conn.execute(
        """
        DELETE FROM nomination_accuracy_run WHERE id NOT IN (
          SELECT MAX(id) FROM nomination_accuracy_run GROUP BY compliance_day
        )
        """
    )

    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_nar_compliance_day_uq ON nomination_accuracy_run(compliance_day)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nar_billing_start ON nomination_accuracy_run(billing_period_start)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nar_created ON nomination_accuracy_run(created_at)")


def init_nomination_accuracy_db() -> None:
    path = db_path()
    with sqlite3.connect(path) as conn:
        _migrate(conn)
        conn.commit()


def save_run(row: dict[str, Any]) -> tuple[int, bool]:
    """
    Upsert by ``compliance_day`` (trade/storage date, ISO).
    Returns ``(row_id, overwritten)``.
    """
    init_nomination_accuracy_db()
    trade_iso = str(row["compliance_day"])
    d = date.fromisoformat(trade_iso)
    bs, be = billing_period_containing(d)
    created = datetime.now(timezone.utc).isoformat()
    analytics_json = json.dumps(row.get("analytics") or {}, separators=(",", ":"))

    with sqlite3.connect(db_path()) as conn:
        prev = conn.execute(
            "SELECT id FROM nomination_accuracy_run WHERE compliance_day = ?",
            (trade_iso,),
        ).fetchone()
        overwritten = prev is not None

        cur = conn.execute(
            """
            INSERT INTO nomination_accuracy_run (
              created_at, compliance_day, mape, perc95, max_mq_mw, n_intervals,
              compliance_rows_in_window, mq_sheet, mape_ok, perc95_ok, day_compliant,
              analytics_json, billing_period_start, billing_period_end
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(compliance_day) DO UPDATE SET
              created_at = excluded.created_at,
              mape = excluded.mape,
              perc95 = excluded.perc95,
              max_mq_mw = excluded.max_mq_mw,
              n_intervals = excluded.n_intervals,
              compliance_rows_in_window = excluded.compliance_rows_in_window,
              mq_sheet = excluded.mq_sheet,
              mape_ok = excluded.mape_ok,
              perc95_ok = excluded.perc95_ok,
              day_compliant = excluded.day_compliant,
              analytics_json = excluded.analytics_json,
              billing_period_start = excluded.billing_period_start,
              billing_period_end = excluded.billing_period_end
            RETURNING id
            """,
            (
                created,
                trade_iso,
                row.get("mape"),
                row.get("perc95"),
                row.get("max_mq_mw"),
                row.get("n_intervals"),
                row.get("compliance_rows_in_window"),
                row.get("mq_sheet"),
                1 if row.get("mape_ok") else 0,
                1 if row.get("perc95_ok") else 0,
                1 if row.get("day_compliant") else 0,
                analytics_json,
                bs.isoformat(),
                be.isoformat(),
            ),
        )
        rid_row = cur.fetchone()
        conn.commit()
        if rid_row:
            rid = int(rid_row[0])
        else:
            r2 = conn.execute(
                "SELECT id FROM nomination_accuracy_run WHERE compliance_day = ?",
                (trade_iso,),
            ).fetchone()
            rid = int(r2[0]) if r2 else 0
        return rid, overwritten


def list_runs(
    year: int | None = None,
    month: int | None = None,
    billing_period_year: int | None = None,
    billing_period_month: int | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    init_nomination_accuracy_db()
    conditions: list[str] = []
    params: list[Any] = []

    if billing_period_year is not None and billing_period_month is not None:
        p0, p1 = billing_period_for_start_month(billing_period_year, billing_period_month)
        conditions.append("compliance_day >= ? AND compliance_day <= ?")
        params.extend([p0.isoformat(), p1.isoformat()])
    elif year is not None and month is not None:
        start = f"{year:04d}-{month:02d}-01"
        end = f"{year + 1:04d}-01-01" if month == 12 else f"{year:04d}-{month + 1:02d}-01"
        conditions.append("compliance_day >= ? AND compliance_day < ?")
        params.extend([start, end])
    elif year is not None:
        conditions.append("compliance_day >= ? AND compliance_day < ?")
        params.extend([f"{year:04d}-01-01", f"{year + 1:04d}-01-01"])

    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    q = f"""
        SELECT id, created_at, compliance_day, mape, perc95, max_mq_mw, n_intervals,
               compliance_rows_in_window, mq_sheet, mape_ok, perc95_ok, day_compliant,
               billing_period_start, billing_period_end
        FROM nomination_accuracy_run{where}
        ORDER BY compliance_day DESC, id DESC
        LIMIT ?
        """
    params.append(int(limit))
    with sqlite3.connect(db_path()) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(q, params)
        return [dict(r) for r in cur.fetchall()]


def list_runs_with_billing_meta(
    year: int | None = None,
    month: int | None = None,
    billing_period_year: int | None = None,
    billing_period_month: int | None = None,
    limit: int = 500,
) -> dict[str, Any]:
    runs = list_runs(
        year=year,
        month=month,
        billing_period_year=billing_period_year,
        billing_period_month=billing_period_month,
        limit=limit,
    )
    out: dict[str, Any] = {"runs": runs, "billing_period": None, "stats": aggregate_run_stats(runs)}
    if billing_period_year is not None and billing_period_month is not None:
        p0, p1 = billing_period_for_start_month(billing_period_year, billing_period_month)
        out["billing_period"] = {
            "start": p0.isoformat(),
            "end": p1.isoformat(),
            "label": billing_period_label(p0, p1),
        }
    return out


def calendar_monthly_rollup(year: int, limit_per_year: int = 8000) -> dict[str, Any]:
    """
    Roll up saved runs by **calendar month** (trade date ``compliance_day``), for one year.
    Always returns 12 rows (Jan–Dec); months with no data have zero days and null averages.
    """
    if year < 1990 or year > 2100:
        raise ValueError("year out of range")
    runs = list_runs(year=year, month=None, limit=limit_per_year)
    by_month: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        cd = str(r.get("compliance_day") or "")
        if len(cd) < 7:
            continue
        try:
            y = int(cd[:4])
            mo = int(cd[5:7])
        except ValueError:
            continue
        if y == year and 1 <= mo <= 12:
            by_month[mo].append(r)

    months: list[dict[str, Any]] = []
    for m in range(1, 13):
        chunk = by_month.get(m, [])
        st = aggregate_run_stats(chunk)
        months.append(
            {
                "month": m,
                "label": calendar.month_name[m],
                "key": f"{year:04d}-{m:02d}",
                "stats": st,
            }
        )
    return {
        "year": year,
        "months": months,
        "year_totals": aggregate_run_stats(runs),
    }


def calendar_month_detail(year: int, month: int) -> dict[str, Any]:
    """
    Per calendar day in ``year``-``month``: which trade days have a saved run and which are missing.
    One saved row per ``compliance_day`` (re-uploads replace the same day).
    """
    if year < 1990 or year > 2100:
        raise ValueError("year out of range")
    if month < 1 or month > 12:
        raise ValueError("month must be 1–12")
    init_nomination_accuracy_db()
    last_day = calendar.monthrange(year, month)[1]
    runs = list_runs(year=year, month=month, limit=8000)
    by_day: dict[str, dict[str, Any]] = {}
    for r in runs:
        cd = str(r.get("compliance_day") or "")
        if not cd:
            continue
        by_day[cd] = {
            "compliance_day": cd,
            "id": r.get("id"),
            "created_at": r.get("created_at"),
            "n_intervals": r.get("n_intervals"),
            "compliance_rows_in_window": r.get("compliance_rows_in_window"),
        }
    missing_dates: list[str] = []
    rows: list[dict[str, Any]] = []
    for d in range(1, last_day + 1):
        iso = date(year, month, d).isoformat()
        if iso in by_day:
            info = by_day[iso]
            rows.append(
                {
                    "date": iso,
                    "has_data": True,
                    "saved_run_id": info.get("id"),
                    "created_at": info.get("created_at"),
                    "n_intervals": info.get("n_intervals"),
                    "compliance_rows_in_window": info.get("compliance_rows_in_window"),
                }
            )
        else:
            missing_dates.append(iso)
            rows.append({"date": iso, "has_data": False})
    return {
        "year": year,
        "month": month,
        "label": f"{calendar.month_name[month]} {year}",
        "calendar_days": last_day,
        "days_with_saved": len(by_day),
        "days_missing": len(missing_dates),
        "missing_dates": missing_dates,
        "rows": rows,
    }


def calendar_annual_rollup(limit_all: int = 50000) -> dict[str, Any]:
    """One summary row per **calendar year** present in the database (by ``compliance_day``)."""
    runs = list_runs(
        year=None,
        month=None,
        billing_period_year=None,
        billing_period_month=None,
        limit=limit_all,
    )
    by_year: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        cd = str(r.get("compliance_day") or "")
        if len(cd) < 4:
            continue
        try:
            y = int(cd[:4])
        except ValueError:
            continue
        by_year[y].append(r)

    years_out: list[dict[str, Any]] = []
    for y in sorted(by_year.keys()):
        chunk = by_year[y]
        years_out.append(
            {
                "year": y,
                "label": str(y),
                "stats": aggregate_run_stats(chunk),
            }
        )
    return {"years": years_out}
