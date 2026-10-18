"""
System Operator (NGCP) advisories from IEMOP's public real-time market dashboard (Power BI
"publish to web" report, "SO Advisories" page), plus a per-grid alert status derived from them.

The report's public query endpoint is what the Power BI web viewer itself calls. It is not a
documented API, so the report structure is re-read periodically and every failure degrades to
the last good result with an error flag instead of raising.

Alert levels (NGCP):
- NORMAL (white): supply sufficient, reserves available.
- BLUE: precaution; typhoon/calamity expected within ~24 h that may affect plants or lines.
- YELLOW: operating margin below the grid's contingency requirement; supply still meets demand.
- RED: supply insufficient for demand + regulating requirement; manual load dropping (rotating brownouts).
"""
from __future__ import annotations

import gzip
import json
import re
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

from app.config import LOCAL_UTC_OFFSET_HOURS

REPORT_URL = (
    "https://app.powerbi.com/view?r=eyJrIjoiMDNhODA2OTUtNWFlMy00NTYwLWE4NzktNTA4YThhMzE0NDhmIiwidCI6"
    "IjgzNzQzZGUwLWVhMDUtNGI0Mi1iYjMzLWM5YTVjMzNjYjI2YSIsImMiOjEwfQ%3D%3D"
)
_RESOURCE_KEY = "03a80695-5ae3-4560-a879-508a8a31448f"
_API = "https://wabi-south-east-asia-b-primary-api.analysis.windows.net/public/reports"
_PAGE_NAME = "SO Advisories"

CACHE_SECONDS = 30
_META_SECONDS = 6 * 3600
_HISTORY_HOURS = 36

REGIONS = {"CLUZ": "Luzon", "CVIS": "Visayas", "CMIN": "Mindanao"}
PLANT_REGION = "Visayas"
LEVELS = ("NORMAL", "BLUE", "YELLOW", "RED")  # ascending severity

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "payload": None}
_meta: dict = {"at": 0.0, "value": None}
# (advisory time, text) -> local time this process first saw it. IEMOP publishes in batches up to
# an hour after the advisory time, so "new" is judged by first-seen, not by the advisory timestamp.
# Advisories already present at startup get None (not new).
_first_seen: dict[tuple, datetime | None] = {}


# ---------------------------------------------------------------------------
# Power BI access
# ---------------------------------------------------------------------------

def _request(url: str, body: dict | None = None) -> dict:
    headers = {"X-PowerBI-ResourceKey": _RESOURCE_KEY, "User-Agent": "ARECO-Solar-Dashboard/1.0"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def _report_meta(force: bool = False) -> dict:
    """Model id, dataset id, report id and the SO Advisories table query, cached for hours."""
    if not force and _meta["value"] and time.time() - _meta["at"] < _META_SECONDS:
        return _meta["value"]
    j = _request(f"{_API}/{_RESOURCE_KEY}/modelsAndExploration?preferReadOnlySession=true")
    model = j["models"][0]
    section = next(s for s in j["exploration"]["sections"] if s.get("displayName") == _PAGE_NAME)
    for vc in section["visualContainers"]:
        cfg = json.loads(vc["config"])
        sv = cfg.get("singleVisual") or {}
        if sv.get("visualType") == "tableEx" and sv.get("prototypeQuery"):
            break
    else:
        raise RuntimeError("SO Advisories table not found in the IEMOP report")
    report = j["exploration"].get("report") or {}
    meta = {
        "model_id": model["id"],
        "dataset_id": model["dbName"],
        "report_id": report.get("objectId"),
        "visual_id": cfg.get("name"),
        "query": sv["prototypeQuery"],
    }
    _meta.update(at=time.time(), value=meta)
    return meta


def _decode_dsr(ds: dict, ncols: int) -> list[list]:
    """Expand Power BI's compressed rows: R = columns repeated from previous row, Ø = null columns."""
    dicts = ds.get("ValueDicts") or {}
    first = ds["PH"][0]["DM0"]
    col_dicts = [s.get("DN") for s in (first[0].get("S") or [])] if first else []
    out, prev = [], [None] * ncols
    for row in first:
        vals = list(row.get("C", []))
        rep, nul = row.get("R", 0), row.get("Ø", 0)
        cur = []
        for i in range(ncols):
            if rep >> i & 1:
                cur.append(prev[i])
            elif nul >> i & 1:
                cur.append(None)
            else:
                v = vals.pop(0) if vals else None
                dn = col_dicts[i] if i < len(col_dicts) else None
                if dn and isinstance(v, int):
                    v = dicts[dn][v]
                cur.append(v)
        prev = cur
        out.append(cur)
    return out


def _query_rows(meta: dict, count: int = 400) -> list[dict]:
    q = meta["query"]
    names = [s["Name"].split(".")[-1] for s in q["Select"]]
    body = {
        "version": "1.0.0",
        "queries": [{
            "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {
                "Query": q,
                "Binding": {
                    "Primary": {"Groupings": [{"Projections": list(range(len(names)))}]},
                    "DataReduction": {"DataVolume": 3, "Primary": {"Window": {"Count": count}}},
                    "Version": 1,
                },
            }}]},
            "QueryId": "",
            "ApplicationContext": {
                "DatasetId": meta["dataset_id"],
                "Sources": [{"ReportId": meta["report_id"], "VisualId": meta["visual_id"]}],
            },
        }],
        "cancelQueries": [],
        "modelId": meta["model_id"],
    }
    res = _request(f"{_API}/querydata?synchronous=true", body)
    ds = res["results"][0]["result"]["data"]["dsr"]["DS"][0]
    return [dict(zip(names, r)) for r in _decode_dsr(ds, len(names))]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_PREFIX = re.compile(r"^(?:\[[^\]]+\]\s*)?\w+\s+Grid-\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}:\s*")
