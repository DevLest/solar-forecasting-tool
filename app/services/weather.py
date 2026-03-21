"""Weather forecast service (OpenAI + fallbacks, daily cache)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import date

from app.config import (
    ACCUWEATHER_KEY_FILE,
    CACHE_PREFIX,
    DATA_DIR,
    KEY_FILE,
    LAT,
    LON,
    PLANT_MAX_MW,
)

def get_openai_key():
    k = os.environ.get("OPENAI_API_KEY", "").strip()
    if k:
        return k
    if os.path.isfile(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            line = f.readline().strip()
            if line and not line.startswith("#"):
                return line
    return ""


def get_accuweather_key():
    k = os.environ.get("ACCUWEATHER_API_KEY", "").strip()
    if k:
        return k
    try:
        if os.path.isfile(ACCUWEATHER_KEY_FILE):
            with open(ACCUWEATHER_KEY_FILE, encoding="utf-8") as f:
                line = f.readline().strip().strip("\ufeff")
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return ""


def _http_get_json(url: str, timeout: int = 25):
    req = urllib.request.Request(url, headers={"User-Agent": "ARECO-Solar-Dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _http_get_text(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "ARECO-Solar-Dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode(errors="replace")[:8000]


def gather_multi_source_weather(target_date: str, lat: float = None, lon: float = None) -> str:
    """Pull from several free endpoints (no OpenAI tokens). Returns compact text for the model."""
    lat, lon = lat if lat is not None else LAT, lon if lon is not None else LON
    tz = "auto"
    chunks = []
    # 1) Open-Meteo — hourly cloud + radiation (auto timezone from coordinates)
    try:
        om = _http_get_json(
            f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
            f"&hourly=temperature_2m,cloud_cover,shortwave_radiation,precipitation_probability"
            f"&daily=weathercode,precipitation_sum,cloud_cover_mean"
            f"&forecast_days=3&timezone={tz}"
        )
        chunks.append("=== Source: Open-Meteo (api.open-meteo.com) ===\n" + json.dumps(om)[:6000])
    except Exception as e:
        chunks.append(f"=== Open-Meteo: unavailable ({e}) ===")

    # 2) wttr.in — different backend (edge cache)
    try:
        w = _http_get_text(
            f"https://wttr.in/{lat},{lon}?format=j1"
        )
        chunks.append("=== Source: wttr.in ===\n" + w[:4000])
    except Exception as e:
        chunks.append(f"=== wttr.in: unavailable ({e}) ===")

    # 3) Open-Meteo second model (ECMWF) for divergence check
    try:
        om2 = _http_get_json(
            f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
            f"&models=ecmwf_ifs025&hourly=cloud_cover,precipitation"
            f"&forecast_days=2&timezone={tz}"
        )
        chunks.append("=== Source: Open-Meteo ECMWF model ===\n" + json.dumps(om2)[:3500])
    except Exception as e:
        chunks.append(f"=== Open-Meteo ECMWF: unavailable ({e}) ===")

    # 4) Optional AccuWeather (free tier, requires API key from developer.accuweather.com)
    ak = get_accuweather_key()
    if ak:
        try:
            loc_url = (
                f"https://dataservice.accuweather.com/locations/v1/cities/geoposition/search"
                f"?apikey={ak}&q={lat}%2C{lon}"
            )
            loc = _http_get_json(loc_url)
            loc_key = loc.get("Key")
            if loc_key:
                fc = _http_get_json(
                    f"https://dataservice.accuweather.com/forecasts/v1/hourly/24hour/{loc_key}"
                    f"?apikey={ak}&details=true&metric=true"
                )
                chunks.append("=== Source: AccuWeather (optional) ===\n" + json.dumps(fc)[:4000])
        except Exception as e:
            chunks.append(f"=== AccuWeather: unavailable ({e}) ===")

    return "\n\n".join(chunks)


def fallback_weather_from_open_meteo(target_date: str, lat: float = None, lon: float = None) -> dict:
    """
    Free fallback when OpenAI fails or no key: derive hourly_mw from Open-Meteo only (no API key).
    Uses cloud_cover and shortwave_radiation to scale a 50 MW cap curve.
    """
    lat, lon = lat if lat is not None else LAT, lon if lon is not None else LON
    try:
        om = _http_get_json(
            f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
            f"&hourly=temperature_2m,cloud_cover,shortwave_radiation,precipitation_probability"
            f"&forecast_days=3&timezone=auto"
        )
    except Exception as e:
        return {"error": f"Open-Meteo fallback failed: {e}"}

    hourly_mw = [0.0] * 25
    h_times = om.get("hourly", {}).get("time") or []
    h_cloud = om.get("hourly", {}).get("cloud_cover") or []
    h_rad = om.get("hourly", {}).get("shortwave_radiation", [])
    if not h_times:
        return {"error": "Open-Meteo: no hourly data"}

    # Typical clear-sky relative curve (hour 0–24, ~0 at night, peak at 12)
    clear_sky = [
        0, 0, 0, 0, 0, 0, 0.1, 0.25, 0.45, 0.65, 0.82, 0.95, 1.0, 0.95, 0.82, 0.65, 0.45, 0.25, 0.1, 0, 0, 0, 0, 0, 0,
    ]
    max_rad = 1000.0  # W/m² approx max

    for i, t in enumerate(h_times):
        if not isinstance(t, str) or target_date not in t:
            continue
        try:
            hour = int(t.split("T")[1][:2])
        except (IndexError, ValueError):
            continue
        if hour < 0 or hour > 24:
            continue
        cloud = h_cloud[i] if i < len(h_cloud) else 50
        if cloud is None:
            cloud = 50
        rad = h_rad[i] if i < len(h_rad) else None
        if rad is not None and max_rad > 0:
            factor = (1.0 - cloud / 100.0) * min(1.0, rad / max_rad) * clear_sky[hour]
        else:
            factor = (1.0 - cloud / 100.0) * clear_sky[hour]
        mw = max(0.0, min(PLANT_MAX_MW, factor * PLANT_MAX_MW))
        hourly_mw[hour] = round(mw, 3)

    return {
        "hourly_mw": hourly_mw,
        "summary": "Fallback: Open-Meteo only (no OpenAI). Values from cloud cover and radiation.",
        "date": target_date,
        "source": "open_meteo_fallback",
    }


def fallback_weather_from_accuweather(target_date: str, lat: float = None, lon: float = None):
    """
    When OpenAI fails and AccuWeather API key is set: derive hourly_mw from AccuWeather 24h hourly.
    Returns None if no key or request fails. Never raises.
    """
    lat, lon = lat if lat is not None else LAT, lon if lon is not None else LON
    try:
        ak = get_accuweather_key().strip()
        if not ak:
            return None
        loc = _http_get_json(
            f"https://dataservice.accuweather.com/locations/v1/cities/geoposition/search"
            f"?apikey={ak}&q={lat}%2C{lon}",
            timeout=15,
        )
        if not isinstance(loc, dict):
            return None
        loc_key = loc.get("Key")
        if not loc_key:
            return None
        fc = _http_get_json(
            f"https://dataservice.accuweather.com/forecasts/v1/hourly/24hour/{loc_key}"
            f"?apikey={ak}&details=true&metric=true",
            timeout=15,
        )
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, json.JSONDecodeError, KeyError, TypeError, Exception):
        return None
    if not isinstance(fc, list):
        return None
    clear_sky = [
        0, 0, 0, 0, 0, 0, 0.1, 0.25, 0.45, 0.65, 0.82, 0.95, 1.0, 0.95, 0.82, 0.65, 0.45, 0.25, 0.1, 0, 0, 0, 0, 0, 0,
    ]
    hourly_mw = [0.0] * 25
    for i, h in enumerate(fc):
        if i >= 25:
            break
        cloud = 50
        if isinstance(h, dict) and h.get("CloudCover") is not None:
            try:
                cloud = int(h["CloudCover"])
            except (TypeError, ValueError):
                pass
        cloud = min(100, max(0, cloud))
        factor = (1.0 - cloud / 100.0) * clear_sky[i]
        hourly_mw[i] = round(max(0.0, min(PLANT_MAX_MW, factor * PLANT_MAX_MW)), 3)
    return {
        "hourly_mw": hourly_mw,
        "summary": "Fallback: AccuWeather only (OpenAI failed). Values from hourly cloud cover.",
        "date": target_date,
        "source": "accuweather_fallback",
    }


def cache_path_for(target_date: str, lat: float = None, lon: float = None) -> str:
    lat, lon = lat if lat is not None else LAT, lon if lon is not None else LON
    slug = f"{target_date}_{lat:.4f}_{lon:.4f}".replace(".", "_")
    return os.path.join(DATA_DIR, f"{CACHE_PREFIX}{slug}.json")


def openai_weather_forecast(target_date: str, weather_digest: str) -> dict:
    api_key = get_openai_key()
    if not api_key:
        return {"error": "Missing API key. Set OPENAI_API_KEY in .env (see .env.example) or create openai_api_key.txt"}

    cap = int(PLANT_MAX_MW)
    system = (
        f"You are a solar forecasting assistant for a {cap} MW AC-limited solar plant (ARECO). "
        "The user message includes RAW weather-style data aggregated from multiple public sources "
        "(Open-Meteo, wttr.in, ECMWF via Open-Meteo). You do NOT browse the web; use ONLY that pasted data "
        "to infer cloud cover, rain risk, and irradiance trends for the given date.\n"
        "Respond with ONLY valid JSON (no markdown):\n"
        '{"hourly_mw": [25 numbers], "summary": "one sentence"}\n'
        f"hourly_mw: exactly 25 values for hours 0–24 local time, estimated AC power in MW. "
        f"NIGHT (~18:00–05:00): near 0. Daytime: shape like solar curve. "
        f"STRICT: every value MUST be >= 0 and <= {cap}. Never output above {cap} — the plant cannot accept more."
    )
    user = (
        f"Forecast date (local): {target_date}. "
        "From the hourly time arrays below, use only hours that fall on that calendar date.\n\n"
        "Multi-source weather snapshot:\n\n"
        f"{weather_digest[:28000]}"
    )

    body = json.dumps(
        {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.35,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err = e.read().decode(errors="replace")
        return {"error": f"OpenAI HTTP {e.code}: {err[:500]}"}
    except Exception as e:
        return {"error": str(e)}

    try:
        content = out["choices"][0]["message"]["content"]
        parsed = json.loads(content)
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        return {"error": f"Bad OpenAI response: {e}"}

    hourly = parsed.get("hourly_mw") or parsed.get("hourly")
    if not isinstance(hourly, list) or len(hourly) < 25:
        return {"error": "Response missing hourly_mw array of 25 values"}

    hourly = [max(0.0, min(PLANT_MAX_MW, float(x))) for x in hourly[:25]]
    while len(hourly) < 25:
        hourly.append(0.0)
    return {
        "hourly_mw": hourly,
        "summary": str(parsed.get("summary", "")),
        "date": target_date,
    }


def get_weather_forecast(target_date: str, force_refresh: bool = False, lat: float = None, lon: float = None) -> dict:
    """
    At most one OpenAI call per calendar day per date key (and per location).
    Always pulls fresh multi-source HTTP data when calling OpenAI (same day refresh still uses cache unless force).
    """
    lat, lon = (float(lat), float(lon)) if lat is not None and lon is not None else (LAT, LON)
    path = cache_path_for(target_date, lat, lon)
    if not force_refresh and os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                cached = json.load(f)
            cached["from_cache"] = True
            cached["openai_calls_today"] = 0
            cached["message"] = (
                "Served from daily cache — OpenAI was not called again (1 API use max per day for this date)."
            )
            return cached
        except (json.JSONDecodeError, OSError):
            pass

    digest = gather_multi_source_weather(target_date, lat, lon)
    result = openai_weather_forecast(target_date, digest)
    if "error" in result:
        openai_err = result.get("error", "")
        result = None
        # Fallback 1: AccuWeather (when key is set)
        if get_accuweather_key():
            try:
                print("Weather: OpenAI failed, trying AccuWeather fallback...")
                result = fallback_weather_from_accuweather(target_date, lat, lon)
                if result:
                    print("Weather: AccuWeather fallback OK.")
            except Exception as e:
                print(f"Weather: AccuWeather fallback error: {e}")
                result = None
        if result is None or (isinstance(result, dict) and "error" in result):
            try:
                if result is None:
                    print("Weather: trying Open-Meteo fallback...")
                result = fallback_weather_from_open_meteo(target_date, lat, lon)
                if result and "error" not in result:
                    print("Weather: Open-Meteo fallback OK.")
            except Exception as e:
                print(f"Weather: Open-Meteo fallback error: {e}")
                result = {"error": "Open-Meteo fallback failed."}
        if result is None:
            result = {"error": "Fallbacks failed. " + openai_err}
        if "error" in result:
            return result
        result["message"] = (
            "OpenAI failed or no key — used "
            + ("AccuWeather" if result.get("source") == "accuweather_fallback" else "Open-Meteo")
            + " fallback (50 MW cap)."
        )
        result["from_cache"] = False
        result["openai_calls_today"] = 0
        os.makedirs(DATA_DIR, exist_ok=True)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=0)
        except OSError:
            pass
        return result

    result["from_cache"] = False
    result["openai_calls_today"] = 1
    result["message"] = (
        "Forecast generated using Open-Meteo + wttr.in + ECMWF data, then one ChatGPT request. "
        f"Capped at {int(PLANT_MAX_MW)} MW."
    )
    os.makedirs(DATA_DIR, exist_ok=True)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=0)
    except OSError:
        pass
    return result