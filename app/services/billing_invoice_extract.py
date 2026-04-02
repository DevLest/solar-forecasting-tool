"""Parse IEMOP ARECO billing PDFs into Input-sheet column amounts (subset filled per document type)."""
from __future__ import annotations

import io
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from pypdf import PdfReader

# Lazy singleton for scanned Final MF PDFs (image-only); avoids reloading ONNX models per upload batch.
_rapid_ocr_engine = None


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


def _extract_pdf_text_ocr_rapidocr(data: bytes) -> str | None:
    """RapidOCR + OpenCV (good accuracy; requires Python < 3.13 for many rapidocr builds)."""
    global _rapid_ocr_engine
    try:
        import cv2
        import numpy as np
        from rapidocr_onnxruntime import RapidOCR
        import fitz
    except ImportError:
        return None
    doc = fitz.open(stream=data, filetype="pdf")
    out_parts: list[str] = []
    try:
        if _rapid_ocr_engine is None:
            _rapid_ocr_engine = RapidOCR()
        ocr_engine = _rapid_ocr_engine
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
            img_bytes = pix.tobytes("png")
            img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                continue
            result, _ = ocr_engine(img)
            if not result:
                continue
            out_parts.append("\n".join(line[1] for line in result))
        s = "\n".join(out_parts).strip()
        return s if s else None
    finally:
        doc.close()


def _extract_pdf_text_ocr_tesseract(data: bytes) -> str | None:
    """Fallback: PyMuPDF render + Tesseract (install Tesseract and add to PATH, or set TESSDATA_PREFIX)."""
    try:
        import fitz
        import pytesseract
        from PIL import Image
    except ImportError:
        return None
    doc = fitz.open(stream=data, filetype="pdf")
    out_parts: list[str] = []
    try:
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            out_parts.append(pytesseract.image_to_string(img))
        s = "\n".join(out_parts).strip()
        return s if s else None
    except Exception:
        return None
    finally:
        doc.close()


def _extract_pdf_text_ocr_fitz(data: bytes) -> str | None:
    """Render pages and OCR scanned Final TS-WF market fee PDFs (no text layer)."""
    if os.environ.get("ARECO_DISABLE_PDF_OCR", "").strip().lower() in ("1", "true", "yes"):
        return None
    for fn in (_extract_pdf_text_ocr_rapidocr, _extract_pdf_text_ocr_tesseract):
        try:
            t = fn(data)
        except Exception:
            t = None
        if t and t.strip():
            return t.strip()
    return None


def _extract_pdf_text(data: bytes) -> tuple[str, bool]:
    """Return ``(text, used_ocr)``. Tries OCR when the PDF has no selectable text layer."""
    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        parts.append(t)
    raw = "\n".join(parts)
    if (raw or "").strip():
        return raw, False
    ocr_text = _extract_pdf_text_ocr_fitz(data)
    if ocr_text:
        return ocr_text, True
    return raw, False


def _kind_from_filename(name: str) -> str:
    """Guess invoice kind from file name (IEMOP names vary; content parsing still applies)."""
    n = (name or "").upper()
    # Final statements use TS-WF-*_MF1.pdf / *_MF.pdf for market fees — classify those before any WTA rule.
    if "SUPPLEMENTAL" in n:
        return "emf_supplemental"
    if "IEMMS" in n:
        return "emf_iemms"
    if "MF1" in n:
        return "emf_iemms"
    if n.endswith("_MF.PDF"):
        return "emf_supplemental"
    if "REGULAR" in n or "EMF_REGULAR" in n:
        return "emf_regular"
    if "EMF" in n or "PS_EMF" in n or "FS_EMF" in n:
        return "emf_regular"
    # WTA covers are named …_WTA.pdf (TS-WF in the path is not enough — it also appears on MF invoices).
    if "WTA" in n:
        return "wta"
    return "unknown"


def _refine_emf_kind_from_rate(filename: str, text: str, fk: str) -> str:
    """``*_MF.pdf`` is ambiguous (regular vs IEMMS vs supplemental); use Market Fee Rate from PDF text."""
    if fk not in ("emf_regular", "emf_iemms", "emf_supplemental"):
        return fk
    n = (filename or "").upper()
    if "MF1" in n:
        return "emf_iemms"
    if not n.endswith("_MF.PDF"):
        return fk
    rate = _emf_rate_php_per_kwh_from_text(text)
    if rate is None:
        return fk
    # Typical IEMOP bands (Php/kWh): regular ~0.0071, IEMMS ~0.0039, supplemental ~0.0006
    if rate >= 0.005:
        return "emf_regular"
    if rate >= 0.002:
        return "emf_iemms"
    return "emf_supplemental"