_NOTICE = re.compile(r"\b(?:is|on)\s+(?:on\s+)?(RED|YELLOW|BLUE)\s+Alert\s+for\s+the\s+interval\s+hours\s+(\d{4})H?\s*-\s*(\d{4})H?", re.I)
_LIFTED = re.compile(r"\b(RED|YELLOW|BLUE)\s+Alert\b.*\blifted\b(?:.*?effective\s+(\d{4})H?)?", re.I)
_CONDITION = re.compile(r"System Condition:\s*(NORMAL|(?:RED|YELLOW|BLUE|WHITE)\s+ALERT)", re.I)
_CAP = re.compile(r"\bCAP=(\d+)\s*MW", re.I)
_PEAK = re.compile(r"\bPK=(\d+)\s*MW", re.I)


def _level(word: str) -> str:
    w = word.upper().replace(" ALERT", "").strip()
    return "NORMAL" if w in ("NORMAL", "WHITE") else w


def _parse_item(row: dict) -> dict | None:
    ms = row.get("TIME_MESSAGE")
    text = (row.get("MESSAGE") or "").strip()
    if ms is None or not text:
        return None
    # Power BI stores the local wall-clock time as if it were UTC.
    t = datetime.fromtimestamp(ms / 1000, timezone.utc).replace(tzinfo=None)
    region = REGIONS.get((row.get("REGION") or "").upper(), row.get("REGION") or "")
    clean = _PREFIX.sub("", text).replace("[WEBSMS]", "").strip()
    clean = re.sub(r"\s{2,}", " ", clean)
    item = {"time": t, "region": region, "text": clean, "kind": "info", "level": None, "nso": "[NSO Advisory]" in text}
    m = _NOTICE.search(text)
    if m:
        item.update(kind="alert_notice", level=m.group(1).upper(), start=m.group(2), end=m.group(3))
        return item
    m = _LIFTED.search(text)
    if m:
        item.update(kind="alert_lifted", level=m.group(1).upper(), lifted_at=m.group(2))
        return item
    m = _CONDITION.search(text)
    if m:
        item.update(kind="grid_update", level=_level(m.group(1)))
        cap, pk = _CAP.search(text), _PEAK.search(text)
        item["capacity_mw"] = int(cap.group(1)) if cap else None
        item["peak_mw"] = int(pk.group(1)) if pk else None
        return item
    if "(Unplanned Outage)" in text or "tripped" in text.lower():
        item["kind"] = "outage_unplanned"
    elif "(Planned Outage)" in text:
        item["kind"] = "outage_planned"
    return item


def _hhmm(day: datetime, s: str) -> datetime:
    return day.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=int(s[:2]), minutes=int(s[2:]))


def region_status(items: list[dict], region: str, now: datetime) -> dict:
    """Current alert status for one grid from today's notices, lifts and grid updates."""
    today = now.date()
    # Notices/lifts: last 24 h so a 2200H-0100H window survives midnight. Grid updates: today only.
    mine = [i for i in items if i["region"] == region and i["time"] > now - timedelta(hours=24)]
    lifts = [i for i in mine if i["kind"] == "alert_lifted"]

    def lifted_after(t: datetime) -> dict | None:
        later = [x for x in lifts if x["time"] > t]
        return max(later, key=lambda x: x["time"]) if later else None

    best = None
    for n in (i for i in mine if i["kind"] == "alert_notice"):
        if lifted_after(n["time"]):
            continue
        start, end = _hhmm(n["time"], n["start"]), _hhmm(n["time"], n["end"])
        if end <= start:
            end += timedelta(days=1)
        if now >= end:
            continue
        state = "active" if now >= start else "upcoming"
        cand = {"level": n["level"], "state": state, "window": f"{n['start'][:2]}:{n['start'][2:]}–{n['end'][:2]}:{n['end'][2:]}",
                "since": n["time"]}
        rank = (LEVELS.index(cand["level"]), state == "active", n["time"])
        if best is None or rank > best[0]:
            best = (rank, cand)

    updates = sorted(
        (i for i in mine if i["kind"] == "grid_update" and i["time"].date() == today), key=lambda x: x["time"]
    )
    last_update = updates[-1] if updates else None
    info = {"region": region, "is_plant_grid": region == PLANT_REGION,
            "capacity_mw": last_update.get("capacity_mw") if last_update else None,
            "peak_mw": last_update.get("peak_mw") if last_update else None,
            "updated": last_update["time"] if last_update else None}

    if best:
        c = best[1]
        verb = "now" if c["state"] == "active" else "today"
        return {**info, "level": c["level"], "state": c["state"], "window": c["window"],
                "label": f"{c['level'].title()} alert {verb} {c['window']}"}

    recent_lift = max(lifts, key=lambda x: x["time"]) if lifts else None
    if last_update and last_update["level"] != "NORMAL" and not lifted_after(last_update["time"]):
        return {**info, "level": last_update["level"], "state": "advisory", "window": None,
                "label": f"{last_update['level'].title()} alert (grid update {last_update['time']:%H:%M})"}
    if recent_lift:
        at = recent_lift.get("lifted_at")
        when = f"{at[:2]}:{at[2:]}" if at else f"{recent_lift['time']:%H:%M}"
        return {**info, "level": "NORMAL", "state": "lifted", "window": None,
                "label": f"Normal · {recent_lift['level'].title()} alert lifted {when}"}
    if last_update:
        return {**info, "level": "NORMAL", "state": "normal", "window": None, "label": "Normal"}
    return {**info, "level": "NORMAL", "state": "unknown", "window": None, "label": "Normal · no grid update today"}


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------

