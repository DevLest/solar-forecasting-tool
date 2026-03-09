"""
Day Ahead Nomination app entry point.
Run: python main_nomination.py
Opens GUI to enter forecast date and 288 5-min MW values, then generate RawBidSet XML for IEMOP.
"""
from pathlib import Path

# Ensure project root is on path
_project_root = Path(__file__).resolve().parent
if str(_project_root) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_project_root))

from src import config
from src.nomination_ui import main

if __name__ == "__main__":
    # Create output dir if missing
    (config.PROJECT_ROOT / "output").mkdir(parents=True, exist_ok=True)
    main()