def parse_emf_market_fee(text: str) -> dict[str, Any]:
    """
    Market fee PDFs — classic IEMOP layout or TS-WP / TS-WF Settlement SVC layout.
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
    # TS-WP / TS-WF: "7,338.05 (28,471.64) … Net Settlement Amount MWh" (qty/amount order flipped vs classic)
    if out.get("net_settlement_amount") is None:
        m_line = re.search(
            r"([\d,\.]+)\s*\(([\d,\.]+)\)\s*Net Settlement Amount",
            t,
            re.IGNORECASE,
        )
        if m_line:
            v = _parse_money_token("(" + m_line.group(2) + ")")
            if v is not None:
                out["net_settlement_amount"] = v
                out["net_settlement_layout"] = "svc_line"
    m_bp = re.search(
        r"Billing Period\s*\n\s*([A-Za-z]+\s+\d+\s*-\s*[A-Za-z]+\s+\d+,\s*\d{4})",
        t,
        re.IGNORECASE,
    )
    if not m_bp:
        m_bp = re.search(r"([A-Za-z]{3}\s+\d{1,2}\s*-\s*[A-Za-z]{3}\s+\d{1,2},\s*\d{4})", t)
    if m_bp:
        out["billing_period_text"] = m_bp.group(1).strip()
    if re.search(r"\bFinal\s+Statement\b", t, re.IGNORECASE):
        out["statement"] = "Final"
    elif re.search(r"\bPreliminary\s+Statement\b", t, re.IGNORECASE) or re.search(
        r"\bPrelim\s+Statement\b", t, re.IGNORECASE
    ):
        out["statement"] = "Prelim"
    if out.get("net_settlement_amount") is None:
        rate = _emf_rate_php_per_kwh_from_text(t)
        mwh = _emf_mwh_quantity_from_text(t)
        if rate is not None and mwh is not None:
            out["market_fee_rate_php_per_kwh"] = rate
            out["market_fee_quantity_mwh"] = mwh
            out["net_settlement_amount"] = _emf_amount_from_rate_and_mwh(rate, mwh)
            out["net_settlement_layout"] = "rate_times_mwh"
    return out


def _emf_variant_from_text(text: str) -> str | None:
    u = (text or "").upper()
    if re.search(r"\bIEMMS\b", u):
        return "iemms"
    if "SUPPLEMENTAL" in u:
        return "supplemental"
    if re.search(r"\bREGULAR\b", u) and "MARKET" in u:
        return "regular"
    return None


_MONTH_ABBR = {
    "jan": "January",
    "feb": "February",
    "mar": "March",
    "apr": "April",
    "may": "May",
    "jun": "June",
    "jul": "July",
    "aug": "August",
    "sep": "September",
    "oct": "October",
    "nov": "November",
    "dec": "December",
}


def _canonical_month_name(token: str) -> str | None:
    t = re.sub(r"[^a-z]", "", (token or "").lower())
    if not t:
        return None
    if len(t) >= 3 and t[:3] in _MONTH_ABBR:
        return _MONTH_ABBR[t[:3]]
    for full in _MONTH_ABBR.values():
        fl = full.lower()
        if fl.startswith(t) or t.startswith(fl[: min(3, len(fl))]):
            return full
    return None


def infer_statement_ref(text: str) -> str | None:
    """Return ``Prelim`` or ``Final`` from IEMOP-style PDF text."""
    if re.search(r"\bFinal\s+Statement\b", text, re.IGNORECASE):
        return "Final"
    if re.search(r"\bPrelim\s+Statement\b", text, re.IGNORECASE):
        return "Prelim"
    if re.search(r"\bPreliminary\s+Statement\b", text, re.IGNORECASE):
        return "Prelim"
    if re.search(r"COVER\s+SUMMARY\s*-\s*FINAL", text, re.IGNORECASE):
        return "Final"
    if re.search(r"COVER\s+SUMMARY\s*-\s*PRELIM", text, re.IGNORECASE):
        return "Prelim"
    u = (text or "").upper()
    if "<PS>" in u:
        return "Prelim"
    if re.search(r"\bFS-W\d+", text, re.IGNORECASE):
        return "Final"
    return None


def infer_statement_ref_from_filename(name: str) -> str | None:
    """TS-WF … MF / MF1 = Final market fee; TS-WP … MF / MF1 = Prelim (text may be missing on scanned PDFs)."""
    n = (name or "").upper()
    if "TS-WF" in n and ("MF1" in n or re.search(r"_MF\.PDF$", n) or "_MF_" in n or n.endswith("_MF.PDF")):
        return "Final"
    if "TS-WP" in n and ("MF1" in n or re.search(r"_MF\.PDF$", n) or "_MF_" in n or n.endswith("_MF.PDF")):
        return "Prelim"
    return None


def _parse_float_loose(raw: str) -> float | None:
    s = (raw or "").strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _emf_mwh_quantity_from_text(t: str) -> float | None:
    m = re.search(
        r"NET\s+SETTLEMENT\s+AMOUNT\s+([\d,\.]+)\s*MWh",
        t,
        re.IGNORECASE,
    )
    if m:
        return _parse_float_loose(m.group(1))
    m = re.search(
        r"([\d,\.]+)\s*\([\d,\.]+\)\s*Net\s+Settlement\s+Amount",
        t,
        re.IGNORECASE,
    )
    if m:
        return _parse_float_loose(m.group(1))
    m = re.search(
        r"Market\s+Fee\s+Quantity\s*(?:\(MWh\))?\s*:?\s*([\d,\.]+)",
        t,
        re.IGNORECASE,
    )
    if m:
        return _parse_float_loose(m.group(1))
    return None


def _emf_rate_php_per_kwh_from_text(t: str) -> float | None:
    m = re.search(
        r"Market\s+Fees?\s+Rate\s*(?:\(Php/kWh\))?\s*:?\s*([\d\.]+)\s*$",
        t,
        re.IGNORECASE | re.MULTILINE,
    )
    if m:
        return _parse_float_loose(m.group(1))
    lines = [ln.strip() for ln in t.splitlines()]
    for i, ln in enumerate(lines):
        if re.match(r"Market\s+Fees?\s+Rate", ln, re.IGNORECASE):
            for j in range(i + 1, min(i + 12, len(lines))):
                cand = lines[j]
                if re.match(r"^[\d\.]+$", cand):
                    return _parse_float_loose(cand)
    return None


def _emf_amount_from_rate_and_mwh(rate: float, mwh: float) -> float:
    """Php/kWh × MWh × 1000 kWh/MWh; statement uses parentheses for payable → negative."""
    return -round(rate * mwh * 1000.0, 2)


def _is_emf_market_fee_text(text: str) -> bool:
    """True for PS_EMF, TS-WP/TS-WF settlement SVC, and Final layouts that omit the classic net-settlement line."""
    low = (text or "").lower()
    if "market fee" not in low:
        return False
    if "net settlement" in low or "settlement amount" in low:
        return True
    if "market fees for settlement" in low or "market fee for settlement" in low:
        return True
    if "vat for market fees" in low:
        return True
    if ("market fee rate" in low or "market fees rate" in low) and (
        "mwh" in low or "market fee quantity" in low
    ):
        return True
    return False


def billing_period_meta_from_text(text: str) -> dict[str, Any]:
    """Guess ``year``, ``billing_month`` (full English name), ``statement_ref`` from invoice text."""
    out: dict[str, Any] = {}
    if not (text or "").strip():
        return out
    st = infer_statement_ref(text)
    if st:
        out["statement_ref"] = st
    m_bill = re.search(r"Bill\s+for\s+([A-Za-z]+)\s*(\d{4})", text, re.IGNORECASE)
    if m_bill:
        mon = _canonical_month_name(m_bill.group(1))
        if mon:
            out["billing_month"] = mon
            out["year"] = int(m_bill.group(2))
            return out
    # Service invoice / OCR: "Billing Period : 26 December 2025 to 25 January 2026"
    m_svc_bp = re.search(
        r"Billing\s+Period\s*:?\s*\d+\s+\w+\s+\d{4}\s+to\s+\d+\s+([A-Za-z]+)\s+(\d{4})",
        text,
        re.IGNORECASE,
    )
    if m_svc_bp:
        mon = _canonical_month_name(m_svc_bp.group(1))
        if mon:
            out["billing_month"] = mon
            out["year"] = int(m_svc_bp.group(2))
            return out
    m_rng = re.search(
        r"\b([A-Za-z]{3})\s+\d{1,2}\s*-\s*([A-Za-z]{3})\s+\d{1,2},\s*(\d{4})",
        text,
        re.IGNORECASE,
    )
    if m_rng:
        mon = _MONTH_ABBR.get(m_rng.group(2).lower()[:3])
        if mon:
            out["billing_month"] = mon
            out["year"] = int(m_rng.group(3))
            return out
    m_long = re.search(
        r"\b([A-Za-z]+)\s+\d{1,2}\s*-\s*([A-Za-z]+)\s+\d{1,2},\s*(\d{4})",
        text,
        re.IGNORECASE,
    )
    if m_long:
        mon = _canonical_month_name(m_long.group(2))
        if mon:
            out["billing_month"] = mon
            out["year"] = int(m_long.group(3))
    return out


def merge_period_metas(metas: list[dict[str, Any]]) -> tuple[dict[str, Any | None], list[str]]:
    """Pick a single year / billing_month / statement_ref; warn on disagreement."""
    warnings: list[str] = []
    merged: dict[str, Any | None] = {"year": None, "billing_month": None, "statement_ref": None}
    years = [int(m["year"]) for m in metas if m.get("year") is not None]
    if years:
        cy = Counter(years)
        y_best, y_n = cy.most_common(1)[0]
        merged["year"] = y_best
        if len(cy) > 1:
            warnings.append(f"Different years across PDFs {dict(cy)}; using {y_best}.")
    months = [str(m["billing_month"]).strip() for m in metas if m.get("billing_month")]
    if months:
        norm = [next((v for v in _MONTH_ABBR.values() if v.lower() == x.lower()), x) for x in months]
        cm = Counter(norm)
        m_best, _ = cm.most_common(1)[0]
        merged["billing_month"] = m_best
        if len(cm) > 1:
            warnings.append(f"Different billing months across PDFs {dict(cm)}; using {m_best!r}.")
    stmts = [str(m["statement_ref"]).strip() for m in metas if m.get("statement_ref")]
    if stmts:
        cs = Counter(stmts)
        s_best, _ = cs.most_common(1)[0]
        merged["statement_ref"] = s_best
        if len(cs) > 1:
            warnings.append(f"Different statement types across PDFs {dict(cs)}; using {s_best!r}.")
    return merged, warnings


def _period_meta(text: str, filename: str | None = None) -> dict[str, Any]:
    out = billing_period_meta_from_text(text) if (text or "").strip() else {}
    if filename:
        stf = infer_statement_ref_from_filename(filename)
        if stf and not out.get("statement_ref"):
            out["statement_ref"] = stf
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


def parse_wta_cover(
    text: str,
    force_branch: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Returns ('areco'|'arecoss', patch dict for Input columns e..ad).

    ``force_branch`` — when set (``areco`` | ``arecoss``), use that branch instead of
    detecting from PDF text (for uploads where the file name does not hint at type).
    """
    t = text
    if force_branch == "areco":
        is_ss = False
    elif force_branch == "arecoss":
        is_ss = True
    else:
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
    period_meta: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _wta_result_to_extract(
    filename: str, branch: str, patch: dict[str, Any], text: str, *, ocr_used: bool = False
) -> ExtractResult:
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
        period_meta=_period_meta(text, filename),
        warnings=_merge_ocr_warning([], ocr_used),
    )


