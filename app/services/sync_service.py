"""Push/pull sync for a read-only hosted dashboard (e.g. Render).

Design goals:
- Local app is the source of truth and *pushes* state to the hosted app.
- Hosted app exposes a token-protected endpoint that accepts a compressed payload.
- Use stdlib only (no requests dependency).
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.config import DATA_DIR, HISTORICAL_EXPORTS_FILE
from app.services.billing_history_store import _DB_PATH as BILLING_DB_PATH
from app.services.nomination_accuracy_store import db_path as nomination_accuracy_db_path


SYNC_STATE_FILE = os.path.join(DATA_DIR, "sync_state.json")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json_file(path: str) -> Any:
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _write_json_atomic(path: str, obj: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def read_sync_state() -> dict[str, Any]:
    state = _read_json_file(SYNC_STATE_FILE)
    if isinstance(state, dict):
        return state
    return {}


def write_sync_state(patch: dict[str, Any]) -> dict[str, Any]:
    cur = read_sync_state()
    cur.update(patch or {})
    _write_json_atomic(SYNC_STATE_FILE, cur)
    return cur


@dataclass(frozen=True)
class SyncFiles:
    historical_exports_json: str
    nomination_accuracy_sqlite3: str
    billing_history_sqlite3: str


def local_sync_files() -> SyncFiles:
    return SyncFiles(
        historical_exports_json=HISTORICAL_EXPORTS_FILE,
        nomination_accuracy_sqlite3=nomination_accuracy_db_path(),
        billing_history_sqlite3=BILLING_DB_PATH,
    )


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def build_sync_payload(*, source_label: str) -> dict[str, Any]:
    """
    Payload format (JSON):
      {
        "version": 1,
        "sentAt": "...",
        "source": "...",
        "files": {
          "historical_exports.json": { "encoding": "gzip+base64", "sha256": "...", "bytes": <int>, "data": "..." },
          "nomination_accuracy.sqlite3": { ... },
          "billing_history.sqlite3": { ... }
        }
      }
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    files = local_sync_files()

    mapping: list[tuple[str, str]] = [
        ("historical_exports.json", files.historical_exports_json),
        ("nomination_accuracy.sqlite3", files.nomination_accuracy_sqlite3),
        ("billing_history.sqlite3", files.billing_history_sqlite3),
    ]

    out_files: dict[str, Any] = {}
    for name, path in mapping:
        if not os.path.isfile(path):
            continue
        raw = _read_bytes(path)
        gz = gzip.compress(raw, compresslevel=6)
        out_files[name] = {
            "encoding": "gzip+base64",
            "sha256": _sha256_bytes(raw),
            "bytes": len(raw),
            "gzBytes": len(gz),
            "data": base64.b64encode(gz).decode("ascii"),
        }

    return {
        "version": 1,
        "sentAt": _utc_now_iso(),
        "source": source_label,
        "files": out_files,
    }


def apply_sync_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Apply a received payload into DATA_DIR atomically where possible."""
    if not isinstance(payload, dict):
        raise ValueError("Invalid payload (expected JSON object).")
    if int(payload.get("version") or 0) != 1:
        raise ValueError("Unsupported payload version.")
    files = payload.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("Payload missing files.")

    os.makedirs(DATA_DIR, exist_ok=True)
    applied: dict[str, Any] = {}

    allowed = {
        "historical_exports.json": HISTORICAL_EXPORTS_FILE,
        "nomination_accuracy.sqlite3": os.path.join(DATA_DIR, "nomination_accuracy.sqlite3"),
        "billing_history.sqlite3": os.path.join(DATA_DIR, "billing_history.sqlite3"),
    }

    for name, meta in files.items():
        if name not in allowed:
            continue
        if not isinstance(meta, dict):
            continue
        if meta.get("encoding") != "gzip+base64":
            raise ValueError(f"Unsupported encoding for {name}.")
        data_b64 = meta.get("data")
        if not isinstance(data_b64, str) or not data_b64:
            raise ValueError(f"Missing data for {name}.")
        try:
            gz = base64.b64decode(data_b64.encode("ascii"), validate=True)
            raw = gzip.decompress(gz)
        except Exception as e:  # noqa: BLE001 - surface as ValueError
            raise ValueError(f"Could not decode {name}: {e}") from e

        expected_sha = meta.get("sha256")
        if expected_sha and isinstance(expected_sha, str):
            got = _sha256_bytes(raw)
            if got.lower() != expected_sha.lower():
                raise ValueError(f"Checksum mismatch for {name}.")

        dest = allowed[name]
        tmp = f"{dest}.tmp.{os.getpid()}"
        with open(tmp, "wb") as f:
            f.write(raw)
        os.replace(tmp, dest)
        applied[name] = {"bytes": len(raw), "sha256": _sha256_bytes(raw)}

    return applied


def _remote_url() -> str:
    return (os.environ.get("ARECO_SYNC_REMOTE_URL") or "").strip().rstrip("/")


def sync_config() -> dict[str, Any]:
    url = _remote_url()
    token = (os.environ.get("ARECO_SYNC_TOKEN") or "").strip()
    enabled = bool(url and token)
    return {
        "enabled": enabled,
        "remote_url": url,
        "has_token": bool(token),
    }


def push_sync_payload_to_remote(*, reason: str, timeout_s: float = 25.0) -> dict[str, Any]:
    cfg = sync_config()
    if not cfg["enabled"]:
        raise RuntimeError("Remote sync is not configured (set ARECO_SYNC_REMOTE_URL and ARECO_SYNC_TOKEN).")
    url = str(cfg["remote_url"]) + "/api/sync/push"
    token = (os.environ.get("ARECO_SYNC_TOKEN") or "").strip()

    payload = build_sync_payload(source_label=reason or "local")
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-ARECO-SYNC-TOKEN": token,
            "User-Agent": "areco-sync/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=float(timeout_s)) as resp:
            resp_body = resp.read() or b""
            try:
                return json.loads(resp_body.decode("utf-8"))
            except Exception:
                return {"ok": resp.status >= 200 and resp.status < 300, "raw": resp_body[:500].decode("utf-8", "ignore")}
    except urllib.error.HTTPError as e:
        raw = e.read() if hasattr(e, "read") else b""
        raise RuntimeError(f"Remote sync failed: HTTP {e.code} {e.reason} {raw[:300]!r}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Remote sync failed: {e}") from e


def push_sync_payload_to_remote_async(*, reason: str) -> None:
    """Fire-and-forget background push; records status in sync_state.json."""

    def run() -> None:
        started = time.time()
        write_sync_state({"last_push_started_at": _utc_now_iso(), "last_push_reason": reason})
        try:
            res = push_sync_payload_to_remote(reason=reason)
            elapsed_ms = int((time.time() - started) * 1000)
            write_sync_state(
                {
                    "last_push_ok": bool(res.get("ok")) if isinstance(res, dict) else True,
                    "last_push_finished_at": _utc_now_iso(),
                    "last_push_elapsed_ms": elapsed_ms,
                    "last_push_response": res if isinstance(res, dict) else {"raw": str(res)},
                    "last_push_error": None,
                }
            )
        except Exception as e:  # noqa: BLE001
            elapsed_ms = int((time.time() - started) * 1000)
            write_sync_state(
                {
                    "last_push_ok": False,
                    "last_push_finished_at": _utc_now_iso(),
                    "last_push_elapsed_ms": elapsed_ms,
                    "last_push_error": str(e),
                }
            )

    t = threading.Thread(target=run, name="areco-sync-push", daemon=True)
    t.start()

