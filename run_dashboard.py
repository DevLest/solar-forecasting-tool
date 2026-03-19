#!/usr/bin/env python3
"""
ARECO Solar Operations — Flask entrypoint (replaces the old stdlib-only static server).

  pip install -r requirements.txt
  python run_dashboard.py

Templates: templates/  ·  Shared UI: templates/components/  ·  Static: static/
"""
from __future__ import annotations

import os
import socket
import sys
import webbrowser

# Allow `python run_dashboard.py` from any cwd
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
os.chdir(_SCRIPT_DIR)

try:
    from app import create_app
    from app.config import PORT
except ImportError as e:
    print(
        "Missing dependency (Flask). Install with:\n"
        "  python -m pip install -r requirements.txt\n"
        f"Import error: {e}",
        file=sys.stderr,
    )
    sys.exit(1)


def _local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def main():
    app = create_app()
    url_local = f"http://127.0.0.1:{PORT}/"
    print(f"Serving ARECO app at {url_local}")
    lan_ip = _local_ip()
    if lan_ip:
        print(f"  From another device: http://{lan_ip}:{PORT}/")
    print("Press Ctrl+C to stop.")
    webbrowser.open(url_local)
    # threaded=True so browser + API calls don't block each other under load
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