_SCANNED_PDF_MSG = (
    "No selectable text in this PDF (often a scanned image). Export or download a text-based PDF from IEMOP, "
    "or type amounts manually in the Input grid."
)

_OCR_USED_MSG = (
    "OCR was used to read this scanned PDF; verify market fee amounts if anything looks off."
)


def _merge_ocr_warning(warnings: list[str], ocr_used: bool) -> list[str]:
    if not ocr_used:
        return warnings
    return [*warnings, _OCR_USED_MSG]


def _hint_if_ocr_packages_missing() -> str | None:
    try:
        import fitz  # noqa: F401
    except ImportError:
        return (
            "Optional OCR is not installed. For scanned Final market fee PDFs: "
            "pip install pymupdf pillow pytesseract numpy (and install Tesseract OCR for Windows: "
            "https://github.com/UB-Mannheim/tesseract/wiki), or add opencv-python-headless rapidocr-onnxruntime "
            "on Python 3.8–3.12. Alternatively use text-based PDFs from IEMOP."
        )
    try:
        import cv2  # noqa: F401
        from rapidocr_onnxruntime import RapidOCR  # noqa: F401
    except ImportError:
        pass
    else:
        return None
    try:
        import pytesseract  # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        return (
            "Optional OCR is not installed. For scanned Final market fee PDFs: "
            "pip install pymupdf pillow pytesseract numpy and install Tesseract OCR, "
            "or on Python 3.8–3.12 use pip install opencv-python-headless rapidocr-onnxruntime."
        )
    return None


