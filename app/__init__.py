"""ARECO Solar Operations - Flask application factory."""
from __future__ import annotations

import logging
import os
import shutil

from flask import Flask
from flask_login import current_user

from app.auth import auth_context_dict, login_manager
from app.services.users_store import users_file_path
from app.config import DATA_DIR, ROOT

logger = logging.getLogger(__name__)


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=os.path.join(ROOT, "templates"),
        static_folder=os.path.join(ROOT, "static"),
        static_url_path="/static",
    )
    # Settlement master zips can be large (nested monthly bundles).
    app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    secret = os.environ.get("ARECO_SECRET_KEY", "").strip()
    if not secret:
        secret = "dev-insecure-secret-set-ARECO_SECRET_KEY"
    app.config["SECRET_KEY"] = secret

    login_manager.init_app(app)

    @app.context_processor
    def inject_areco_auth():
        ctx = auth_context_dict(current_user)
        return {
            "areco_auth": ctx,
            "areco_panels": set(ctx["panels"]),
            "areco_role": ctx["role"],
            "areco_nomination_readonly": bool(ctx.get("nomination_read_only")),
            "nomination_trader_options": ctx.get("nomination_trader_options") or [],
        }

    from app.routes import bp as main_bp
    from app.services.billing_history_store import init_billing_history_db
    from app.services.nomination_accuracy_store import init_nomination_accuracy_db
    from app.services.sync_service import start_auto_sync_scheduler

    init_nomination_accuracy_db()
    init_billing_history_db()
    # No-op unless ARECO_SYNC_REMOTE_URL + ARECO_SYNC_TOKEN are set (i.e. this
    # is the local trader instance, not the hosted read-only Viewer).
    start_auto_sync_scheduler()

    uf = users_file_path()
    if not os.path.isfile(uf):
        # ARECO_USERS_SEED_FILE lets a deployment seed from something other than
        # users.example.json (which includes admin + nominator accounts) - e.g.
        # the hosted read-only Viewer seeds from users.viewer.example.json,
        # which has a spectator-only account, so no admin credentials ever
        # exist on a public instance.
        seed_name = (os.environ.get("ARECO_USERS_SEED_FILE") or "users.example.json").strip()
        example = os.path.join(ROOT, seed_name)
        if os.path.isfile(example):
            try:
                os.makedirs(os.path.dirname(uf) or ".", exist_ok=True)
                shutil.copyfile(example, uf)
                logger.info("Seeded users file from %s -> %s", seed_name, uf)
            except OSError as e:
                logger.error(
                    "Could not copy %s to %s: %s - create data/users.json or fix permissions.",
                    seed_name,
                    uf,
                    e,
                )
        else:
            logger.error(
                "No users file at %s and seed file %s is missing under %s.",
                uf,
                seed_name,
                ROOT,
            )

    app.register_blueprint(main_bp)

    return app
