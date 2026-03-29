# ARECO 65 MW Solar — Operations

Flask app for WESM nomination (weather, export history, server-side XML/VRE file writes), **nomination reporting** (MPI compliance + market result CSVs, marketplace charts), **nomination accuracy** (MQ workbooks, saved runs, rollups), and **billing** (settlement master zip extraction, invoice PDF parsing into billing history).

## Requirements

- Python 3.7+ (3.12 recommended; `run.sh` / `ARECO65.bat` can bootstrap a portable Windows embed if needed)

## Run

```bash
python -m pip install -r requirements.txt
python run_dashboard.py
```

Open **http://127.0.0.1:8765/** (default). On first launch the dev server may open your browser automatically; that is skipped on PaaS-style hosts (`RENDER`, `DYNO`).

**Launchers** (install dependencies quietly when possible, then start the app):

- **Windows:** `ARECO65.bat`
- **Linux / macOS / Git Bash:** `./run.sh`

## Authentication and roles

The app uses **Flask-Login**. Unauthenticated requests to pages redirect to `/login`; API calls return `401` with `code: auth_required`.

| Role | Panels / access |
|------|------------------|
| **admin** | Nomination, Reporting, Accuracy, Billing (settlement extract), Billing history; App settings (env keys + user CRUD); all APIs |
| **nominator** | Nomination only: weather, historical exports, save export, write nomination files under `automate/` (or `ARECO_NOMINATION_EXPORT_DIR`) |
| **spectator** | Read-only Reporting, Accuracy analytics, Billing history views (no uploads that mutate data, no env editor) |

**Users file:** `data/users.json` by default (override with `ARECO_USERS_FILE`). On first run, if that file is missing, the app copies **`users.example.json`** from the project root into `data/users.json`. Replace password hashes before production (see `.env.example`).

**Session secret:** set **`ARECO_SECRET_KEY`** in production. If unset, a dev-only default is used.

## Architecture

| Area | Purpose |
|------|--------|
| **`app/`** | `create_app()`: Flask, `MAX_CONTENT_LENGTH` for large settlement uploads, `SECRET_KEY`, LoginManager, DB init |
| **`app/routes/`** | Pages (`/`, `/login`, `/logout`), `/assets/…`, JSON API |
| **`app/auth.py`** | Roles, panel visibility, per-role API allowlists |
| **`app/services/`** | Weather (OpenAI + AccuWeather fallback, daily cache), export history, nomination file save, nomination accuracy + SQLite, MPI CSV storage + marketplace charts, billing settlement unzip/extract, invoice PDF extract, billing history SQLite, admin users store, allowed `.env` keys for the settings UI |
| **`templates/layouts/`** | `app.html` shell |
| **`templates/components/`** | Header, sidebar, footer, modal, `ui_macros.html`, `head_base.html` |
| **`templates/pages/`** | `home.html`, `login.html` |
| **`templates/partials/`** | Feature panels: nomination, nomination-reporting, nomination-accuracy, billing, billing-history; `_settings_drawer.html` |
| **`static/css/`** | Shared styles (`areco-brand.css`, etc.) |
| **`static/js/`** | `app-shell.js` (nav, modal, settings), `nomination-dashboard.js`, `nomination-reporting.js`, `nomination-accuracy.js`, `billing-settlement.js`, `billing-history.js` |
| **`assets/`** | Icons and images (served at `/assets/…`) |
| **`data/`** | Runtime data: `historical_exports.json`, weather cache files, `nomination_accuracy.sqlite3`, `billing_history.sqlite3`, default settlement export folder, `users.json` (see `.gitignore` — most of `data/` is ignored; `users.json` is explicitly un-ignored for optional version control) |
| **`automate/`** | Default directory for nomination XML / VRE CSV written by `POST /api/nomination-save-file` |

Legacy **`dashboard.html`** is only a short note if you open it from disk; the live UI is **`/`** and **`/dashboard.html`** (both render `home.html`).

## API overview

All routes except **`GET|POST /login`** require an authenticated session (browser cookie). Admin-only JSON routes return `403` for other roles.

**Nomination (core)** — still the backbone of the original tool:

- `GET /api/historical-exports`
- `POST /api/save-export`
- `POST /api/weather-forecast` — body: `{ "date": "YYYY-MM-DD", "lat", "lon", "force_refresh" }`
- `POST /api/nomination-save-file` — JSON `{ "filename", "content" }` → writes under `nomination_export_dir()`
- `GET|POST /api/app-config` — read/write a **whitelist** of env keys for the settings UI (`ALLOWED_ENV_KEYS` in `app/services/env_config.py`)

**Nomination reporting & accuracy** (uploads, SQLite-backed runs and CSV blobs): endpoints under `/api/nomination-reporting/…` and `/api/nomination-accuracy/…` (runs list/delete, analytics monthly/month-detail/annual, compliance and market-result CSV storage, marketplace chart payload, RTD backfill, etc.). See `app/routes/__init__.py` for the full list.

**Billing**

- `POST /api/billing/settlement-extract` — master `.zip` + absolute `output_dir` + optional zip passwords
- `GET /api/billing/settlement-config`, `/api/billing/default-export-dir`, `/api/billing/user-export-shortcuts`
- `GET|POST|PATCH|DELETE /api/billing-history/…` — rows, display totals, PDF upload batch, row patch/delete

**Admin**

- `GET|POST|PATCH|DELETE /api/admin/users/…` — user CRUD (admin only; updates `users.json`)

## Environment

Copy **`.env.example`** to **`.env`**. The app loads `.env` on startup (`python-dotenv`).

| Variable | Notes |
|----------|--------|
| **`OPENAI_API_KEY`** | Primary weather; or one-line **`openai_api_key.txt`** in the project root (gitignored) |
| **`ACCUWEATHER_API_KEY`** | Optional fallback; or **`accuweather_api_key.txt`** |
| **`ARECO_PORT`** | Local dev port when `PORT` is unset (default **8765**). On PaaS, **`PORT`** is used |
| **`ARECO_SECRET_KEY`** | Flask session signing |
| **`ARECO_USERS_FILE`** | Optional path to `users.json` |
| **`ARECO_NOMINATION_EXPORT_DIR`** | Where nomination exports are written (default `automate/` under project root) |
| **`ARECO_SETTLEMENT_ZIP_PASSWORD1`** / **`ARECO_SETTLEMENT_ZIP_PASSWORD2`** | Optional; settlement extract (inner zip passwords) |

The in-app settings drawer can persist the keys listed in `ALLOWED_ENV_KEYS` into `.env` (admin only).

## Production

`requirements.txt` includes **gunicorn**. Example:

```bash
gunicorn -w 2 -b 0.0.0.0:8765 "app:create_app()"
```

Use a strong `ARECO_SECRET_KEY`, restrict network access, and replace default sample users.

## Development notes

- Keep **`templates/partials/_panel_nomination.html`** and **`static/js/nomination-dashboard.js`** aligned when changing nomination UI (the one-time splitter lives under `tools/extract_frontend.py` when `dashboard.html` was the full page).
- New top-level sections: extend **`templates/layouts/app.html`** and **`templates/components/app_sidebar.html`**, reuse **`components/ui_macros.html`** (`nav_tile`, `empty_state_card`, `page_hero`), and wire role access in **`app/auth.py`**.
- SQLite files under **`data/`** (`nomination_accuracy.sqlite3`, `billing_history.sqlite3`) are created at startup; treat them as runtime state alongside export JSON and weather cache.
