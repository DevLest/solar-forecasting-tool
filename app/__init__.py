"""ARECO Solar Operations — Flask application factory."""
from __future__ import annotations

import os

from flask import Flask

from app.config import ROOT


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=os.path.join(ROOT, "templates"),
        static_folder=os.path.join(ROOT, "static"),
        static_url_path="/static",
    )
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    from app.routes import bp as main_bp
    from app.services.nomination_accuracy_store import init_nomination_accuracy_db

    init_nomination_accuracy_db()
    app.register_blueprint(main_bp)

    return app