def extract_invoice_pdf(
    filename: str,
    data: bytes,
    *,
    slot: str | None = None,
) -> ExtractResult:
    """Dispatch parser from PDF content; optional ``slot`` fixes invoice type (ignores filename)."""
    if not data:
        return ExtractResult(
            filename, "empty", warnings=["Empty file"], period_meta=_period_meta("", filename)
        )
    text, ocr_used = _extract_pdf_text(data)
    low = (filename or "").lower()
    fk = _kind_from_filename(filename)
    if (text or "").strip():
        fk = _refine_emf_kind_from_rate(filename, text, fk)
    text_empty = not (text or "").strip()

    # Explicit slot (UI: one file per invoice type — filenames may vary)
    if slot in ("wta_areco", "wta_arecoss"):
        fb = "areco" if slot == "wta_areco" else "arecoss"
        branch, patch = parse_wta_cover(text, force_branch=fb)
        return _wta_result_to_extract(filename, branch, patch, text, ocr_used=ocr_used)

    if slot in ("emf_regular", "emf_iemms", "emf_supplemental"):
        if text_empty:
            sw = [_SCANNED_PDF_MSG]
            h = _hint_if_ocr_packages_missing()
            if h:
                sw.append(h)
            return ExtractResult(
                filename, slot, warnings=sw, period_meta=_period_meta(text, filename)
            )
        if not _is_emf_market_fee_text(text):
            return ExtractResult(
                filename,
                slot,
                warnings=_merge_ocr_warning(
                    [
                        "Expected an EMF market fees PDF for this slot (Market Fees, Net Settlement Amount, "
                        "or Market Fee Rate × Quantity in MWh).",
                    ],
                    ocr_used,
                ),
                period_meta=_period_meta(text, filename),
            )
        emf = parse_emf_market_fee(text)
        amt = emf.get("net_settlement_amount")
        if amt is None:
            amt = emf.get("amount_parentheses")
        if amt is None:
            return ExtractResult(
                filename,
                slot,
                raw_meta=emf,
                warnings=_merge_ocr_warning(
                    ["Could not read net settlement amount from this EMF PDF."], ocr_used
                ),
                period_meta=_period_meta(text, filename),
            )
        col = {"emf_regular": "aa", "emf_iemms": "ab", "emf_supplemental": "ac"}[slot]
        return ExtractResult(
            filename,
            slot,
            input_patch={col: float(amt)},
            raw_meta=emf,
            period_meta=_period_meta(text, filename),
            warnings=_merge_ocr_warning([], ocr_used),
        )

    if fk == "wta" or "wesm transaction" in text.lower():
        branch, patch = parse_wta_cover(text)
        return _wta_result_to_extract(filename, branch, patch, text, ocr_used=ocr_used)

    if fk in ("emf_regular", "emf_iemms", "emf_supplemental") and text_empty:
        sw = [_SCANNED_PDF_MSG]
        h = _hint_if_ocr_packages_missing()
        if h:
            sw.append(h)
        return ExtractResult(
            filename, fk, warnings=sw, period_meta=_period_meta(text, filename)
        )

    if _is_emf_market_fee_text(text):
        emf = parse_emf_market_fee(text)
        ir: dict[str, Any] = {}
        warn: list[str] = []
        amt = emf.get("net_settlement_amount")
        if amt is None:
            amt = emf.get("amount_parentheses")
        if amt is not None:
            col_map = {"emf_regular": "aa", "emf_iemms": "ab", "emf_supplemental": "ac"}
            col: str | None = col_map.get(fk)
            if col is None:
                vt = _emf_variant_from_text(text)
                if vt == "iemms":
                    col = "ab"
                elif vt == "supplemental":
                    col = "ac"
                elif vt == "regular":
                    col = "aa"
            if col is None:
                col = "aa"
                warn.append(
                    "EMF type unclear from file name and PDF text; amount placed under EMF regular. "
                    "Rename files like *_MF1.pdf (IEMMS) and *_MF.pdf (supplemental), or assign amounts manually."
                )
            ir[col] = float(amt)
        return ExtractResult(
            filename,
            fk,
            input_patch=ir,
            raw_meta=emf,
            period_meta=_period_meta(text, filename),
            warnings=_merge_ocr_warning(warn, ocr_used),
        )

    return ExtractResult(
        filename,
        fk,
        warnings=_merge_ocr_warning(["Could not classify PDF; no amounts extracted."], ocr_used),
        period_meta=_period_meta(text, filename),
    )


def merge_input_patches(patches: list[dict[str, float]]) -> dict[str, float]:
    """Later files override overlapping keys."""
    out: dict[str, float] = {}
    for p in patches:
        for k, v in p.items():
            if isinstance(v, (int, float)):
                out[k.lower()] = float(v)
    return out
