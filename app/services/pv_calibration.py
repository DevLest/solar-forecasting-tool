"""
Calibrate ``ARECO_PV_PERFORMANCE_RATIO`` from the plant's actual output.

Actual output: hourly ``actual_mwh`` saved in nomination-accuracy runs, plus 5-minute
``Actual Output`` from stored MPI compliance CSVs (rolled up to hour-ending means).
Irradiance: NASA POWER hourly GHI + 2 m temperature (satellite/reanalysis, free, no key).

The ratio is chosen to minimise mean absolute error of the same PV model the forecast uses
(``nwp_forecast.ghi_to_mw``), including the AC cap, so clipped hours are handled and
curtailed/outage hours have little pull. Note it absorbs DC-size error too: only
DC_MWp x PR matters, so a wrong ``ARECO_PLANT_DC_MWP`` is corrected here.

Run:  python -m app.services.pv_calibration            (report only)
      python -m app.services.pv_calibration --write    (also save the ratio to .env)
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import sys
import urllib.request
from datetime import date, datetime, timedelta

from app.config import (
    DATA_DIR,
    LAT,
    LOCAL_UTC_OFFSET_HOURS,
    LON,
    PLANT_DC_MWP,
    PV_PERFORMANCE_RATIO,
)
from app.services.nwp_forecast import ghi_to_mw

ACCURACY_DB = f"{DATA_DIR}/nomination_accuracy.sqlite3"
MIN_GHI = 50.0  # W/m2; skip night and the first/last minutes of daylight
_UA = {"User-Agent": "ARECO-Solar-Dashboard/1.0"}


def load_actual_hourly(db_path: str = ACCURACY_DB) -> dict[tuple[str, int], float]:
    """(local date, hour-ending 1..24) -> mean actual MW."""
    out: dict[tuple[str, int], float] = {}
    con = sqlite3.connect(db_path)
    try:
        for day, aj in con.execute(
            "SELECT compliance_day, analytics_json FROM nomination_accuracy_run ORDER BY id"
        ):
            try:
                hours = json.loads(aj).get("hourly_mwh") or []
            except (TypeError, json.JSONDecodeError):
                continue
            for h in hours:
                if h.get("actual_mwh") is not None and h.get("hour"):
                    out[(day, int(h["hour"]))] = float(h["actual_mwh"])
        for _day, blob in con.execute("SELECT compliance_day, csv_blob FROM nomination_compliance_csv"):
            buckets: dict[tuple[str, int], list[float]] = {}
            for row in list(csv.reader(io.StringIO(blob.decode("utf-8-sig", errors="replace"))))[1:]:
                try:
                    end = datetime.strptime(row[0].strip(), "%m/%d/%Y %H:%M")
                    mw = float(row[3])
                except (IndexError, ValueError):
                    continue
                t = end - timedelta(minutes=1)  # interval ending 13:00 belongs to hour-ending 13
                buckets.setdefault((t.date().isoformat(), t.hour + 1), []).append(mw)
            for key, vals in buckets.items():
                if len(vals) >= 11 and key not in out:  # nearly complete hour only
                    out[key] = sum(vals) / len(vals)
    finally:
        con.close()
    return out


def fetch_power(start: date, end: date, lat: float = LAT, lon: float = LON) -> dict[str, dict[str, float]]:
    """NASA POWER hourly (UTC). Key YYYYMMDDHH = mean over the hour STARTING at HH UTC."""
    url = (
        "https://power.larc.nasa.gov/api/temporal/hourly/point"
        "?parameters=ALLSKY_SFC_SW_DWN,T2M&community=RE&format=JSON&time-standard=UTC"
        f"&latitude={lat}&longitude={lon}&start={start:%Y%m%d}&end={end:%Y%m%d}"
    )
    with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=120) as resp:
        return json.loads(resp.read().decode())["properties"]["parameter"]


def build_samples(actual: dict, power: dict) -> list[dict]:
    ghi, temp = power["ALLSKY_SFC_SW_DWN"], power["T2M"]
    samples = []
    for (day, he), mw in sorted(actual.items()):
        d = date.fromisoformat(day)
        start_utc = datetime(d.year, d.month, d.day) + timedelta(hours=he - 1 - LOCAL_UTC_OFFSET_HOURS)
        key = start_utc.strftime("%Y%m%d%H")
        g, t = ghi.get(key), temp.get(key)
        if g is None or t is None or g < 0 or t < -100 or g < MIN_GHI:
            continue
        samples.append({"day": day, "he": he, "actual": mw, "ghi": g, "temp_c": t})
    return samples


def _mae(samples: list[dict], pr: float) -> float:
    return sum(abs(s["actual"] - ghi_to_mw(s["ghi"], s["temp_c"], pr)) for s in samples) / len(samples)


def _bias(samples: list[dict], pr: float) -> float:
    return sum(ghi_to_mw(s["ghi"], s["temp_c"], pr) - s["actual"] for s in samples) / len(samples)


def fit_ratio(samples: list[dict], lo: float = 0.50, hi: float = 1.40, step: float = 0.005) -> float:
    best, best_err = lo, float("inf")
    n = int(round((hi - lo) / step))
    for i in range(n + 1):
        pr = lo + i * step
        err = _mae(samples, pr)
        if err < best_err:
            best, best_err = pr, err
    return round(best, 3)


def calibrate() -> dict:
    actual = load_actual_hourly()
    if not actual:
        raise RuntimeError("No actual output found (upload MQ / compliance files in Forecast % error first)")
    days = sorted({d for d, _ in actual})
    start = date.fromisoformat(days[0]) - timedelta(days=1)
    end = date.fromisoformat(days[-1])
    samples = build_samples(actual, fetch_power(start, end))
    if len(samples) < 100:
        raise RuntimeError(f"Only {len(samples)} usable daylight hours; need at least 100")

    sample_days = sorted({s["day"] for s in samples})
    pr = fit_ratio(samples)

    # Out-of-sample check: fit on the earlier 75% of days, score the latest 25%.
    cut = sample_days[int(len(sample_days) * 0.75)]
    train = [s for s in samples if s["day"] < cut]
    test = [s for s in samples if s["day"] >= cut]
    pr_train = fit_ratio(train)

    by_month: dict[str, list[dict]] = {}
    for s in samples:
        by_month.setdefault(s["day"][:7], []).append(s)

    return {
        "ratio": pr,
        "current_ratio": PV_PERFORMANCE_RATIO,
        "dc_mwp": PLANT_DC_MWP,
        "days": len(sample_days),
        "first_day": sample_days[0],
        "last_day": sample_days[-1],
        "hours": len(samples),
        "mae_current": round(_mae(samples, PV_PERFORMANCE_RATIO), 2),
        "mae_fitted": round(_mae(samples, pr), 2),
        "bias_current": round(_bias(samples, PV_PERFORMANCE_RATIO), 2),
        "bias_fitted": round(_bias(samples, pr), 2),
        "holdout": {
            "train_days": len({s["day"] for s in train}),
            "test_days": len({s["day"] for s in test}),
            "ratio_from_train": pr_train,
            "test_mae_current": round(_mae(test, PV_PERFORMANCE_RATIO), 2),
            "test_mae_train_fit": round(_mae(test, pr_train), 2),
        },
        "by_month": {
            m: {"hours": len(v), "ratio": fit_ratio(v)} for m, v in sorted(by_month.items())
        },
    }


if __name__ == "__main__":
    res = calibrate()
    h = res["holdout"]
    print(f"Data: {res['days']} days ({res['first_day']} .. {res['last_day']}), {res['hours']} daylight hours")
    print(f"Fitted performance ratio: {res['ratio']}  (current {res['current_ratio']}, DC {res['dc_mwp']} MWp)")
    print(f"Hourly MAE: {res['mae_current']} MW -> {res['mae_fitted']} MW;"
          f" mean bias {res['bias_current']:+} MW -> {res['bias_fitted']:+} MW")
    print(f"Hold-out ({h['test_days']} latest days, fit on {h['train_days']} earlier days):"
          f" ratio {h['ratio_from_train']}, MAE {h['test_mae_current']} -> {h['test_mae_train_fit']} MW")
    for m, v in res["by_month"].items():
        print(f"  {m}: ratio {v['ratio']}  ({v['hours']} h)")
    if "--write" in sys.argv:
        from app.services.env_config import merge_env_updates

        merge_env_updates({"ARECO_PV_PERFORMANCE_RATIO": str(res["ratio"])})
        print(f"Saved ARECO_PV_PERFORMANCE_RATIO={res['ratio']} to .env (restart the app to apply).")
