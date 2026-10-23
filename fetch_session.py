"""Cache one OpenF1 session to data/<session_key>/ for the race-watch page.

Usage:
    python3 fetch_session.py            # most recent completed race
    python3 fetch_session.py 11731      # a specific session_key

Free tier = historical data, 30 requests/minute, so every call waits 2.1 s.
Writes:
    session.json   - drivers, laps, positions, intervals, pits, stints,
                     race control, weather, session info
    location.json  - per driver: [t_ms, x, y] samples, t relative to session start
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.openf1.org/v1"
PAUSE_S = 2.1  # keeps us under 30 req/min


_token = {"value": None, "at": 0}


def _login():
    """Bearer token when an OpenF1 login is configured (needed while a session is
    live: the free API is closed to anonymous users during sessions)."""
    import os
    for f in (Path(__file__).parent / ".env", Path.home() / ".config/racewatch/env"):
        if f.exists():
            for line in f.read_text().splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())
    user, pw = os.environ.get("OPENF1_USERNAME"), os.environ.get("OPENF1_PASSWORD")
    if not (user and pw):
        return None
    if _token["value"] and time.time() - _token["at"] < 50 * 60:
        return _token["value"]
    body = urllib.parse.urlencode({"username": user, "password": pw}).encode()
    req = urllib.request.Request("https://api.openf1.org/token", data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        _token.update(value=json.load(r)["access_token"], at=time.time())
    return _token["value"]


def get(endpoint, **params):
    url = f"{API}/{endpoint}?{urllib.parse.urlencode(params)}"
    tok = _login()
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"} if tok else {})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)
            time.sleep(PAUSE_S)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:  # rate limited - back off and retry
                time.sleep(15 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"gave up on {url}")


def ts(s):
    # Python 3.10 only parses 3- or 6-digit fractions and no "Z"
    s = s.replace("Z", "+00:00")
    m = re.match(r"(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$", s)
    if m and m.group(2):
        s = m.group(1) + (m.group(2) + "000000")[:7] + m.group(3)
    return datetime.fromisoformat(s)


def latest_race():
    now = datetime.now(timezone.utc)
    races = [s for s in get("sessions", session_type="Race", year=now.year)
             if ts(s["date_end"]) < now]
    if not races:
        races = [s for s in get("sessions", session_type="Race", year=now.year - 1)]
    return races[-1]


def fetch_one(session, with_location=True):
    key = session["session_key"]
    out = Path(__file__).parent / "data" / str(key)
    out.mkdir(parents=True, exist_ok=True)
    t0 = ts(session["date_start"])
    label = f"{session['location']} {session['session_name']} {session['date_start'][:10]}"
    print(f"{label} (session_key {key})", flush=True)

    if not (out / "session.json").exists():
        bundle = {"session": session}
        for ep in ["drivers", "laps", "position", "intervals", "pit", "stints",
                   "race_control", "weather", "championship_drivers", "championship_teams", "session_result"]:
            bundle[ep] = get(ep, session_key=key)
            print(f"  {ep:<13} {len(bundle[ep]):>6} rows", flush=True)
        (out / "session.json").write_text(json.dumps(bundle))
    else:
        bundle = json.loads((out / "session.json").read_text())
        print("  session.json already cached", flush=True)

    has_map = (out / "location.json").exists()
    if with_location and not has_map:
        # Car locations: one request per driver. Raw feed is ~4 Hz with many
        # repeated points while stationary; keep a point only if the car moved
        # or 1 s has passed, which roughly halves the file without visible loss.
        location = {}
        for d in bundle["drivers"]:
            n = d["driver_number"]
            rows = get("location", session_key=key, driver_number=n)
            pts, last = [], None
            for r in rows:
                t = int((ts(r["date"]) - t0).total_seconds() * 1000)
                p = (r["x"], r["y"])
                if last and p == last[1] and t - last[0] < 1000:
                    continue
                pts.append([t, r["x"], r["y"]])
                last = (t, p)
            location[str(n)] = pts
            print(f"  location #{n:<3} {len(rows):>6} raw -> {len(pts):>6} kept", flush=True)
        (out / "location.json").write_text(json.dumps(location, separators=(",", ":")))
        has_map = True

    # index of cached sessions; "map" = has car locations (needed by the page)
    idx_path = out.parent / "index.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else []
    idx = [s for s in idx if s["session_key"] != key]
    idx.append({"session_key": key, "label": label, "year": session["year"],
                "date": session["date_start"][:10], "map": has_map})
    idx_path.write_text(json.dumps(sorted(idx, key=lambda s: s["date"])))


def main():
    """
    python3 fetch_session.py                    latest completed race, with map
    python3 fetch_session.py 11731              one session, with map
    python3 fetch_session.py --season 2024 2025 [--no-location]
                                                every completed race in those years
    """
    args = sys.argv[1:]
    if args and args[0] == "--backfill-championship":
        # cached races fetched without a login have empty championship tables
        idx = json.loads((Path(__file__).parent / "data" / "index.json").read_text())
        for e in idx:
            if str(e["year"]) not in args[1:]:
                continue
            f = Path(__file__).parent / "data" / str(e["session_key"]) / "session.json"
            b = json.loads(f.read_text())
            if b.get("championship_drivers") or b["session"].get("session_name") != "Race":
                continue
            for ep in ("championship_drivers", "championship_teams"):
                b[ep] = get(ep, session_key=e["session_key"])
            f.write_text(json.dumps(b))
            print(f"  {e['label']}: {len(b['championship_drivers'])} drivers", flush=True)
        return
    with_location = "--no-location" not in args
    args = [a for a in args if a != "--no-location"]
    if args and args[0] == "--season":
        now = datetime.now(timezone.utc)
        for year in args[1:]:
            races = [s for s in get("sessions", session_type="Race", year=int(year))
                     if s["session_name"] == "Race" and ts(s["date_end"]) < now
                     and not s.get("is_cancelled")]
            print(f"== {year}: {len(races)} races", flush=True)
            for s in races:
                try:
                    fetch_one(s, with_location)
                except Exception as e:  # keep going; one bad race shouldn't stop a season
                    print(f"  FAILED: {e}", flush=True)
        return
    session = get("sessions", session_key=args[0])[0] if args else latest_race()
    fetch_one(session, with_location)


if __name__ == "__main__":
    main()
