"""Parse IEMOP ARECO billing PDFs into Input-sheet column amounts (subset filled per document type)."""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any

from pypdf import PdfReader


def _norm_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _parse_money_token(raw: str) -> float | None:
    s = (raw or "").strip()
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1]
    s = s.replace(",", "")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def _extract_pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        parts.append(t)
    return "\n".join(parts)


def _kind_from_filename(name: str) -> str:
    n = (name or "").upper()
    if "SUPPLEMENTAL" in n:
        return "emf_supplemental"
    if "IEMMS" in n:
        return "emf_iemms"
    if "REGULAR" in n or "EMF_REGULAR" in n:
        return "emf_regular"
    if "WTA" in n or "TS-WF" in n:
        return "wta"
    return "unknown"


def parse_emf_market_fee(text: str) -> dict[str, Any]:
    """
    ARECO_236_FS_EMF_*.pdf — Market Fees one-pager.
    Maps REGULAR -> aa, IEMMS -> ab, SUPPLEMENTAL -> ac (amounts negative = payable).
    """
    t = text
    out: dict[str, Any] = {"kind": "emf"}
    m_amt = re.search(r"Amount\s*\n\s*\(([\d,\.]+)\)", t, re.IGNORECASE | re.MULTILINE)
    if m_amt:
        v = _parse_money_token("(" + m_amt.group(1) + ")")
        if v is not None:
            out["amount_parentheses"] = v
    m_net = re.search(
        r"NET SETTLEMENT AMOUNT\s+[\d,\.]+\s*MWh\s*\(([\d,\.]+)\)",
        t,
        re.IGNORECASE,
    )
    if m_net:
        v = _parse_money_token("(" + m_net.group(1) + ")")
        if v is not None:
            out["net_settlement_amount"] = v
    m_bp = re.search(
        r"Billing Period\s*\n\s*([A-Za-z]+\s+\d+\s*-\s*[A-Za-z]+\s+\d+,\s*\d{4})",
        t,
        re.IGNORECASE,
    )
    if not m_bp:
        m_bp = re.search(r"([A-Za-z]{3}\s+\d{1,2}\s*-\s*[A-Za-z]{3}\s+\d{1,2},\s*\d{4})", t)
    if m_bp:
        out["billing_period_text"] = m_bp.group(1).strip()
    st = "Final" if re.search(r"\bFinal Statement\b", t, re.IGNORECASE) else None
    if st:
        out["statement"] = st
    return out


