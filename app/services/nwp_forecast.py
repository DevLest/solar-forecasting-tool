"""
Free NWP forecast for the plant: NOAA GFS + ECMWF IFS open data -> hourly irradiance -> MW.

Both sources are free for commercial use (GFS: US public domain; ECMWF open data: CC BY 4.0,
attribution "ECMWF" required wherever the data is shown).

- GFS 0.25deg, hourly steps, fetched as tiny sub-region GRIB files from the NOMADS filter.
- ECMWF IFS 0.25deg, 3-hourly steps (global GRIB fields, ~35 MB per refresh), disaggregated to
  hourly with a clear-sky shape so each 3 h energy total is preserved.

Run manually:  python -m app.services.nwp_forecast
The API also refreshes in a background thread when the saved data is older than NWP_MAX_AGE_HOURS.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

from app.config import (
    DATA_DIR,
    LAT,
    LOCAL_UTC_OFFSET_HOURS,
    LON,
    PLANT_DC_MWP,
    PLANT_INVERTERS,
    PLANT_MAX_MW,
    PV_PERFORMANCE_RATIO,
)

NWP_DIR = os.path.join(DATA_DIR, "nwp")
LATEST_FILE = os.path.join(NWP_DIR, "latest.json")
INVERTERS_FILE = os.path.join(NWP_DIR, "inverters.json")
NWP_MAX_AGE_HOURS = 6
GFS_MAX_FH = 72
ECMWF_MAX_STEP = 60

# PV temperature model (generic crystalline silicon)
_TEMP_COEFF = -0.004  # per degC above 25
_NOCT = 45.0

_UA = {"User-Agent": "ARECO-Solar-Dashboard/1.0"}
_lock = threading.Lock()
_state = {"running": False, "started_at": None, "last_error": None}


# ---------------------------------------------------------------------------
# Solar geometry / clear sky / PV conversion
# ---------------------------------------------------------------------------

def _cos_zenith(t_utc: datetime, lat: float, lon: float) -> float:
    """NOAA low-precision solar position (good to ~0.5 deg; plenty for hourly energy)."""
    doy = t_utc.timetuple().tm_yday
    hour = t_utc.hour + t_utc.minute / 60 + t_utc.second / 3600
    g = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)
    decl = (
        0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    )
    eqtime = 229.18 * (
        0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
        - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g)
    )
    ha = math.radians((hour * 60 + eqtime + 4 * lon) / 4 - 180)
    la = math.radians(lat)
    return math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)


def clear_sky_ghi(t_utc: datetime, lat: float, lon: float) -> float:
    """Haurwitz clear-sky GHI in W/m2."""
    cz = _cos_zenith(t_utc, lat, lon)
    if cz <= 0.01:
        return 0.0
    return 1098.0 * cz * math.exp(-0.059 / cz)


def clear_sky_mean(start_utc: datetime, hours: float, lat: float, lon: float) -> float:
    """Mean clear-sky GHI over an interval (5-minute samples)."""
    n = max(1, int(round(hours * 12)))
    step = hours * 3600 / n
    return sum(
        clear_sky_ghi(start_utc + timedelta(seconds=step * (i + 0.5)), lat, lon) for i in range(n)
    ) / n


def ghi_to_mw(ghi: float, temp_c: float | None, performance_ratio: float | None = None) -> float:
    """Simple PV model: DC capacity x irradiance x performance ratio x temperature loss, AC-capped."""
    if ghi is None or ghi <= 0:
        return 0.0
    pr = PV_PERFORMANCE_RATIO if performance_ratio is None else performance_ratio
    t_air = 28.0 if temp_c is None else temp_c
    t_cell = t_air + ghi * (_NOCT - 20.0) / 800.0
    temp_factor = 1.0 + _TEMP_COEFF * (t_cell - 25.0)
    mw = PLANT_DC_MWP * (ghi / 1000.0) * pr * temp_factor
    return round(max(0.0, min(PLANT_MAX_MW, mw)), 3)


# ---------------------------------------------------------------------------
# GRIB helpers
# ---------------------------------------------------------------------------

def _eccodes():
    try:
        import eccodes  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError("Missing package: run  pip install eccodes ecmwf-opendata") from e
    return eccodes


def _iter_grib_point(data: bytes, lat: float, lon: float):
    """Yield (shortName, stepType, stepRange, value_at_nearest_gridpoint) for each GRIB message."""
    ec = _eccodes()
    pos = 0
    while True:
        pos = data.find(b"GRIB", pos)
        if pos < 0:
            return
        h = ec.codes_new_from_message(data[pos:])
        try:
            length = ec.codes_get(h, "totalLength")
            yield (
                ec.codes_get(h, "shortName"),
                ec.codes_get(h, "stepType"),
                str(ec.codes_get(h, "stepRange")),
                float(ec.codes_grib_find_nearest(h, lat, lon)[0]["value"]),
            )
        finally:
            ec.codes_release(h)
        pos += length


def _step_range(sr: str) -> tuple[int, int]:
    if "-" in sr:
        a, b = sr.split("-", 1)
        return int(a), int(b)
    return int(sr), int(sr)


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%MZ")


# ---------------------------------------------------------------------------
# GFS (NOMADS filter, hourly)
# ---------------------------------------------------------------------------

def _gfs_url(run: datetime, fh: int, lat: float, lon: float) -> str:
    return (
        "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25_1hr.pl?"
        f"dir=%2Fgfs.{run:%Y%m%d}%2F{run:%H}%2Fatmos&file=gfs.t{run:%H}z.pgrb2.0p25.f{fh:03d}"
        "&var_DSWRF=on&var_TCDC=on&var_TMP=on"
        "&lev_surface=on&lev_2_m_above_ground=on&lev_entire_atmosphere=on"
        f"&subregion=&toplat={lat + 0.5:.2f}&bottomlat={lat - 0.5:.2f}"
        f"&leftlon={lon - 0.5:.2f}&rightlon={lon + 0.5:.2f}"
    )


def _gfs_get(run: datetime, fh: int, lat: float, lon: float) -> bytes | None:
    try:
        req = urllib.request.Request(_gfs_url(run, fh, lat, lon), headers=_UA)
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
    except (urllib.error.URLError, OSError):
        return None
    return data if data[:4] == b"GRIB" else None


def fetch_gfs(lat: float, lon: float) -> dict:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    latest = now.replace(hour=(now.hour // 6) * 6)
    run = None
    for k in range(5):
        cand = latest - timedelta(hours=6 * k)
        # A cycle is usable once its last forecast hour we need has been published.
        if _gfs_get(cand, GFS_MAX_FH, lat, lon):
            run = cand
            break
    if run is None:
        raise RuntimeError("No complete GFS cycle found on NOMADS in the last 24 h")

    avg: dict[tuple[str, int, int], float] = {}
    temp: dict[int, float] = {}
    for fh in range(0, GFS_MAX_FH + 1):
        data = _gfs_get(run, fh, lat, lon)
        if data is None:
            time.sleep(1.0)
            data = _gfs_get(run, fh, lat, lon)
        if data is None:
            continue
        for name, stype, sr, val in _iter_grib_point(data, lat, lon):
            s, e = _step_range(sr)
            if name == "2t":
                temp[e] = val - 273.15
            elif stype == "avg" and name in ("sdswrf", "dswrf", "tcc"):
                avg[("ghi" if name != "tcc" else "tcc", s, e)] = val
        time.sleep(0.2)  # be polite to NOMADS

    def hour_mean(var: str, e: int) -> float | None:
        """GFS averages run from the last 6 h reset: avg(s..e). Recover the mean of hour (e-1, e)."""
        s = ((e - 1) // 6) * 6
        cur = avg.get((var, s, e))
        if cur is None:
            return None
        if e - 1 == s:
            return cur
        prev = avg.get((var, s, e - 1))
        if prev is None:
            return None
        return (e - s) * cur - (e - 1 - s) * prev

    hours = []
    for e in range(1, GFS_MAX_FH + 1):
        ghi = hour_mean("ghi", e)
        if ghi is None:
            continue
        cloud = hour_mean("tcc", e)
        t0, t1 = temp.get(e - 1), temp.get(e)
        t = (t0 + t1) / 2 if t0 is not None and t1 is not None else (t1 if t1 is not None else t0)
        hours.append({
            "start": _iso(run + timedelta(hours=e - 1)),
            "ghi": round(max(0.0, ghi), 1),
            "cloud": None if cloud is None else round(min(100.0, max(0.0, cloud)), 1),
            "temp_c": None if t is None else round(t, 1),
        })
    if not hours:
        raise RuntimeError("GFS download returned no usable hours")
    return {"run": _iso(run), "hours": hours}


# ---------------------------------------------------------------------------
# ECMWF IFS open data (3-hourly -> hourly)
# ---------------------------------------------------------------------------

def fetch_ecmwf(lat: float, lon: float) -> dict:
    try:
        from ecmwf.opendata import Client  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError("Missing package: run  pip install eccodes ecmwf-opendata") from e

    os.makedirs(NWP_DIR, exist_ok=True)
    fd, target = tempfile.mkstemp(suffix=".grib2", dir=NWP_DIR)
    os.close(fd)
    try:
        result = Client(source="ecmwf", model="ifs", resol="0p25").retrieve(
            type="fc",
            param=["ssrd", "tcc", "2t"],
            step=list(range(0, ECMWF_MAX_STEP + 1, 3)),
            target=target,
        )
        with open(target, "rb") as f:
            data = f.read()
    finally:
        try:
            os.remove(target)
        except OSError:
            pass

    run = result.datetime.replace(tzinfo=timezone.utc)
    ssrd: dict[int, float] = {}
    tcc: dict[int, float] = {}
    t2m: dict[int, float] = {}
    for name, _stype, sr, val in _iter_grib_point(data, lat, lon):
        _s, e = _step_range(sr)
        if name == "ssrd":
            ssrd[e] = val  # J/m2 accumulated since run start
        elif name == "tcc":
            tcc[e] = val * 100.0 if val <= 1.0 else val
        elif name == "2t":
            t2m[e] = val - 273.15

    def interp(series: dict[int, float], x: float) -> float | None:
        keys = sorted(series)
        lo = max((k for k in keys if k <= x), default=None)
        hi = min((k for k in keys if k >= x), default=None)
        if lo is None or hi is None:
            return None
        if lo == hi:
            return series[lo]
        return series[lo] + (series[hi] - series[lo]) * (x - lo) / (hi - lo)

    hours = []
    steps = sorted(ssrd)
    for a, b in zip(steps, steps[1:]):
        span = b - a
        ghi_int = max(0.0, (ssrd[b] - ssrd[a]) / (span * 3600.0))
        cs = [clear_sky_mean(run + timedelta(hours=a + i), 1.0, lat, lon) for i in range(span)]
        cs_int = sum(cs) / span
        kt = min(1.2, ghi_int / cs_int) if cs_int > 1.0 else 0.0
        for i in range(span):
            mid = a + i + 0.5
            cloud = interp(tcc, mid)
            t = interp(t2m, mid)
            hours.append({
                "start": _iso(run + timedelta(hours=a + i)),
                "ghi": round(kt * cs[i], 1),
                "cloud": None if cloud is None else round(min(100.0, max(0.0, cloud)), 1),
                "temp_c": None if t is None else round(t, 1),
            })
    if not hours:
        raise RuntimeError("ECMWF download returned no usable steps")
    return {"run": _iso(run), "hours": hours}


# ---------------------------------------------------------------------------
# Refresh + storage
# ---------------------------------------------------------------------------

def load_latest() -> dict | None:
    try:
        with open(LATEST_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def refresh_now(lat: float = None, lon: float = None) -> dict:
    """Download both models (each independently; one failing keeps the other) and save latest.json."""
    lat = LAT if lat is None else lat
    lon = LON if lon is None else lon
    previous = load_latest() or {}
    models = {}
    for key, fn in (("gfs", fetch_gfs), ("ecmwf", fetch_ecmwf)):
        try:
            models[key] = {"ok": True, "error": None, **fn(lat, lon)}
        except Exception as e:  # keep the last good run for this model
            old = (previous.get("models") or {}).get(key)
            if old and old.get("hours"):
                models[key] = {**old, "ok": False, "error": f"{e} (showing previous run)"}
            else:
                models[key] = {"ok": False, "error": str(e), "run": None, "hours": []}
    out = {
        "generated_at": _iso(datetime.now(timezone.utc)),
        "lat": lat,
        "lon": lon,
        "models": models,
    }
    os.makedirs(NWP_DIR, exist_ok=True)
    tmp = LATEST_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f)
    os.replace(tmp, LATEST_FILE)
    return out


def _refresh_worker():
    try:
        refresh_now()
        _state["last_error"] = None
    except Exception as e:
        _state["last_error"] = str(e)
    finally:
        _state["running"] = False


def refresh_async() -> bool:
    """Start a background refresh. Returns False if one is already running."""
    with _lock:
        if _state["running"]:
            return False
        _state["running"] = True
        _state["started_at"] = _iso(datetime.now(timezone.utc))
    threading.Thread(target=_refresh_worker, name="nwp-refresh", daemon=True).start()
    return True


def _is_stale(latest: dict | None) -> bool:
    if not latest or not latest.get("generated_at"):
        return True
    try:
        gen = datetime.strptime(latest["generated_at"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - gen > timedelta(hours=NWP_MAX_AGE_HOURS)


# ---------------------------------------------------------------------------
# Inverter availability (shared plant state; MW is scaled by available / installed in the UI)
# ---------------------------------------------------------------------------

def load_inverters() -> dict:
    try:
        with open(INVERTERS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, json.JSONDecodeError):
        saved = {}
    available = saved.get("available")
    if not isinstance(available, int) or not 0 <= available <= PLANT_INVERTERS:
        available = PLANT_INVERTERS
    return {
        "total": PLANT_INVERTERS,
        "available": available,
        "note": saved.get("note") or "",
        "updated_at": saved.get("updated_at"),
        "updated_by": saved.get("updated_by"),
    }


def save_inverters(available: int, note: str = "", updated_by: str | None = None) -> dict:
    if not 0 <= available <= PLANT_INVERTERS:
        raise ValueError(f"Available inverters must be between 0 and {PLANT_INVERTERS}")
    os.makedirs(NWP_DIR, exist_ok=True)
    tmp = INVERTERS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "available": available,
            "note": note.strip()[:200],
            "updated_at": _iso(datetime.now(timezone.utc)),
            "updated_by": updated_by,
        }, f)
    os.replace(tmp, INVERTERS_FILE)
    return load_inverters()


# ---------------------------------------------------------------------------
# Daily view (local time, hour-ending index 0..24 like the nomination curve)
# ---------------------------------------------------------------------------

def _hour_map(model: dict) -> dict[datetime, dict]:
    out = {}
    for h in model.get("hours") or []:
        t = datetime.strptime(h["start"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
        out[t] = h
    return out


def daily_view(target_date: str, latest: dict) -> dict:
    """
    25-slot arrays for ``target_date`` (local). Slot h = mean over the hour ENDING at h:00 local
    (slot 13 = 12:00-13:00). Slot 0 is the last hour of the previous day (always night).
    """
    lat, lon = latest.get("lat", LAT), latest.get("lon", LON)
    d = date.fromisoformat(target_date)
    local_midnight_utc = datetime(d.year, d.month, d.day, tzinfo=timezone.utc) - timedelta(
        hours=LOCAL_UTC_OFFSET_HOURS
    )
    starts = [local_midnight_utc + timedelta(hours=h - 1) for h in range(25)]
    clear = [round(clear_sky_mean(s, 1.0, lat, lon), 1) for s in starts]

    series = {}
    for key, model in (latest.get("models") or {}).items():
        hm = _hour_map(model)
        ghi, cloud, temp, mw = [], [], [], []
        covered = 0
        for s in starts:
            h = hm.get(s)
            if h is None:
                ghi.append(None); cloud.append(None); temp.append(None); mw.append(None)
                continue
            covered += 1
            ghi.append(h["ghi"]); cloud.append(h["cloud"]); temp.append(h["temp_c"])
            mw.append(ghi_to_mw(h["ghi"], h["temp_c"]))
        series[key] = {
            "run": model.get("run"),
            "ok": model.get("ok"),
            "error": model.get("error"),
            "complete": covered >= 24,
            "ghi": ghi,
            "cloud": cloud,
            "temp_c": temp,
            "mw": mw,
            "energy_mwh": round(sum(x for x in mw if x is not None), 2) if covered else None,
        }

    complete = [s for s in series.values() if s["complete"]]
    blend = None
    if complete:
        blend = [
            round(sum(s["mw"][i] for s in complete) / len(complete), 3) for i in range(25)
        ]
        blend[0] = 0.0
    return {
        "date": target_date,
        "clear_sky_ghi": clear,
        "clear_sky_mw": [ghi_to_mw(c, 25.0) for c in clear],
        "models": series,
        "blend_mw": blend,
        "blend_models": [k for k, s in series.items() if s["complete"]],
        "blend_energy_mwh": round(sum(blend), 2) if blend else None,
    }


def available_dates(latest: dict) -> list[str]:
    """Local dates fully covered (24 hours) by at least one model."""
    counts: dict[str, int] = {}
    for model in (latest.get("models") or {}).values():
        per_day: dict[str, int] = {}
        for t in _hour_map(model):
            # Hour-ending convention: the hour ending at 24:00 local still belongs to that day.
            end_local = t + timedelta(hours=1 + LOCAL_UTC_OFFSET_HOURS)
            day = (end_local - timedelta(minutes=1)).date().isoformat()
            per_day[day] = per_day.get(day, 0) + 1
        for day, n in per_day.items():
            counts[day] = max(counts.get(day, 0), n)
    return sorted(day for day, n in counts.items() if n >= 24)


def get_forecast_payload(target_date: str | None = None, auto_refresh: bool = True) -> dict:
    latest = load_latest()
    if auto_refresh and _is_stale(latest):
        refresh_async()
    status = {
        "refreshing": _state["running"],
        "refresh_started_at": _state["started_at"],
        "last_error": _state["last_error"],
    }
    if not latest:
        return {"ok": True, "has_data": False, "status": status, "inverters": load_inverters()}
    dates = available_dates(latest)
    if not target_date or target_date not in dates:
        tomorrow = (datetime.now(timezone.utc) + timedelta(hours=LOCAL_UTC_OFFSET_HOURS + 24)).date().isoformat()
        target_date = tomorrow if tomorrow in dates else (dates[-1] if dates else None)
    return {
        "ok": True,
        "has_data": True,
        "status": status,
        "generated_at": latest.get("generated_at"),
        "location": {"lat": latest.get("lat"), "lon": latest.get("lon")},
        "plant": {
            "dc_mwp": PLANT_DC_MWP,
            "performance_ratio": PV_PERFORMANCE_RATIO,
            "ac_max_mw": PLANT_MAX_MW,
            "utc_offset_hours": LOCAL_UTC_OFFSET_HOURS,
        },
        "inverters": load_inverters(),
        "dates": dates,
        "day": daily_view(target_date, latest) if target_date else None,
        "attribution": "Forecast data: ECMWF (CC BY 4.0) and NOAA GFS. Satellite: NASA GIBS / JMA Himawari.",
    }


if __name__ == "__main__":
    t0 = time.time()
    res = refresh_now()
    for k, m in res["models"].items():
        print(f"{k}: run={m.get('run')} hours={len(m.get('hours') or [])} error={m.get('error')}")
    payload = get_forecast_payload(auto_refresh=False)
    day = payload.get("day") or {}
    print("dates:", payload.get("dates"))
    print("day:", day.get("date"), "blend MWh:", day.get("blend_energy_mwh"), "blend:", day.get("blend_mw"))
    print(f"done in {time.time() - t0:.0f}s")
