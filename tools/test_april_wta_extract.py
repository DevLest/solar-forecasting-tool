"""Quick check: April 2026 Final invoice extraction."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.billing_history_store import compute_display_totals, display_layout
from app.services.billing_invoice_extract import extract_invoice_pdf, merge_input_patches

BASE = Path(
    r"c:\Users\User\OneDrive - B.Grimm Power Public Company Limited\Desktop\Crss Files\CRSS DATA 2026\04_April\Final\Invoice"
)

FILES = [
    "ARECO_238_FS_EMF_IEMMS.pdf",
    "ARECO_238_FS_EMF_REGULAR.pdf",
    "ARECO_238_FS_EMF_SUPPLEMENTAL.pdf",
    "ARECO_TS-WF-238F-0056051_WTA.pdf",
    "ARECO_TS-WF-238F-0056079_WTA.pdf",
]


def main() -> None:
    patches = []
    for name in FILES:
        path = BASE / name
        if not path.is_file():
            print("MISSING", path)
            continue
        r = extract_invoice_pdf(name, path.read_bytes())
        print(name, "->", r.input_patch)
        patches.append(r.input_patch)
    merged = merge_input_patches(patches)
    print("MERGED:", json.dumps(merged, indent=2))
    disp = display_layout(compute_display_totals([{"amounts": merged}]))
    print("Total Receivable:", disp["total_receivable_from_iemop"])
    print("Total Payable:", disp["total_payable_to_iemop"])


if __name__ == "__main__":
    main()
