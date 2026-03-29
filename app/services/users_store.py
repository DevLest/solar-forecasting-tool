"""Read/write ``users.json`` for account CRUD (admin UI). Atomic save on Windows-friendly replace."""
from __future__ import annotations

import json
import os
import re
import tempfile
from typing import Any

from werkzeug.security import generate_password_hash

from app.config import DATA_DIR, ROOT

ROLES: tuple[str, ...] = ("admin", "nominator", "spectator")

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,64}$")
_MIN_PASSWORD_LEN = 6


def users_file_path() -> str:
    raw = os.environ.get("ARECO_USERS_FILE", "").strip()
    if raw:
        p = raw
        if not os.path.isabs(p):
            p = os.path.abspath(os.path.join(ROOT, p))
        return p
    return os.path.join(DATA_DIR, "users.json")


def _load_document(path: str) -> dict[str, Any]:
    if not os.path.isfile(path):
        return {"users": []}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return {"users": data}
    if isinstance(data, dict) and isinstance(data.get("users"), list):
        return {"users": data["users"]}
    return {"users": []}


def _atomic_write_json(path: str, doc: dict[str, Any]) -> None:
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    raw = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix="users_", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate_username(username: str) -> str | None:
    u = (username or "").strip()
    if not u:
        return "Username is required."
    if not _USERNAME_RE.match(u):
        return "Username: use letters, digits, dot, underscore, or hyphen (max 64 characters)."
    return None


def validate_password(password: str, required: bool) -> str | None:
    if password is None or password == "":
        return "Password is required." if required else None
    if len(password) < _MIN_PASSWORD_LEN:
        return f"Password must be at least {_MIN_PASSWORD_LEN} characters."
    return None


def validate_role(role: str) -> str | None:
    r = (role or "").strip().lower()
    if r not in ROLES:
        return f"Role must be one of: {', '.join(ROLES)}."
    return None


def list_users_public() -> list[dict[str, str]]:
    path = users_file_path()
    doc = _load_document(path)
    users = doc.get("users") or []
    out: list[dict[str, str]] = []
    for row in users:
        if not isinstance(row, dict):
            continue
        u = (row.get("username") or "").strip()
        r = (row.get("role") or "").strip().lower()
        if not u or r not in ROLES:
            continue
        out.append({"username": u, "role": r})
    out.sort(key=lambda x: x["username"].lower())
    return out


def _admin_count(users: list[dict[str, Any]]) -> int:
    n = 0
    for row in users:
        if isinstance(row, dict) and (row.get("role") or "").strip().lower() == "admin":
            n += 1
    return n


def create_user(*, username: str, password: str, role: str) -> tuple[bool, str]:
    err = validate_username(username)
    if err:
        return False, err
    err = validate_password(password, required=True)
    if err:
        return False, err
    err = validate_role(role)
    if err:
        return False, err
    path = users_file_path()
    doc = _load_document(path)
    users: list[dict[str, Any]] = list(doc.get("users") or [])
    u = username.strip()
    if any((isinstance(x, dict) and (x.get("username") or "").strip() == u) for x in users):
        return False, "That username already exists."
    users.append(
        {
            "username": u,
            "role": role.strip().lower(),
            "password_hash": generate_password_hash(password),
        }
    )
    doc["users"] = users
    try:
        _atomic_write_json(path, doc)
    except OSError as e:
        return False, str(e)
    return True, ""


def update_user(
    *,
    username: str,
    role: str | None = None,
    password: str | None = None,
    actor_username: str,
) -> tuple[bool, str]:
    path = users_file_path()
    doc = _load_document(path)
    users: list[dict[str, Any]] = list(doc.get("users") or [])
    key = (username or "").strip()
    idx = next(
        (i for i, x in enumerate(users) if isinstance(x, dict) and (x.get("username") or "").strip() == key),
        -1,
    )
    if idx < 0:
        return False, "User not found."
    row = dict(users[idx])
    new_role = (role.strip().lower() if role is not None and str(role).strip() != "" else None)
    if new_role is not None:
        err = validate_role(new_role)
        if err:
            return False, err
        old_role = (row.get("role") or "").strip().lower()
        if old_role == "admin" and new_role != "admin":
            if _admin_count(users) <= 1:
                return False, "Cannot remove the last administrator."
        if key == actor_username and new_role != "admin":
            if _admin_count(users) <= 1:
                return False, "You cannot demote yourself while you are the only administrator."
        row["role"] = new_role
    if password is not None and str(password).strip() != "":
        err = validate_password(password, required=True)
        if err:
            return False, err
        row["password_hash"] = generate_password_hash(password)
    if not row.get("password_hash"):
        return False, "User record is missing password_hash."
    users[idx] = row
    doc["users"] = users
    try:
        _atomic_write_json(path, doc)
    except OSError as e:
        return False, str(e)
    return True, ""


def delete_user(*, username: str, actor_username: str) -> tuple[bool, str]:
    key = (username or "").strip()
    if key == actor_username:
        return False, "You cannot delete your own account while signed in."
    path = users_file_path()
    doc = _load_document(path)
    users: list[dict[str, Any]] = list(doc.get("users") or [])
    victim = next(
        (x for x in users if isinstance(x, dict) and (x.get("username") or "").strip() == key),
        None,
    )
    if not victim:
        return False, "User not found."
    if (victim.get("role") or "").strip().lower() == "admin" and _admin_count(users) <= 1:
        return False, "Cannot delete the last administrator."
    doc["users"] = [x for x in users if not (isinstance(x, dict) and (x.get("username") or "").strip() == key)]
    try:
        _atomic_write_json(path, doc)
    except OSError as e:
        return False, str(e)
    return True, ""
