# ARECO 65 MW Solar — Operations

WESM nomination tooling with weather integration, export history, and a placeholder **Billing & Invoice** section.

## Run

```bash
python -m pip install -r requirements.txt
python run_dashboard.py
```

Open **http://127.0.0.1:8765/** (or use `Automation.bat` / `run.sh` — they install dependencies and start the app).

## Architecture

| Area | Purpose |
|------|--------|
| **`app/`** | Flask application (`create_app()`), config, HTTP + JSON API |
| **`app/services/`** | Weather forecast (OpenAI + fallbacks, daily cache), historical exports |
| **`templates/layouts/`** | Page shells (`app.html`) |
| **`templates/components/`** | Global UI: header, sidebar, footer, modal, `ui_macros.html` |
| **`templates/pages/`** | Concrete pages (`home.html`) |
| **`templates/partials/`** | Large feature fragments (nomination panel) |
| **`static/css/`** | Shared styles (`areco-brand.css`) |
| **`static/js/`** | `app-shell.js` (nav + modal), `nomination-dashboard.js` (nomination logic) |
| **`assets/`** | Icons (served at `/assets/...`) |
| **`data/`** | Runtime JSON (gitignored): exports, weather cache |

Legacy **`dashboard.html`** is only a short note if you open it from disk; the real UI is rendered from templates.

### API (unchanged contract)

- `GET /api/historical-exports`
- `POST /api/save-export`
- `POST /api/weather-forecast` — body: `{ "date": "YYYY-MM-DD", "lat", "lon", "force_refresh" }`

### Environment

- `OPENAI_API_KEY` or `openai_api_key.txt`
- Optional: `ACCUWEATHER_API_KEY` or `accuweather_api_key.txt`
- `ARECO_PORT` — override default `8765`

## Development notes

- After editing nomination markup or the monolithic extract source, keep **`templates/partials/_panel_nomination.html`** and **`static/js/nomination-dashboard.js`** in sync (the one-time splitter lived under `tools/extract_frontend.py` when `dashboard.html` was the full page).
- Add new top-level sections by extending **`templates/layouts/app.html`**, reusing **`components/ui_macros.html`** (`nav_tile`, `empty_state_card`, `page_hero`).
