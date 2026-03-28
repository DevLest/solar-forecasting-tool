"""Persist billing Input/Display data extracted from PDFs (SQLite)."""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any

from app.config import DATA_DIR

_DB_PATH = os.path.join(DATA_DIR, "billing_history.sqlite3")

_INPUT_KEYS = [
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "aa",
    "ab",
    "ac",
    "ad",
]

# Input column AD is ``=SUM(R:AC)`` (or ``R:AB`` on some template rows) per Excel; purchase line items are R–AC.
_PURCHASE_COMPONENT_KEYS = (
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "aa",
    "ab",
    "ac",
)


def _conn() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    c = sqlite3.connect(_DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_billing_history_db() -> None:
    with _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS billing_input_row (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              year INTEGER NOT NULL,
              billing_month TEXT NOT NULL,
              statement_ref TEXT NOT NULL,
              amounts_json TEXT NOT NULL,
              status_sales TEXT NOT NULL DEFAULT 'For Follow-Up',
              remarks_sales TEXT NOT NULL DEFAULT '',
              status_purchases TEXT NOT NULL DEFAULT 'For Follow-Up',
              remarks_purchases TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL,
              UNIQUE(year, billing_month, statement_ref)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS billing_upload (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              row_id INTEGER NOT NULL,
              filename TEXT NOT NULL,
              detected_kind TEXT NOT NULL,
              meta_json TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(row_id) REFERENCES billing_input_row(id) ON DELETE CASCADE
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_billing_upload_row ON billing_upload(row_id)")


def _empty_amounts() -> dict[str, Any]:
    return {k: None for k in _INPUT_KEYS}


def _row_to_amounts(row: sqlite3.Row) -> dict[str, Any]:
    base = _empty_amounts()
    data = json.loads(row["amounts_json"] or "{}")
    for k in _INPUT_KEYS:
        if k in data:
            base[k] = data[k]
    return base


def _sum_sales_block(am: dict[str, Any]) -> float | None:
    keys = ["e", "f", "g", "h", "i", "j", "k", "l", "m"]
    vals = [am[k] for k in keys if am.get(k) is not None]
    if not vals:
        return None
    return float(sum(float(x) for x in vals))


def upsert_input_row(
    *,
    year: int,
    billing_month: str,
    statement_ref: str,
    patch: dict[str, Any],
    replace_all: bool = False,
) -> tuple[int, dict[str, Any]]:
    """Merge ``patch`` into stored amounts (numeric keys e..ad). Returns (id, full amounts)."""
    bm = (billing_month or "").strip()
    st = (statement_ref or "").strip()
    if st.lower() == "prelim":
        st = "Prelim"
    elif st.lower() == "final":
        st = "Final"
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        cur = c.execute(
            "SELECT id, amounts_json FROM billing_input_row WHERE year=? AND billing_month=? AND statement_ref=?",
            (year, bm, st),
        )
        existing = cur.fetchone()
        if existing:
            rid = int(existing["id"])
            am = _empty_amounts()
            if not replace_all:
                am.update(json.loads(existing["amounts_json"] or "{}"))
        else:
            rid = None
            am = _empty_amounts()
        for k, v in patch.items():
            lk = str(k).lower()
            if lk in _INPUT_KEYS and isinstance(v, (int, float)):
                am[lk] = float(v)
        nsum = _sum_sales_block(am)
        if nsum is not None:
            am["n"] = nsum
        if rid is not None:
            c.execute(
                "UPDATE billing_input_row SET amounts_json=?, updated_at=? WHERE id=?",
                (json.dumps(am), now, rid),
            )
        else:
            c.execute(
                """
                INSERT INTO billing_input_row
                  (year, billing_month, statement_ref, amounts_json, updated_at)
                VALUES (?,?,?,?,?)
                """,
                (year, bm, st, json.dumps(am), now),
            )
            rid = int(c.execute("SELECT last_insert_rowid()").fetchone()[0])
        return rid, am


def fetch_input_row(row_id: int) -> dict[str, Any] | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM billing_input_row WHERE id=?", (row_id,)).fetchone()
    if not row:
        return None
    return _serialize_row(row, _row_to_amounts(row))


def list_input_rows(
    *,
    year: int | None = None,
    billing_month: str | None = None,
    statement_ref: str | None = None,
) -> list[dict[str, Any]]:
    q = "SELECT * FROM billing_input_row WHERE 1=1"
    args: list[Any] = []
    if year is not None:
        q += " AND year=?"
        args.append(year)
    if billing_month:
        q += " AND billing_month=?"
        args.append(billing_month.strip())
    if statement_ref:
        sr = statement_ref.strip()
        if sr.lower() == "prelim":
            sr = "Prelim"
        elif sr.lower() == "final":
            sr = "Final"
        q += " AND statement_ref=?"
        args.append(sr)
    q += " ORDER BY year DESC, billing_month DESC, statement_ref DESC"
    with _conn() as c:
        rows = c.execute(q, args).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        am = _row_to_amounts(row)
        out.append(_serialize_row(row, am))
    return out


def _serialize_row(row: sqlite3.Row, am: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "year": int(row["year"]),
        "billing_month": row["billing_month"],
        "statement_ref": row["statement_ref"],
        "amounts": am,
        "status_sales": row["status_sales"],
        "remarks_sales": row["remarks_sales"],
        "status_purchases": row["status_purchases"],
        "remarks_purchases": row["remarks_purchases"],
        "updated_at": row["updated_at"],
    }


def update_row_status(
    row_id: int,
    *,
    status_sales: str | None = None,
    status_purchases: str | None = None,
    remarks_sales: str | None = None,
    remarks_purchases: str | None = None,
) -> dict[str, Any] | None:
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        cur = c.execute("SELECT * FROM billing_input_row WHERE id=?", (row_id,))
        row = cur.fetchone()
        if not row:
            return None
        ss = status_sales if status_sales is not None else row["status_sales"]
        sp = status_purchases if status_purchases is not None else row["status_purchases"]
        rs = remarks_sales if remarks_sales is not None else row["remarks_sales"]
        rp = remarks_purchases if remarks_purchases is not None else row["remarks_purchases"]
        c.execute(
            """
            UPDATE billing_input_row
            SET status_sales=?, status_purchases=?, remarks_sales=?, remarks_purchases=?, updated_at=?
            WHERE id=?
            """,
            (ss, sp, rs, rp, now, row_id),
        )
        cur2 = c.execute("SELECT * FROM billing_input_row WHERE id=?", (row_id,))
        row2 = cur2.fetchone()
    am = _row_to_amounts(row2)
    return _serialize_row(row2, am)


def update_row_amounts(row_id: int, amounts: dict[str, Any]) -> dict[str, Any] | None:
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        cur = c.execute("SELECT * FROM billing_input_row WHERE id=?", (row_id,))
        row = cur.fetchone()
        if not row:
            return None
        am = _row_to_amounts(row)
        for k, v in amounts.items():
            lk = str(k).lower()
            if lk in _INPUT_KEYS:
                if v is None or v == "":
                    am[lk] = None
                else:
                    am[lk] = float(v)
        nsum = _sum_sales_block(am)
        if nsum is not None:
            am["n"] = nsum
        c.execute(
            "UPDATE billing_input_row SET amounts_json=?, updated_at=? WHERE id=?",
            (json.dumps(am), now, row_id),
        )
        row2 = c.execute("SELECT * FROM billing_input_row WHERE id=?", (row_id,)).fetchone()
    return _serialize_row(row2, _row_to_amounts(row2))


def delete_row(row_id: int) -> bool:
    with _conn() as c:
        c.execute("DELETE FROM billing_input_row WHERE id=?", (row_id,))
        return c.total_changes > 0


def record_upload(row_id: int, filename: str, detected_kind: str, meta: dict[str, Any] | None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        c.execute(
            """
            INSERT INTO billing_upload (row_id, filename, detected_kind, meta_json, created_at)
            VALUES (?,?,?,?,?)
            """,
            (row_id, filename, detected_kind, json.dumps(meta or {}), now),
        )


def compute_display_totals(rows: list[dict[str, Any]]) -> dict[str, float]:
    """
    Sums Input columns across ``rows`` (already filtered) — mirrors Display SUMIFS totals.
    """
    totals: dict[str, float] = {}
    keys = _INPUT_KEYS
    for r in rows:
        am = r.get("amounts") or {}
        for k in keys:
            v = am.get(k)
            if v is None:
                continue
            totals[k] = totals.get(k, 0.0) + float(v)
    return totals


def display_layout(totals: dict[str, float]) -> dict[str, Any]:
    """
    Mirrors ``Display`` sheet logic from ``Areco billing 2025 - EDITED.xlsx``.

    - **Total Receivable from IEMOP** (Display ``B16``) = ``B7+B8+B10+B11+B12+B13+B15``
      i.e. Input ``E+F+H+I+J+K+M`` (same line items as SUMIFS on those columns; excludes ``G``, ``L``).
    - **Total Payable to IEMOP** (Display ``E23``) = ``SUMIFS(Input!AD:AD,…)``. On Input, **AD** is
      ``=SUM(R:AC)`` per row. PDF extraction fills **R–AC** but often leaves **AD** unset, so the
      rolled-up **ad** total can be 0; then use the sum of **R–AC** (same net as Excel when AD is
      maintained).
    """

    def g(k: str) -> float:
        return float(totals.get(k) or 0.0)

    sales = {
        "vatable_g01": g("e"),
        "non_vatable_g01": g("f"),
        "vatable_l01": g("h"),
        "non_vatable_l01": g("i"),
        "vat_on_g01": g("j"),
        "vat_on_l01": g("k"),
        "ewt": g("m"),
    }
    purch = {
        "vatable_g01": g("r"),
        "non_vatable_g01": g("s"),
        "vatable_l01": g("u"),
        "non_vatable_l01": g("v"),
        "vat_on_g01": g("w"),
        "vat_on_l01": g("x"),
        "ewt": g("z"),
        "market_fee_1": g("aa"),
        "market_fee_2": g("ab"),
        "market_fee_3": g("ac"),
        "total_payable": g("ad"),
    }
    # Display B16 — components B7,B8,B10,B11,B12,B13,B15 only (not G/L, not Input N unless N matches this sum).
    total_receivable_from_iemop = (
        g("e") + g("f") + g("h") + g("i") + g("j") + g("k") + g("m")
    )
    # Display E23 — SUMIFS(AD). Fallback: sum R–AC when stored AD totals to 0 (see docstring).
    ad_roll = g("ad")
    purchase_components_sum = sum(g(k) for k in _PURCHASE_COMPONENT_KEYS)
    total_payable_to_iemop = (
        ad_roll if abs(ad_roll) > 1e-9 else purchase_components_sum
    )
    purch["total_payable"] = total_payable_to_iemop
    return {
        "sales": sales,
        "purchases": purch,
        "total_receivable_from_iemop": total_receivable_from_iemop,
        "total_payable_to_iemop": total_payable_to_iemop,
        "raw": totals,
    }
