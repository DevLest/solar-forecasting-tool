"""SQLite persistence: one row per trade day (upsert), billing period 26th–25th."""
from __future__ import annotations

import calendar
import json
import os
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.config import DATA_DIR
from app.services.nomination_accuracy_dates import (
    aggregate_run_stats,
    aggregate_run_stats_for_billing_window,
    billing_end_year_from_run,
    billing_period_containing,
    billing_period_for_end_month,
    billing_period_label,
    billing_year_trade_day_span,
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
    if "policy_json" not in cols:
        conn.execute("ALTER TABLE nomination_accuracy_run ADD COLUMN policy_json TEXT")

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

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS nomination_compliance_csv (
          compliance_day TEXT PRIMARY KEY,
          csv_blob BLOB NOT NULL,
          source_filename TEXT,
          uploaded_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ncc_uploaded ON nomination_compliance_csv(uploaded_at)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS nomination_market_result_csv (
          compliance_day TEXT PRIMARY KEY,
          csv_blob BLOB NOT NULL,
          source_filename TEXT,
          uploaded_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nmrc_uploaded ON nomination_market_result_csv(uploaded_at)"
    )

    # MIRF Daily MQ workbooks uploaded via Nomination Accuracy backfill (xlsx/xlsm).
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS nomination_mirf_mq_xlsx (
          compliance_day TEXT PRIMARY KEY,
          xlsx_blob BLOB NOT NULL,
          source_filename TEXT,
          uploaded_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nmmq_uploaded ON nomination_mirf_mq_xlsx(uploaded_at)"
    )


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
    policy_obj = row.get("policy")
    policy_json = (
        json.dumps(policy_obj, separators=(",", ":"))
        if policy_obj is not None
        else None
    )

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
              analytics_json, billing_period_start, billing_period_end, policy_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              billing_period_end = excluded.billing_period_end,
              policy_json = excluded.policy_json
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
                policy_json,
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


def delete_run(run_id: int) -> bool:
    """Remove a saved run by primary key. Returns True if a row was deleted."""
    init_nomination_accuracy_db()
    if run_id < 1:
        return False
    with sqlite3.connect(db_path()) as conn:
        cur = conn.execute("DELETE FROM nomination_accuracy_run WHERE id = ?", (run_id,))
        conn.commit()
        return cur.rowcount > 0


def list_uploaded_compliance_days() -> list[str]:
    """All distinct trade dates (ISO) that have a saved run, sorted ascending."""
    init_nomination_accuracy_db()
    with sqlite3.connect(db_path()) as conn:
        cur = conn.execute(
            "SELECT compliance_day FROM nomination_accuracy_run ORDER BY compliance_day ASC"
        )
        return [str(r[0]) for r in cur.fetchall() if r[0]]


def save_compliance_csv_blob(
    compliance_day_iso: str,
    csv_bytes: bytes,
    source_filename: str,
) -> tuple[bool, bool]:
    """
    Upsert raw MPI compliance CSV for a trade day.
    Returns ``(success, overwritten)``.
    """
    init_nomination_accuracy_db()
    trade_iso = str(compliance_day_iso).strip()
    created = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(db_path()) as conn:
        prev = conn.execute(
            "SELECT 1 FROM nomination_compliance_csv WHERE compliance_day = ?",
            (trade_iso,),
        ).fetchone()
        overwritten = prev is not None
        conn.execute(
            """
            INSERT INTO nomination_compliance_csv (compliance_day, csv_blob, source_filename, uploaded_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(compliance_day) DO UPDATE SET
              csv_blob = excluded.csv_blob,
              source_filename = excluded.source_filename,
              uploaded_at = excluded.uploaded_at
            """,
            (trade_iso, csv_bytes, source_filename or None, created),
        )
        conn.commit()
        return True, overwritten


def get_compliance_csv_blob(compliance_day_iso: str) -> tuple[bytes | None, str | None]:
    """Return ``(csv_bytes, source_filename)`` for a trade day, or ``(None, None)`` if missing."""
    init_nomination_accuracy_db()
    iso = str(compliance_day_iso).strip()
    with sqlite3.connect(db_path()) as conn:
        r = conn.execute(
            "SELECT csv_blob, source_filename FROM nomination_compliance_csv WHERE compliance_day = ?",
            (iso,),
        ).fetchone()
        if not r or r[0] is None:
            return None, None
        return bytes(r[0]), (str(r[1]) if r[1] else None)


def list_stored_compliance_csv_days() -> list[str]:
    """ISO trade dates with a stored MPI compliance CSV, ascending."""
    init_nomination_accuracy_db()
    with sqlite3.connect(db_path()) as conn:
        cur = conn.execute(
            "SELECT compliance_day FROM nomination_compliance_csv ORDER BY compliance_day ASC"
        )
        return [str(r[0]) for r in cur.fetchall() if r[0]]


def save_market_result_csv_blob(
    compliance_day_iso: str,
    csv_bytes: bytes,
    source_filename: str,
) -> tuple[bool, bool]:
    init_nomination_accuracy_db()
    trade_iso = str(compliance_day_iso).strip()
    created = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(db_path()) as conn:
        prev = conn.execute(
            "SELECT 1 FROM nomination_market_result_csv WHERE compliance_day = ?",
            (trade_iso,),
        ).fetchone()
        overwritten = prev is not None
        conn.execute(
            """
            INSERT INTO nomination_market_result_csv (compliance_day, csv_blob, source_filename, uploaded_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(compliance_day) DO UPDATE SET
              csv_blob = excluded.csv_blob,
              source_filename = excluded.source_filename,
              uploaded_at = excluded.uploaded_at
            """,
            (trade_iso, csv_bytes, source_filename or None, created),
        )
        conn.commit()
        return True, overwritten


def save_mirf_mq_xlsx_blob(
    compliance_day_iso: str,
    xlsx_bytes: bytes,
    source_filename: str,
) -> tuple[bool, bool]:
    """
    Upsert raw MIRF Daily MQ workbook bytes (xlsx/xlsm) for a trade day.
    Used as a day-ahead schedule source when Market Result CSV is not available.
    Returns ``(success, overwritten)``.
    """
    init_nomination_accuracy_db()
    trade_iso = str(compliance_day_iso).strip()
    created = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(db_path()) as conn:
        prev = conn.execute(
            "SELECT 1 FROM nomination_mirf_mq_xlsx WHERE compliance_day = ?",
            (trade_iso,),
        ).fetchone()
        overwritten = prev is not None
        conn.execute(
            """
            INSERT INTO nomination_mirf_mq_xlsx (compliance_day, xlsx_blob, source_filename, uploaded_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(compliance_day) DO UPDATE SET
              xlsx_blob = excluded.xlsx_blob,
              source_filename = excluded.source_filename,
              uploaded_at = excluded.uploaded_at
            """,
            (trade_iso, xlsx_bytes, source_filename or None, created),
        )
        conn.commit()
        return True, overwritten


def get_mirf_mq_xlsx_blob(compliance_day_iso: str) -> tuple[bytes | None, str | None]:
    """Return ``(xlsx_bytes, source_filename)`` for a trade day, or ``(None, None)`` if missing."""
    init_nomination_accuracy_db()
    iso = str(compliance_day_iso).strip()
    with sqlite3.connect(db_path()) as conn:
        r = conn.execute(
            "SELECT xlsx_blob, source_filename FROM nomination_mirf_mq_xlsx WHERE compliance_day = ?",
            (iso,),
        ).fetchone()
        if not r or r[0] is None:
            return None, None
        return bytes(r[0]), (str(r[1]) if r[1] else None)


def list_stored_mirf_mq_days() -> list[str]:
    """ISO trade dates with a stored MIRF MQ workbook, ascending."""
    init_nomination_accuracy_db()
    with sqlite3.connect(db_path()) as conn:
        cur = conn.execute(
            "SELECT compliance_day FROM nomination_mirf_mq_xlsx ORDER BY compliance_day ASC"
        )
        return [str(r[0]) for r in cur.fetchall() if r[0]]


def get_market_result_csv_blob(compliance_day_iso: str) -> tuple[bytes | None, str | None]:
    init_nomination_accuracy_db()
    iso = str(compliance_day_iso).strip()
    with sqlite3.connect(db_path()) as conn:
        r = conn.execute(
            "SELECT csv_blob, source_filename FROM nomination_market_result_csv WHERE compliance_day = ?",
            (iso,),
        ).fetchone()
        if not r or r[0] is None:
            return None, None
        return bytes(r[0]), (str(r[1]) if r[1] else None)


def list_stored_market_result_days() -> list[str]:
    init_nomination_accuracy_db()
    with sqlite3.connect(db_path()) as conn:
        cur = conn.execute(
            "SELECT compliance_day FROM nomination_market_result_csv ORDER BY compliance_day ASC"
        )
        return [str(r[0]) for r in cur.fetchall() if r[0]]


def compliance_day_exists(iso_day: str) -> bool:
    init_nomination_accuracy_db()
    with sqlite3.connect(db_path()) as conn:
        r = conn.execute(
            "SELECT 1 FROM nomination_accuracy_run WHERE compliance_day = ? LIMIT 1",
            (iso_day,),
        ).fetchone()
        return r is not None


def list_runs(
    year: int | None = None,
    month: int | None = None,
    billing_period_year: int | None = None,
    billing_period_month: int | None = None,
    trade_day_min: str | None = None,
    trade_day_max: str | None = None,
    limit: int = 500,
    include_analytics: bool = False,
) -> list[dict[str, Any]]:
    init_nomination_accuracy_db()
    conditions: list[str] = []
    params: list[Any] = []

    if trade_day_min is not None and trade_day_max is not None:
        conditions.append("compliance_day >= ? AND compliance_day <= ?")
        params.extend([str(trade_day_min), str(trade_day_max)])

    if billing_period_year is not None and billing_period_month is not None:
        p0, p1 = billing_period_for_end_month(billing_period_year, billing_period_month)
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
    base_cols = """
        id, created_at, compliance_day, mape, perc95, max_mq_mw, n_intervals,
        compliance_rows_in_window, mq_sheet, mape_ok, perc95_ok, day_compliant,
        billing_period_start, billing_period_end, policy_json
        """
    extra = ", analytics_json" if include_analytics else ""
    q = f"""
        SELECT {base_cols}{extra}
        FROM nomination_accuracy_run{where}
        ORDER BY compliance_day DESC, id DESC
        LIMIT ?
        """
    params.append(int(limit))
    with sqlite3.connect(db_path()) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(q, params)
        out: list[dict[str, Any]] = []
        for r in cur.fetchall():
            row = dict(r)
            pj = row.pop("policy_json", None)
            if pj:
                try:
                    row["policy"] = json.loads(pj)
                except (json.JSONDecodeError, TypeError):
                    row["policy"] = None
            else:
                row["policy"] = None
            if include_analytics:
                aj = row.pop("analytics_json", None)
                if aj:
                    try:
                        row["analytics"] = json.loads(aj)
                    except (json.JSONDecodeError, TypeError):
                        row["analytics"] = None
                else:
                    row["analytics"] = None
            out.append(row)
        return out


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
        p0, p1 = billing_period_for_end_month(billing_period_year, billing_period_month)
        out["billing_period"] = {
            "start": p0.isoformat(),
            "end": p1.isoformat(),
            "label": billing_period_label(p0, p1),
        }
        out["stats"] = aggregate_run_stats_for_billing_window(runs, p0, p1)
    return out


def calendar_monthly_rollup(year: int, limit_per_year: int = 8000) -> dict[str, Any]:
    """
    Roll up saved runs by **billing period** (26th–25th, same as ``save_run``), for periods
    whose **end date** falls in ``year`` (month label = month of the 25th end date).

    Always returns 12 rows (Jan–Dec). Stats use the full billing window each month (trade-day
    count); compliance % treats missing days as not compliant. MAPE/PERC95 averages use saved rows
    only.
    """
    if year < 1990 or year > 2100:
        raise ValueError("year out of range")
    months: list[dict[str, Any]] = []
    all_in_year: list[dict[str, Any]] = []
    for m in range(1, 13):
        chunk = list_runs(
            billing_period_year=year,
            billing_period_month=m,
            limit=limit_per_year,
            include_analytics=True,
        )
        all_in_year.extend(chunk)
        p0, p1 = billing_period_for_end_month(year, m)
        st = aggregate_run_stats_for_billing_window(chunk, p0, p1)
        months.append(
            {
                "month": m,
                "label": calendar.month_name[m],
                "key": f"{year:04d}-{m:02d}",
                "stats": st,
            }
        )
    y0, y1 = billing_year_trade_day_span(year)
    return {
        "year": year,
        "months": months,
        "year_totals": aggregate_run_stats_for_billing_window(all_in_year, y0, y1),
    }


def calendar_month_detail(year: int, month: int) -> dict[str, Any]:
    """
    Per trade day in the billing period that **ends** in ``year``-``month`` (26th prior month
    through 25th of ``month``, inclusive) — same window as ``save_run`` / ``billing_period_*``.

    One saved row per ``compliance_day`` (re-uploads replace the same day).
    """
    if year < 1990 or year > 2100:
        raise ValueError("year out of range")
    if month < 1 or month > 12:
        raise ValueError("month must be 1–12")
    init_nomination_accuracy_db()
    p0, p1 = billing_period_for_end_month(year, month)
    period_days = (p1 - p0).days + 1
    runs = list_runs(
        billing_period_year=year,
        billing_period_month=month,
        limit=8000,
        include_analytics=True,
    )
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
            "mape": r.get("mape"),
            "perc95": r.get("perc95"),
            "day_compliant": bool(r.get("day_compliant")),
            "mq_sheet": r.get("mq_sheet"),
            "policy": r.get("policy"),
        }
    period_stats = aggregate_run_stats_for_billing_window(runs, p0, p1)
    missing_dates: list[str] = []
    rows: list[dict[str, Any]] = []
    d = p0
    while d <= p1:
        iso = d.isoformat()
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
                    "mape": info.get("mape"),
                    "perc95": info.get("perc95"),
                    "day_compliant": info.get("day_compliant"),
                    "mq_sheet": info.get("mq_sheet"),
                    "policy": info.get("policy"),
                }
            )
        else:
            missing_dates.append(iso)
            rows.append({"date": iso, "has_data": False})
        d += timedelta(days=1)
    return {
        "year": year,
        "month": month,
        "label": f"{calendar.month_name[month]} {year}",
        "billing_period": {"start": p0.isoformat(), "end": p1.isoformat()},
        "calendar_days": period_days,
        "days_in_period": period_days,
        "days_with_saved": len(by_day),
        "days_missing": len(missing_dates),
        "missing_dates": missing_dates,
        "rows": rows,
        "billing_period_stats": period_stats,
    }


def calendar_annual_rollup(limit_all: int = 50000) -> dict[str, Any]:
    """
    One summary row per **billing year** (year of the period end on the 25th), same labeling as
    monthly rollups. Stats use the full trade-day span for that year; missing days count as not
    compliant for compliance %.
    """
    runs = list_runs(
        year=None,
        month=None,
        billing_period_year=None,
        billing_period_month=None,
        limit=limit_all,
    )
    by_year: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        y = billing_end_year_from_run(r)
        if y is None:
            continue
        by_year[y].append(r)

    years_out: list[dict[str, Any]] = []
    for y in sorted(by_year.keys()):
        p0, p1 = billing_year_trade_day_span(y)
        chunk = list_runs(
            trade_day_min=p0.isoformat(),
            trade_day_max=p1.isoformat(),
            limit=limit_all,
            include_analytics=True,
        )
        years_out.append(
            {
                "year": y,
                "label": str(y),
                "stats": aggregate_run_stats_for_billing_window(chunk, p0, p1),
            }
        )
    return {"years": years_out}