def _build_payload() -> dict:
    try:
        rows = _query_rows(_report_meta())
    except Exception:
        rows = _query_rows(_report_meta(force=True))  # report may have been republished
    items = [i for i in (_parse_item(r) for r in rows) if i]
    items.sort(key=lambda i: i["time"], reverse=True)
    now = (datetime.now(timezone.utc) + timedelta(hours=LOCAL_UTC_OFFSET_HOURS)).replace(tzinfo=None)
    cutoff = now - timedelta(hours=_HISTORY_HOURS)
    recent = [i for i in items if i["time"] >= cutoff]
    regions = [region_status(items, PLANT_REGION, now)]

    def ser(d: dict) -> dict:
        return {k: (v.strftime("%Y-%m-%d %H:%M") if isinstance(v, datetime) else v) for k, v in d.items()}

    # HVDC / inter-grid messages are posted once per grid: show them once, tagged with both grids.
    merged: list[dict] = []
    seen: dict[tuple, dict] = {}
    for i in recent:
        key = (i["time"].strftime("%Y-%m-%d %H:%M"), i["text"])
        if key in seen:
            if i["region"] not in seen[key]["region"].split("/"):
                seen[key]["region"] += "/" + i["region"]
            continue
        row = {k: i[k] for k in ("time", "region", "text", "kind", "level", "nso")}
        seen[key] = row
        merged.append(row)
    # Only the plant's grid (inter-grid messages tagged e.g. "Visayas/Luzon" are kept).
    merged = [r for r in merged if PLANT_REGION in r["region"].split("/")][:60]

    now_s = (datetime.now(timezone.utc) + timedelta(hours=LOCAL_UTC_OFFSET_HOURS)).replace(tzinfo=None, microsecond=0)
    baseline = not _first_seen
    current = set()
    for row in merged:
        key = (row["time"], row["text"])
        current.add(key)
        if key not in _first_seen:
            _first_seen[key] = None if baseline else now_s
        fs = _first_seen[key]
        row["first_seen"] = fs.strftime("%Y-%m-%dT%H:%M:%S") if fs else None
    for key in [k for k in _first_seen if k not in current]:
        del _first_seen[key]

    return {
        "ok": True,
        "server_time": now_s.strftime("%Y-%m-%dT%H:%M:%S"),
        "fetched_at": now.strftime("%Y-%m-%d %H:%M"),
        "source_url": REPORT_URL,
        "plant_region": PLANT_REGION,
        "regions": [ser(r) for r in regions],
        "items": [ser(i) for i in merged],
    }


def get_advisories() -> dict:
    """Cached advisories + grid status. Never raises: returns the last good data with ``error`` set."""
    with _lock:
        if _cache["payload"] and time.time() - _cache["at"] < CACHE_SECONDS:
            return _cache["payload"]
        try:
            payload = _build_payload()
        except Exception as e:
            stale = _cache["payload"]
            payload = {**stale, "error": f"Could not refresh from IEMOP: {e}", "stale": True} if stale else {
                "ok": False, "error": f"Could not load SO advisories from IEMOP: {e}", "regions": [], "items": [],
                "source_url": REPORT_URL, "plant_region": PLANT_REGION,
            }
            _cache.update(at=time.time() - CACHE_SECONDS + 30, payload=stale or payload)  # retry in 30 s
            return payload
        _cache.update(at=time.time(), payload=payload)
        return payload


if __name__ == "__main__":
    p = get_advisories()
    print("error:", p.get("error"))
    for r in p["regions"]:
        print(f"{r['region']:9s} {r['level']:7s} {r['state']:9s} {r['label']}  (cap {r['capacity_mw']} / peak {r['peak_mw']})")
    for i in p["items"][:12]:
        print(i["time"], i["region"][:3], i["kind"], "|", i["text"][:110])