def _lines_after_summary(text: str) -> list[str]:
    """Split text into non-empty stripped lines for WTA first-page parsing."""
    lines = [ln.strip() for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    return lines


def _find_wta_summary_numbers(full_text: str, _lines: list[str], for_arecoss: bool) -> dict[str, float]:
    """Parse WESM COVER SUMMARY block after ``Net Sale / Purchase`` (ARECO / ARECOSS)."""
    out: dict[str, float] = {}
    text = full_text
    m_block = re.search(
        r"Net Sale / Purchase\s+"
        r"([\d,\.]+)\s+"
        r"([\d,\.]+)\s+"
        r"([\d,\.]+)\s+"
        r"([\d,\.]+)\s*\(([\d,\.]+)\)\s*"
        r"\(([\d,\.]+)\)\s+"
        r"([\d,\.]+)",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    if m_block:
        g = [m_block.group(i) for i in range(1, 8)]
        out["vatable_sales"] = float(g[0].replace(",", ""))
        out["zero_rated_sales"] = float(g[1].replace(",", ""))
        out["eco_sales"] = float(g[2].replace(",", ""))
        out["net_or_combo_sales"] = float(g[3].replace(",", ""))
        out["purchase_in_net_line"] = -float(g[4].replace(",", ""))
        out["purchase_second_paren"] = -float(g[5].replace(",", ""))
        out["tail_after_purchases"] = float(g[6].replace(",", ""))
    m_ewt = re.search(r"EWT,?\s*Php\s+(\(?[\d,\.]+\)?)\s+(\(?[\d,\.]+\)?)", text, re.IGNORECASE)
    if m_ewt:
        e1 = _parse_money_token(m_ewt.group(1))
        e2 = _parse_money_token(m_ewt.group(2))
        if e1 is not None:
            out["ewt_sales"] = e1
        if e2 is not None:
            out["ewt_purchases"] = e2
    return out


def parse_wta_cover(text: str) -> tuple[str, dict[str, Any]]:
    """Returns ('areco'|'arecoss', patch dict for Input columns e..ad)."""
    t = text
    is_ss = bool(re.search(r"ARECOSS|For the Account of ARECOSS", t, re.IGNORECASE))
    kind = "arecoss" if is_ss else "areco"
    sm = _find_wta_summary_numbers(t, _lines_after_summary(t), is_ss)
    patch: dict[str, Any] = {"kind": "wta", "wta_branch": kind}
    if not sm:
        return kind, patch
    if not is_ss:
        e = sm.get("vatable_sales")
        zr = sm.get("zero_rated_sales")
        eco = sm.get("eco_sales")
        if e is not None:
            patch["e"] = e
        if zr is not None and eco is not None:
            patch["f"] = zr + eco
        elif zr is not None:
            patch["f"] = zr
        pn = sm.get("purchase_in_net_line")
        if pn is not None:
            patch["s"] = pn
        ew = sm.get("ewt_sales")
        if ew is not None:
            patch["m"] = ew
    else:
        hv = sm.get("vatable_sales")
        zr = sm.get("zero_rated_sales")
        eco = sm.get("eco_sales")
        if hv is not None:
            patch["h"] = hv
        if zr is not None and eco is not None:
            patch["i"] = zr + eco
        elif zr is not None:
            patch["i"] = zr
        pn = sm.get("purchase_in_net_line")
        if pn is not None:
            patch["v"] = pn
        ew = sm.get("ewt_sales")
        if ew is not None:
            patch["z"] = ew
    return kind, patch


@dataclass
class ExtractResult:
    filename: str
    detected_kind: str
    input_patch: dict[str, float | str | None] = field(default_factory=dict)
    raw_meta: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def extract_invoice_pdf(filename: str, data: bytes) -> ExtractResult:
    """Dispatch parser from filename + content."""
    if not data:
        return ExtractResult(filename, "empty", warnings=["Empty file"])
    text = _extract_pdf_text(data)
    low = (filename or "").lower()
    fk = _kind_from_filename(filename)

    if fk == "wta" or "wesm transaction" in text.lower():
        branch, patch = parse_wta_cover(text)
        ir: dict[str, Any] = {}
        for k, v in patch.items():
            if k in ("kind", "wta_branch"):
                continue
            if isinstance(v, (int, float)):
                ir[str(k).lower()] = float(v)
        meta = {k: v for k, v in patch.items() if k in ("kind", "wta_branch")}
        return ExtractResult(
            filename,
            f"wta_{branch}",
            input_patch=ir,
            raw_meta=meta,
        )

    if "market fees" in text.lower() and "net settlement amount" in text.lower():
        emf = parse_emf_market_fee(text)
        ir: dict[str, Any] = {}
        amt = emf.get("net_settlement_amount")
        if amt is None:
            amt = emf.get("amount_parentheses")
        if amt is not None:
            if "regular" in low or fk == "emf_regular":
                ir["aa"] = float(amt)
            elif "iemms" in low or fk == "emf_iemms":
                ir["ab"] = float(amt)
            elif "supplemental" in low or fk == "emf_supplemental":
                ir["ac"] = float(amt)
            else:
                ir["aa"] = float(amt)
        return ExtractResult(
            filename,
            fk,
            input_patch=ir,
            raw_meta=emf,
        )

    return ExtractResult(filename, fk, warnings=["Could not classify PDF; no amounts extracted."])


def merge_input_patches(patches: list[dict[str, float]]) -> dict[str, float]:
    """Later files override overlapping keys."""
    out: dict[str, float] = {}
    for p in patches:
        for k, v in p.items():
            if isinstance(v, (int, float)):
                out[k.lower()] = float(v)
    return out
