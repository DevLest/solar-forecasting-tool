"""
Load and save nomination app config (generator_mrid, participant_mrid, timezone).
Config file: config.json in project root.
"""
from pathlib import Path
import json

# Project root: parent of src/
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.json"

# Default Resource Name and Market Participant (always included in XML per RawBidSet.xsd)
DEFAULTS = {
    "generator_mrid": "06VISTASOL_G01",
    "participant_mrid": "ARECO_01",
    "timezone": "+08:00",
    "source": "Default",
}


def load():
    """Load config from config.json; return defaults if file missing or invalid."""
    if not CONFIG_PATH.exists():
        return DEFAULTS.copy()
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        out = DEFAULTS.copy()
        for key in DEFAULTS:
            if key in data and data[key] is not None:
                out[key] = str(data[key]).strip() if isinstance(data[key], str) else data[key]
        return out
    except (json.JSONDecodeError, OSError):
        return DEFAULTS.copy()


def save(generator_mrid: str, participant_mrid: str, timezone: str, source: str = "Default"):
    """Save config to config.json."""
    data = {
        "generator_mrid": (generator_mrid or "").strip(),
        "participant_mrid": (participant_mrid or "").strip(),
        "timezone": (timezone or "+08:00").strip(),
        "source": (source or "Default").strip(),
    }
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
