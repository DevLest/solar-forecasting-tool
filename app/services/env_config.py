"""Read and merge allowed keys into the project ``.env`` file (local ops UI)."""
from __future__ import annotations

import os
import re
from pathlib import Path

from app.config import ROOT

_ENV_PATH = Path(ROOT) / ".env"

# Keys the settings UI may read/write (single-line values only).
ALLOWED_ENV_KEYS: frozenset[str] = frozenset(
    {
        "ARECO_PORT",
        "ARECO_NOMINATION_EXPORT_DIR",
        "ARECO_SETTLEMENT_ZIP_PASSWORD1",
        "ARECO_SETTLEMENT_ZIP_PASSWORD2",
        "ARECO_SYNC_REMOTE_URL",
        "ARECO_SYNC_TOKEN",
        "OPENAI_API_KEY",
        "ACCUWEATHER_API_KEY",
    }
)


def _line_key(line: str) -> str | None:
    s = line.strip()
    if not s or s.startswith("#"):
        return None
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", s)
    return m.group(1) if m else None


def read_env_file_dict() -> dict[str, str]:
    """Return KEY -> value for allowed keys found in ``.env`` (last wins)."""
    out: dict[str, str] = {}
    if not _ENV_PATH.is_file():
        return out
    try:
        text = _ENV_PATH.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        key = _line_key(line)
        if key not in ALLOWED_ENV_KEYS:
            continue
        raw = line.split("=", 1)
        if len(raw) != 2:
            continue
        val = raw[1].strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        out[key] = val
    return out


def merge_env_updates(updates: dict[str, str]) -> None:
    """
    Merge ``updates`` into ``.env``. Empty string = skip (keep existing).
    Creates the file if missing. Preserves unrelated lines and comments.
    """
    filtered = {k: v for k, v in updates.items() if k in ALLOWED_ENV_KEYS and v != ""}
    if not filtered:
        return

    lines: list[str] = []
    seen_keys: set[str] = set()
    if _ENV_PATH.is_file():
        try:
            lines = _ENV_PATH.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []

    new_lines: list[str] = []
    for line in lines:
        key = _line_key(line)
        if key in filtered:
            new_lines.append(f"{key}={filtered[key]}")
            seen_keys.add(key)
        else:
            new_lines.append(line)

    for key, val in filtered.items():
        if key not in seen_keys:
            if new_lines and new_lines[-1].strip():
                new_lines.append("")
            new_lines.append(f"{key}={val}")
            seen_keys.add(key)

    _ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    _ENV_PATH.write_text("\n".join(new_lines) + ("\n" if new_lines else ""), encoding="utf-8")

    for key, val in filtered.items():
        os.environ[key] = val


def apply_env_to_process() -> None:
    """Refresh ``os.environ`` from disk for allowed keys (after external edit)."""
    for k, v in read_env_file_dict().items():
        os.environ[k] = v
