"""
Legacy splitter: when the full page lived in dashboard.html, this extracted CSS/JS/partials.

The canonical UI is now templates/ + static/. Re-run only if you temporarily restore a monolithic HTML file
and need to re-split (adjust line numbers inside this script to match that file).
"""
from __future__ import annotations

import re
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "dashboard.html").read_text(encoding="utf-8")
lines = src.splitlines()

# CSS: first <style> block in <head>
m = re.search(r"<style>\s*(.*?)\s*</style>", src, re.DOTALL)
if not m:
    raise SystemExit("No <style> found")
(root / "static" / "css").mkdir(parents=True, exist_ok=True)
(root / "static" / "css" / "areco-brand.css").write_text(m.group(1).strip() + "\n", encoding="utf-8")

# Panels (1-based line numbers from current dashboard.html structure)
(root / "templates" / "partials").mkdir(parents=True, exist_ok=True)
(root / "templates" / "partials" / "_panel_nomination.html").write_text(
    "\n".join(lines[194:449]) + "\n", encoding="utf-8"
)
(root / "templates" / "partials" / "_panel_billing.html").write_text(
    "\n".join(lines[450:461]) + "\n", encoding="utf-8"
)

(root / "static" / "js").mkdir(parents=True, exist_ok=True)
(root / "static" / "js" / "app-shell.js").write_text("\n".join(lines[485:559]) + "\n", encoding="utf-8")
(root / "static" / "js" / "nomination-dashboard.js").write_text("\n".join(lines[560:2247]) + "\n", encoding="utf-8")

print("Extracted CSS, partials, JS to static/ and templates/partials/")
