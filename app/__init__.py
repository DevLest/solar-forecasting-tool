"""ARECO Solar Operations — Flask application factory."""
from __future__ import annotations

import os
import shutil

from flask import Flask
from flask_login import current_user

from app.auth import auth_context_dict, login_manager
from app.services.users_store import users_file_path
from app.config import DATA_DIR, ROOT


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
            "nomination_trader_options": ctx.get("nomination_trader_options") or [],
        }

    from app.routes import bp as main_bp
    from app.services.billing_history_store import init_billing_history_db
    from app.services.nomination_accuracy_store import init_nomination_accuracy_db

    init_nomination_accuracy_db()
    init_billing_history_db()

    uf = users_file_path()
    if not os.path.isfile(uf):
        example = os.path.join(ROOT, "users.example.json")
        if os.path.isfile(example):
            try:
                os.makedirs(os.path.dirname(uf) or ".", exist_ok=True)
                shutil.copyfile(example, uf)
            except OSError:
                pass

    app.register_blueprint(main_bp)

    return app
