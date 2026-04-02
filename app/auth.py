"""Session auth, roles, and API/page access rules."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

from flask import jsonify
from flask_login import LoginManager, UserMixin, current_user
from werkzeug.security import check_password_hash

from app.services.users_store import list_users_public, users_file_path

logger = logging.getLogger(__name__)

ROLE_ADMIN = "admin"
ROLE_NOMINATOR = "nominator"
ROLE_SPECTATOR = "spectator"

# Sidebar / panel ids used by app-shell.js
PANEL_NOMINATION = "nomination"
PANEL_NOMINATION_REPORTING = "nomination-reporting"
PANEL_NOMINATION_ACCURACY = "nomination-accuracy"
PANEL_BILLING = "billing"
PANEL_BILLING_HISTORY = "billing-history"

PANELS_BY_ROLE: dict[str, frozenset[str]] = {
    ROLE_ADMIN: frozenset(
        {
            PANEL_NOMINATION,
            PANEL_NOMINATION_REPORTING,
            PANEL_NOMINATION_ACCURACY,
            PANEL_BILLING,
            PANEL_BILLING_HISTORY,
        }
    ),
    ROLE_NOMINATOR: frozenset({PANEL_NOMINATION}),
    ROLE_SPECTATOR: frozenset(
        {
            PANEL_NOMINATION,
            PANEL_NOMINATION_REPORTING,
            PANEL_NOMINATION_ACCURACY,
            PANEL_BILLING_HISTORY,
        }
    ),
}

# Endpoints nominator may call (method uppercase). Page routes are GET-only here.
_NOMINATOR_ALLOWED: dict[str, frozenset[str]] = {
    "main.index": frozenset({"GET", "HEAD"}),
    "main.legacy_dashboard": frozenset({"GET", "HEAD"}),
    "main.assets": frozenset({"GET", "HEAD"}),
    "main.api_historical_exports": frozenset({"GET", "HEAD"}),
    "main.api_save_export": frozenset({"POST", "OPTIONS"}),
    "main.api_nomination_save_file": frozenset({"POST", "OPTIONS"}),
    "main.api_weather_forecast": frozenset({"POST", "OPTIONS"}),
}

# Spectator: read-only; excludes env/API keys (e.g. app-config).
_SPECTATOR_ALLOWED_GET: frozenset[str] = frozenset(
    {
        "main.index",
        "main.legacy_dashboard",
        "main.assets",
        "main.api_historical_exports",
        "main.api_nomination_accuracy_uploaded_dates",
        "main.api_nomination_reporting_compliance_csv_days",
        "main.api_nomination_reporting_marketplace_ready_days",
        "main.api_nomination_reporting_market_result_csv_days",
        "main.api_nomination_reporting_marketplace_chart",
        "main.api_nomination_accuracy_runs",
        "main.api_nomination_accuracy_analytics_monthly",
        "main.api_nomination_accuracy_analytics_month_detail",
        "main.api_nomination_accuracy_analytics_annual",
        "main.api_billing_settlement_config",
        "main.api_billing_default_export_dir",
        "main.api_billing_user_export_shortcuts",
        "main.api_billing_history_rows",
        "main.api_billing_history_display",
    }
)


@dataclass(frozen=True)
class UserRecord:
    username: str
    role: str
    password_hash: str


class User(UserMixin):
    def __init__(self, username: str, role: str) -> None:
        self.id = username
        self.username = username
        self.role = role

    @property
    def allowed_panels(self) -> frozenset[str]:
        return PANELS_BY_ROLE.get(self.role, frozenset())


def load_user_records() -> dict[str, UserRecord]:
    path = users_file_path()
    if not os.path.isfile(path):
        logger.warning(
            "No user file at %s — create it (see users.example.json in the project root). Auth will fail until it exists.",
            path,
        )
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.error("Could not read users file %s: %s", path, e)
        return {}
    users_raw = data.get("users") if isinstance(data, dict) else data
    if not isinstance(users_raw, list):
        logger.error("users.json must contain a list or { \"users\": [ ... ] }.")
        return {}
    out: dict[str, UserRecord] = {}
    for row in users_raw:
        if not isinstance(row, dict):
            continue
        username = (row.get("username") or "").strip()
        role = (row.get("role") or "").strip().lower()
        pw_hash = (row.get("password_hash") or "").strip()
        if not username or not pw_hash:
            continue
        if role not in PANELS_BY_ROLE:
            logger.warning("Skipping user %r: unknown role %r", username, role)
            continue
        out[username] = UserRecord(username=username, role=role, password_hash=pw_hash)
    return out


def authenticate(username: str, password: str) -> User | None:
    username = (username or "").strip()
    if not username or password is None:
        return None
    records = load_user_records()
    rec = records.get(username)
    if not rec:
        return None
    if not check_password_hash(rec.password_hash, password):
        return None
    return User(rec.username, rec.role)


login_manager = LoginManager()
login_manager.login_view = "main.login"
login_manager.session_protection = "strong"


@login_manager.unauthorized_handler
def unauthorized_callback():
    from flask import jsonify, redirect, request, url_for

    if request.path.startswith("/api/"):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Authentication required.",
                    "code": "auth_required",
                }
            ),
            401,
        )
    return redirect(url_for("main.login", next=request.url))


@login_manager.user_loader
def load_user(user_id: str) -> User | None:
    if not user_id:
        return None
    records = load_user_records()
    rec = records.get(user_id)
    if not rec:
        return None
    return User(rec.username, rec.role)


def api_forbidden(message: str = "You do not have permission for this action."):
    return jsonify({"ok": False, "error": message, "code": "forbidden"}), 403


def request_allowed_for_role(endpoint: str | None, method: str, role: str) -> bool:
    if not endpoint:
        return True
    m = (method or "GET").upper()
    if role == ROLE_ADMIN:
        return True
    if role == ROLE_SPECTATOR:
        if m == "OPTIONS":
            return True
        if m in ("GET", "HEAD"):
            return endpoint in _SPECTATOR_ALLOWED_GET
        return False
    if role == ROLE_NOMINATOR:
        allowed_methods = _NOMINATOR_ALLOWED.get(endpoint)
        if allowed_methods is None:
            return False
        return m in allowed_methods
    return False


def default_panel_for_role(role: str) -> str:
    panels = PANELS_BY_ROLE.get(role, frozenset())
    # Spectators can open the nomination dashboard (read-only); keep Reporting as the default landing.
    if role == ROLE_SPECTATOR and PANEL_NOMINATION_REPORTING in panels:
        return PANEL_NOMINATION_REPORTING
    if PANEL_NOMINATION in panels:
        return PANEL_NOMINATION
    if PANEL_NOMINATION_REPORTING in panels:
        return PANEL_NOMINATION_REPORTING
    if PANEL_NOMINATION_ACCURACY in panels:
        return PANEL_NOMINATION_ACCURACY
    if PANEL_BILLING_HISTORY in panels:
        return PANEL_BILLING_HISTORY
    if PANEL_BILLING in panels:
        return PANEL_BILLING
    return PANEL_NOMINATION


def nomination_trader_options_for_role(user_role: str) -> list[str]:
    """Usernames that may appear on the nomination &quot;On duty&quot; list (admin + nominator accounts)."""
    if PANEL_NOMINATION not in PANELS_BY_ROLE.get(user_role, frozenset()):
        return []
    try:
        rows = list_users_public()
        names = [
            r["username"]
            for r in rows
            if r.get("role") in (ROLE_ADMIN, ROLE_NOMINATOR)
        ]
        if "Daniel" not in names:
            names.append("Daniel")
        return sorted(names, key=lambda s: s.lower())
    except Exception:
        logger.exception("Could not load nomination trader options from users file.")
        return ["Daniel"]


def auth_context_dict(user: Any) -> dict[str, Any]:
    if not getattr(user, "is_authenticated", False):
        return {
            "role": None,
            "username": None,
            "panels": [],
            "default_panel": PANEL_NOMINATION,
            "can_edit_settings": False,
            "nomination_read_only": False,
            "nomination_trader_options": [],
        }
    role = getattr(user, "role", ROLE_ADMIN)
    panels = sorted(PANELS_BY_ROLE.get(role, frozenset()))
    return {
        "role": role,
        "username": getattr(user, "username", None),
        "panels": panels,
        "default_panel": default_panel_for_role(role),
        "can_edit_settings": role == ROLE_ADMIN,
        "nomination_read_only": role == ROLE_SPECTATOR,
        "nomination_trader_options": nomination_trader_options_for_role(role),
    }
