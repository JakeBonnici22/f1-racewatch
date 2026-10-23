"""
Race Watch server: serves the page (instead of `python3 -m http.server`) and,
during a session, collects OpenF1 live data and hands it to the page.

    .venv/bin/python live_server.py                   follow OpenF1's current session
    .venv/bin/python live_server.py --session 11388   a specific session
    .venv/bin/python live_server.py --simulate 11731 --from-lap 20 [--speed 4]
                                                      replay a cached race as if live (testing)
    .venv/bin/python live_server.py --off             just serve the page

Live data needs OpenF1 sponsor access. Put the login in .env next to this file:
    OPENF1_USERNAME=you@example.com
    OPENF1_PASSWORD=...

How it works
  - logs in for a bearer token (renewed every 50 min)
  - REST catch-up of everything so far in the session, then MQTT push for new
    rows (falls back to REST polling inside the 60 requests/min limit)
  - every row gets a stable key, so updates (laps fill in sector times as they
    happen) replace the earlier version instead of duplicating it
  - the page polls /live/bundle?since=<seq> once a second for new rows
  - the session is saved to data/<key>/ every 2 minutes and on exit, so it is
    a normal replay afterwards
"""
import argparse
import gzip
import json
import re
import os
import signal
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
API = "https://api.openf1.org/v1"
ENDPOINTS = ["laps", "position", "intervals", "pit", "stints", "race_control", "weather", "location", "team_radio"]
SLOW = ["drivers", "championship_drivers", "championship_teams", "session_result"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ts(s):
    # Python 3.10 only parses 3- or 6-digit fractions and no "Z"
    s = s.replace("Z", "+00:00")
    m = re.match(r"(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$", s)
    if m and m.group(2):
        s = m.group(1) + (m.group(2) + "000000")[:7] + m.group(3)
    return datetime.fromisoformat(s)


def load_env():
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ---------------------------------------------------------------- the store
def row_key(ep, r):
    """Stable identity per endpoint, so a newer version of a row replaces the old one."""
    n = r.get("driver_number")
    if ep == "laps":
        return f"{n}_{r.get('lap_number')}"
    if ep == "stints":
        return f"{n}_{r.get('stint_number')}"
    if ep == "pit":
        return f"{n}_{r.get('lap_number')}"
    if ep in ("drivers", "championship_drivers", "session_result"):
        return str(n)
    if ep == "championship_teams":
        return r.get("team_name")
    if ep == "race_control":
        return f"{r.get('date')}_{r.get('category')}_{r.get('message')}"
    if ep == "weather":
        return r.get("date")
    return f"{r.get('date')}_{n}"  # position, intervals, location


class Store:
    """Everything known about the session, plus an append-only change log.

    The page asks for changes since its last sequence number; a row that was
    updated simply appears again with the same key and the page replaces it."""

    def __init__(self, session):
        self.session = session
        self.t0 = ts(session["date_start"])
        self.lock = threading.Lock()
        self.rows = {ep: {} for ep in ENDPOINTS + SLOW}
        self.log = []  # (endpoint, key)
        self.last_msg = None
        self.dirty = False

    def add(self, ep, r, source="rest"):
        if ep not in self.rows or r.get("session_key", self.session["session_key"]) != self.session["session_key"]:
            return False
        r = {k: v for k, v in r.items() if not k.startswith("_")}
        for f in ("date", "date_start"):  # MQTT rows come without a zone; they are UTC
            v = r.get(f)
            if isinstance(v, str) and len(v) >= 19 and not (v.endswith("Z") or v[-6] in "+-"):
                r[f] = v + "+00:00"
        k = row_key(ep, r)
        with self.lock:
            old = self.rows[ep].get(k)
            if old == r:
                return False
            if old and ep == "laps":  # MQTT lap updates can be partial: keep known fields
                r = {**old, **{a: b for a, b in r.items() if b is not None}}
            self.rows[ep][k] = r
            self.log.append((ep, k))
            self.last_msg = time.time()
            self.dirty = True
        return True

    def since(self, seq, limit=60000):
        with self.lock:
            part = self.log[seq:seq + limit]
            # each key once per batch, newest version
            seen, out = set(), []
            for ep, k in reversed(part):
                if (ep, k) in seen:
                    continue
                seen.add((ep, k))
                r = self.rows[ep][k]
                if ep == "location":
                    t = self.rel(r["date"])
                    if t < -5 * 60000 and self.session.get("session_type") == "Race":
                        continue  # out-laps to the grid: not worth downloading
                    out.append(["L", r["driver_number"], t, r["x"], r["y"]])
                else:
                    out.append([ep, r])
            out.reverse()
            return seq + len(part), out, seq + len(part) < len(self.log)

    def rel(self, iso):
        return int((ts(iso) - self.t0).total_seconds() * 1000)

    def counts(self):
        with self.lock:
            return {ep: len(v) for ep, v in self.rows.items()}

    def last_date(self, ep, field="date"):
        with self.lock:
            ds = [r.get(field) for r in self.rows[ep].values() if r.get(field)]
        return max(ds) if ds else None

    def save(self):
        """Write the session in the replay format (data/<key>/session.json + location.json)."""
        with self.lock:
            if not self.dirty:
                return
            bundle = {"session": self.session}
            for ep in ENDPOINTS + SLOW:
                if ep != "location":
                    bundle[ep] = sorted(self.rows[ep].values(), key=lambda r: r.get("date") or r.get("date_start") or "")
            loc = {}
            for r in self.rows["location"].values():
                loc.setdefault(str(r["driver_number"]), []).append([self.rel(r["date"]), r["x"], r["y"]])
            self.dirty = False
        for pts in loc.values():
            pts.sort()
        key = self.session["session_key"]
        out = DATA / str(key)
        out.mkdir(parents=True, exist_ok=True)
        (out / "session.json").write_text(json.dumps(bundle))
        (out / "location.json").write_text(json.dumps(loc, separators=(",", ":")))
        s = self.session
        idx_path = DATA / "index.json"
        idx = json.loads(idx_path.read_text()) if idx_path.exists() else []
        idx = [x for x in idx if x["session_key"] != key]
        idx.append({"session_key": key, "label": f"{s['location']} {s['session_name']} {s['date_start'][:10]}",
                    "year": s["year"], "date": s["date_start"][:10], "map": bool(loc)})
        idx_path.write_text(json.dumps(sorted(idx, key=lambda x: x["date"])))
        log(f"saved session {key} to data/{key}/")


# ---------------------------------------------------------------- OpenF1 live
class OpenF1:
    def __init__(self):
        self.user = os.environ.get("OPENF1_USERNAME")
        self.password = os.environ.get("OPENF1_PASSWORD")
        self.token, self.token_at = None, 0
        self.calls = []  # request times, to stay inside 60/min

    @property
    def has_login(self):
        return bool(self.user and self.password)

    def auth(self):
        if not self.has_login:
            return None
        if self.token and time.time() - self.token_at < 50 * 60:
            return self.token
        body = urllib.parse.urlencode({"username": self.user, "password": self.password}).encode()
        req = urllib.request.Request("https://api.openf1.org/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=30) as r:
            self.token = json.load(r)["access_token"]
        self.token_at = time.time()
        log("OpenF1 login ok")
        return self.token

    def get(self, ep, **params):
        # 60 requests/min and 6/s: keep a little under both
        now = time.time()
        self.calls = [c for c in self.calls if now - c < 60]
        if len(self.calls) >= 55:
            time.sleep(60 - (now - self.calls[0]) + 0.1)
        if self.calls and time.time() - self.calls[-1] < 0.25:
            time.sleep(0.25)
        self.calls.append(time.time())
        q = "&".join(f"{k}={urllib.parse.quote(str(v), safe=':-T.')}" if not k.endswith((">", "<"))
                     else f"{k}{urllib.parse.quote(str(v), safe=':-T.')}" for k, v in params.items())
        req = urllib.request.Request(f"{API}/{ep}?{q}")
        tok = self.auth()
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return []
                if e.code in (429, 502, 503) and attempt < 3:
                    time.sleep(3 * (attempt + 1))
                    continue
                if e.code == 401:
                    self.token = None
                raise
        return []


class LiveFeed:
    """Keeps a Store filled for the current OpenF1 session."""

    def __init__(self, api, session_key=None):
        self.api, self.want = api, session_key
        self.store, self.mqtt, self.mqtt_ok = None, None, False
        self.status = "starting"
        self.error = None

    def current_session(self):
        """The session asked for; otherwise whichever session on the calendar is
        on now (from 45 min before to an hour after); otherwise OpenF1's latest."""
        key = self.want or calendar_session_now() or "latest"
        if self.store and str(self.store.session["session_key"]) == str(key):
            return self.store.session
        rows = self.api.get("sessions", session_key=key)
        return rows[0] if rows else None

    def catch_up(self, full=False):
        st = self.store
        key = st.session["session_key"]
        for ep in SLOW:
            for r in self.api.get(ep, session_key=key):
                st.add(ep, r)
        for ep in ["laps", "position", "intervals", "pit", "stints", "race_control", "weather", "team_radio"]:
            for r in self.api.get(ep, session_key=key):
                st.add(ep, r)
        # car locations: per driver, only what we don't have yet
        since = st.last_date("location") if not full else None
        drivers = [r["driver_number"] for r in st.rows["drivers"].values()]
        if since:
            for r in self.api.get("location", **{"session_key": key, "date>": since}):
                st.add("location", r)
        else:
            for n in drivers:
                for r in self.api.get("location", session_key=key, driver_number=n):
                    st.add("location", r)
        log("catch-up done:", st.counts())

    def start_mqtt(self):
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            log("paho-mqtt not installed: polling REST instead (run with .venv/bin/python)")
            return False
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        c.username_pw_set(self.api.user, self.api.auth())
        c.tls_set(cert_reqs=ssl.CERT_REQUIRED)

        def on_connect(cl, ud, flags, rc, props=None):
            if rc == 0 or getattr(rc, "value", 1) == 0:
                self.mqtt_ok = True
                log("MQTT connected")
                for ep in ENDPOINTS + SLOW:
                    cl.subscribe(f"v1/{ep}")
            else:
                log("MQTT connect refused:", rc)

        def on_disconnect(cl, ud, flags, rc, props=None):
            self.mqtt_ok = False
            log("MQTT disconnected:", rc)
            try:
                cl.username_pw_set(self.api.user, self.api.auth())  # fresh token for the reconnect
            except Exception as e:  # noqa: BLE001
                log("token refresh failed:", e)

        def on_message(cl, ud, msg):
            ep = msg.topic.split("/", 1)[-1]
            try:
                r = json.loads(msg.payload)
            except ValueError:
                return
            if self.store:
                self.store.add(ep, r, "mqtt")

        c.on_connect, c.on_disconnect, c.on_message = on_connect, on_disconnect, on_message
        c.reconnect_delay_set(1, 30)
        c.connect_async("mqtt.openf1.org", 8883, 60)
        c.loop_start()
        self.mqtt = c
        return True

    def poll_once(self, tick):
        """REST polling, used when MQTT is down. ~50 requests/min in total."""
        st, key = self.store, self.store.session["session_key"]
        plan = [("location", 1), ("position", 2), ("intervals", 2), ("laps", 3),
                ("race_control", 5), ("pit", 5), ("stints", 7), ("weather", 20)]
        for ep, every in plan:
            if tick % every:
                continue
            field = "date_start" if ep == "laps" else "date"
            last = st.last_date(ep, field)
            if ep in ("stints", "pit") or not last:
                rows = self.api.get(ep, session_key=key)
            else:
                # laps get updated after they start (sector times), so look back a bit
                back = timedelta(minutes=4 if ep == "laps" else 0)
                rows = self.api.get(ep, **{"session_key": key, f"{field}>": (ts(last) - back).isoformat()})
            for r in rows:
                st.add(ep, r)

    def run(self):
        tick = 0
        while True:
            try:
                s = self.current_session()
                if s and (not self.store or s["session_key"] != self.store.session["session_key"]):
                    if self.store:
                        self.store.save()
                    self.store = Store(s)
                    log(f"following session {s['session_key']}: {s['location']} {s['session_name']} {s['date_start']}")
                    self.status = "catching up"
                    self.catch_up(full=True)
                    if not self.mqtt:
                        self.start_mqtt()
                self.status, self.error = "live", None
                # between session checks: poll if MQTT is down, save now and then
                for _ in range(120):
                    tick += 1
                    if not self.mqtt_ok:
                        self.poll_once(tick)
                    if tick % 120 == 0:
                        self.store.save()
                    time.sleep(1 if not self.mqtt_ok else 1)
                    if tick % 60 == 0 and self.mqtt_ok and self.in_window() and self.store.last_msg and time.time() - self.store.last_msg > 120:
                        self.catch_up()  # quiet for 2 min during a session: make sure nothing was missed
                    if tick % 10 == 0:
                        self.watchdog()
            except Exception as e:  # noqa: BLE001 - keep the race going whatever happens
                self.error = str(e)
                self.status = "error"
                log("live feed error:", e)
                time.sleep(5)

    def now_ms(self):
        if not self.store:
            return None
        return int((datetime.now(timezone.utc) - self.store.t0).total_seconds() * 1000)

    def watchdog(self):
        """Phone alert (Home Assistant webhook) when data stops arriving while a
        session is running, and again when it comes back."""
        s = self.store.session if self.store else None
        if not s:
            return
        now = datetime.now(timezone.utc)
        running = ts(s["date_start"]) <= now <= ts(s["date_end"]) + timedelta(minutes=10)
        age = time.time() - self.store.last_msg if self.store.last_msg else None
        stalled = running and (age is None or age > 60)
        name = f"{s.get('location')} {s.get('session_name')}"
        if stalled and not getattr(self, "alerted", False):
            self.alerted = True
            alert("Race Watch: live data stopped",
                  f"No data from OpenF1 for {int(age or 0)} s during {name}. MQTT {'connected' if self.mqtt_ok else 'down'}; the server keeps retrying.")
        elif not stalled and getattr(self, "alerted", False):
            self.alerted = False
            alert("Race Watch: live data is back", f"{name} is updating again.")

    def in_window(self):
        s = self.store.session
        now = datetime.now(timezone.utc)
        return ts(s["date_start"]) - timedelta(minutes=30) <= now <= ts(s["date_end"]) + timedelta(minutes=30)


def alert(title, message):
    """POST to RACEWATCH_ALERT_WEBHOOK (a Home Assistant webhook that notifies the phone)."""
    url = os.environ.get("RACEWATCH_ALERT_WEBHOOK")
    log("ALERT:", title, "-", message)
    if not url:
        return
    try:
        req = urllib.request.Request(url, data=json.dumps({"title": title, "message": message}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001 - an alert must never take the server down
        log("alert failed:", e)


# ---------------------------------------------------------------- simulation
class SimFeed:
    """Plays a cached race into a Store on a clock, as if it were happening now.
    Laps arrive unfinished at their start and are completed when they end, like
    the live feed; stints arrive when the stint starts."""

    def __init__(self, key, from_lap=None, from_min=None, speed=1.0):
        b = json.loads((DATA / str(key) / "session.json").read_text())
        loc = json.loads((DATA / str(key) / "location.json").read_text())
        self.store = Store(b["session"])
        self.speed, self.status, self.error, self.mqtt_ok = speed, "live", None, True
        rel = self.store.rel
        ev = []
        for ep in SLOW:
            for r in b.get(ep, []):
                ev.append((-10**9, ep, r))
        for ep in ["position", "intervals", "race_control", "weather", "pit"]:
            for r in b.get(ep, []):
                ev.append((rel(r["date"]), ep, r))
        lap_start = {}
        for r in b["laps"]:
            if not r.get("date_start"):
                continue
            t = rel(r["date_start"])
            lap_start[(r["driver_number"], r["lap_number"])] = t
            blank = {**r, "lap_duration": None, "duration_sector_1": None, "duration_sector_2": None,
                     "duration_sector_3": None, "st_speed": None}
            ev.append((t, "laps", blank))
            if r.get("lap_duration"):
                ev.append((t + int(r["lap_duration"] * 1000), "laps", r))
        for r in b["stints"]:
            t = lap_start.get((r["driver_number"], r.get("lap_start")), 0 if r.get("stint_number") == 1 else None)
            if t is not None:
                ev.append((t, "stints", r))
        t0 = self.store.t0
        for n, pts in loc.items():
            for t, x, y in pts:
                d = (t0 + timedelta(milliseconds=t)).isoformat()
                ev.append((t, "location", {"driver_number": int(n), "date": d, "x": x, "y": y,
                                           "session_key": self.store.session["session_key"]}))
        ev.sort(key=lambda e: e[0])
        self.events, self.i = ev, 0
        starts = sorted(lap_start.items(), key=lambda kv: kv[1])
        if from_lap:
            t_start = min(t for (n, lap), t in lap_start.items() if lap == from_lap)
        elif from_min is not None:
            green = next((rel(r["date"]) for r in b["race_control"]
                          if r.get("category") == "SessionStatus" and "STARTED" in (r.get("message") or "").upper()), 0)
            t_start = green + int(from_min * 60000)
        else:
            t_start = starts[0][1] - 120000 if starts else 0
        self.t_start, self.wall0 = t_start, time.time()
        log(f"simulating {key} from t={t_start / 60000:.1f} min at {speed}x, {len(ev)} events")

    def now_ms(self):
        return int(self.t_start + (time.time() - self.wall0) * 1000 * self.speed)

    def run(self):
        while True:
            now = self.now_ms()
            while self.i < len(self.events) and self.events[self.i][0] <= now:
                _, ep, r = self.events[self.i]
                self.store.add(ep, dict(r))
                self.i += 1
            time.sleep(0.25)


# ---------------------------------------------------------------- HTTP
BOOT = str(int(time.time()))
_gz_cache = {}


def allowed(path):
    """Only the page, its scripts and styles, and the data files - never .env,
    Python sources, logs or the venv."""
    p = urllib.parse.unquote(path.split("?", 1)[0])
    if ".." in p or "/." in p:
        return False
    if p in ("/", "/index.html", "/favicon.ico"):
        return True
    if p.count("/") == 1 and p.endswith((".js", ".css")):
        return True
    return p.startswith("/data/") and p.endswith(".json") and not p.startswith("/data/jolpica/")


class Handler(SimpleHTTPRequestHandler):
    feed = None
    mode = "off"
    server_version, sys_version = "RaceWatch", ""  # don't advertise the Python version

    def gz_ok(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "")

    def send_bytes(self, body, ctype, cache="no-store"):
        if self.gz_ok() and len(body) > 1024:
            body = gzip.compress(body, 5)
            enc = True
        else:
            enc = False
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if enc:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(body)

    def send_data_file(self, path):
        """Data JSON, gzipped once and cached until the file changes (a race's
        car positions shrink from ~15 MB to ~3 MB)."""
        f = ROOT / urllib.parse.unquote(path.split("?", 1)[0]).lstrip("/")
        if not f.is_file():
            return self.send_error(404)
        mtime = f.stat().st_mtime
        cache = "no-store" if f.name in ("index.json", "calendar.json") else "no-cache"
        if not self.gz_ok():
            return self.send_bytes(f.read_bytes(), "application/json", cache)
        hit = _gz_cache.get(str(f))
        if not hit or hit[0] != mtime:
            hit = (mtime, gzip.compress(f.read_bytes(), 5))
            _gz_cache[str(f)] = hit
            if len(_gz_cache) > 40:
                _gz_cache.pop(next(iter(_gz_cache)))
        body = hit[1]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *a):  # quiet: the page polls every second
        pass

    def end_headers(self):
        p = self.path.split("?", 1)[0]
        if p in ("/", "/index.html"):
            self.send_header("Cache-Control", "no-cache")  # so a new ?v= on the scripts is always seen
        super().end_headers()

    def json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        if code == 200:
            return self.send_bytes(body, "application/json")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/live/status":
            return self.json(self.status())
        if u.path in ("/teamradio", "/telemetry"):
            q = urllib.parse.parse_qs(u.query)
            try:
                key = int(q["session"][0])
                args = (int(q["driver"][0]), int(q["lap"][0])) if u.path == "/telemetry" else ()
            except (KeyError, IndexError, ValueError):
                return self.json({"error": "bad request"}, 400)
            if not known_session(self.feed, key):
                return self.json({"error": "unknown session"}, 404)
            try:
                out = team_radio(self.feed, key) if u.path == "/teamradio" else telemetry(self.feed, key, *args)
            except Busy:
                return self.json({"error": "busy, try again in a minute"}, 429)
            except Exception as e:  # noqa: BLE001 - details go to the log, not to visitors
                log(f"{u.path} session {key} {args} failed:", e)
                return self.json({"error": "could not load this from OpenF1"}, 503)
            if out is None:
                return self.json({"error": "no such lap"}, 404)
            return self.json(out)
        if u.path == "/live/bundle":
            f = self.feed
            if not f or not f.store:
                return self.json({"error": "no live session"}, 404)
            q = urllib.parse.parse_qs(u.query)
            try:
                seq = int(q.get("since", ["0"])[0])
            except ValueError:
                return self.json({"error": "bad request"}, 400)
            sk = q.get("session", [None])[0]
            if sk and sk != str(f.store.session["session_key"]):
                seq = 0  # the session changed under the page: start over
            if q.get("boot", [BOOT])[0] != BOOT:
                seq = 0  # the server restarted: its sequence numbers started over
            nxt, rows, more = f.store.since(seq)
            return self.json({"seq": nxt, "more": more, "boot": BOOT, "session": f.store.session,
                              "now_ms": f.now_ms(), "rate": getattr(f, "speed", 1.0), "rows": rows})
        if not allowed(self.path):
            return self.send_error(404)
        if u.path.startswith("/data/"):
            return self.send_data_file(self.path)
        return super().do_GET()

    def do_HEAD(self):
        if not allowed(self.path):
            return self.send_error(404)
        return super().do_HEAD()

    def status(self):
        f = self.feed
        out = {"mode": self.mode, "live": False}
        if not f:
            return out
        # the error text itself stays in the log; visitors only learn that it's reconnecting
        out.update({"status": f.status, "error": "live data is reconnecting" if f.status == "error" else None,
                    "mqtt": getattr(f, "mqtt_ok", False)})
        if f.store:
            s = f.store.session
            now = f.now_ms()
            end = int((ts(s["date_end"]) - f.store.t0).total_seconds() * 1000)
            out.update({
                "session": {k: s.get(k) for k in ("session_key", "session_name", "session_type", "meeting_key",
                                                  "circuit_key", "location", "country_name", "date_start", "date_end", "year")},
                "now_ms": now,
                "rate": getattr(f, "speed", 1.0),
                # live = inside the session window (with 30 min either side for the build-up and the podium)
                "live": self.mode == "sim" or -30 * 60000 <= now <= end + 30 * 60000,
                "counts": f.store.counts(),
                "last_msg_age": None if not f.store.last_msg else round(time.time() - f.store.last_msg, 1),
                "ref": reference_session(s),
                "ref_laps": reference_laps(s),
            })
        return out


_ref_cache = {}
_tele_api = None
_lap_index = {}

# Speed traces and radio fetch from OpenF1 on demand (then cache). Cap those
# uncached calls so visitors can never use up the 60/min the live feed needs.
FETCH_BUDGET = 20  # per minute
_fetches = []
_fetch_lock = threading.Lock()


class Busy(Exception):
    pass


def spend_fetch():
    with _fetch_lock:
        now = time.time()
        _fetches[:] = [t for t in _fetches if now - t < 60]
        if len(_fetches) >= FETCH_BUDGET:
            raise Busy()
        _fetches.append(now)


def known_session(feed, key):
    """Only sessions this server already has (or is following live), so a
    request can't make it call OpenF1 for any session number it likes."""
    if feed and getattr(feed, "store", None) and feed.store.session["session_key"] == key:
        return True
    return (DATA / str(key) / "session.json").is_file()


def lap_window(feed, key, n, lap):
    """(start, end) of one lap, from the live store or the saved session."""
    if feed and getattr(feed, "store", None) and feed.store.session["session_key"] == key:
        with feed.store.lock:
            r = feed.store.rows["laps"].get(f"{n}_{lap}")
            r = dict(r) if r else None
        t0 = feed.store.session["date_start"]
    else:
        if key not in _lap_index:
            b = json.loads((DATA / str(key) / "session.json").read_text())
            _lap_index[key] = {f"{x['driver_number']}_{x['lap_number']}": x for x in b["laps"]}
            if len(_lap_index) > 6:
                _lap_index.pop(next(iter(_lap_index)))
        r = _lap_index[key].get(f"{n}_{lap}")
    if not r or not r.get("date_start"):
        return None
    start = ts(r["date_start"] if r["date_start"][-6] in "+-" or r["date_start"].endswith("Z") else r["date_start"] + "+00:00")
    end = start + timedelta(seconds=r["lap_duration"]) if r.get("lap_duration") else None
    return start, end


def team_radio(feed, key):
    """Radio clips for a session: from the live store while it's running,
    otherwise from OpenF1 once and cached next to the session."""
    global _tele_api
    if feed and getattr(feed, "store", None) and feed.store.session["session_key"] == key:
        with feed.store.lock:
            return sorted(feed.store.rows["team_radio"].values(), key=lambda r: r["date"])
    cache = DATA / str(key) / "team_radio.json"
    if cache.exists():
        return json.loads(cache.read_text())
    if _tele_api is None:
        _tele_api = feed.api if feed and getattr(feed, "api", None) else OpenF1()
    spend_fetch()
    rows = sorted(_tele_api.get("team_radio", session_key=key), key=lambda r: r["date"])
    if (DATA / str(key)).exists():
        cache.write_text(json.dumps(rows))
    return rows


def telemetry(feed, key, n, lap):
    """Speed, throttle, brake, gear for one lap of one car, from OpenF1's car_data
    (about 4 samples a second), cached on disk once the lap is complete."""
    global _tele_api
    cache = DATA / str(key) / "car" / f"{n}_{lap}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    win = lap_window(feed, key, n, lap)
    if not win:
        return None
    start, end = win
    done = end is not None
    end = end or datetime.now(timezone.utc)
    if _tele_api is None:
        _tele_api = feed.api if feed and getattr(feed, "api", None) else OpenF1()
    spend_fetch()
    rows = _tele_api.get("car_data", **{"session_key": key, "driver_number": n,
                                        "date>": (start - timedelta(seconds=0.3)).isoformat(),
                                        "date<": (end + timedelta(seconds=0.3)).isoformat()})
    samples = []
    for r in sorted(rows, key=lambda r: r["date"]):
        d = r["date"] if r["date"][-6] in "+-" or r["date"].endswith("Z") else r["date"] + "+00:00"
        samples.append([int((ts(d) - start).total_seconds() * 1000), r.get("speed"), r.get("throttle"), r.get("brake"),
                        r.get("n_gear"), r.get("rpm"), r.get("drs")])
    out = {"session": key, "driver": n, "lap": lap, "dur": (end - start).total_seconds() if done else None, "samples": samples}
    if done and samples:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(out, separators=(",", ":")))
    return out


def reference_session(s):
    """Most recent cached race (with map) at the same circuit: gives the page a
    track outline before the first full lap, and the race distance."""
    ck = s.get("circuit_key")
    if ck in _ref_cache:
        return _ref_cache[ck]
    best = None
    idx = json.loads((DATA / "index.json").read_text()) if (DATA / "index.json").exists() else []
    for e in sorted(idx, key=lambda e: e["date"], reverse=True):
        if not e.get("map") or e["session_key"] == s["session_key"] or e["date"] >= s["date_start"][:10]:
            continue
        try:
            with open(DATA / str(e["session_key"]) / "session.json") as fh:
                head = fh.read(2000)  # "session" is first in the file
            if f'"circuit_key": {ck},' in head or f'"circuit_key":{ck},' in head:
                best = e["session_key"]
                break
        except OSError:
            continue
    _ref_cache[ck] = best
    return best


def calendar_session_now():
    f = DATA / "calendar.json"
    if not f.exists():
        return None
    now = datetime.now(timezone.utc)
    for rows in json.loads(f.read_text())["years"].values():
        for w in rows:
            for x in w.get("sessions", []):
                if not x.get("cancelled") and ts(x["start"]) - timedelta(minutes=45) <= now <= ts(x["end"]) + timedelta(minutes=60):
                    return x["key"]
    return None


_laps_cache = {}


def reference_laps(s):
    """Race distance from the last race at this circuit (any cached race, map or not)."""
    ck = s.get("circuit_key")
    if s.get("session_name") != "Race":
        return None
    if ck in _laps_cache:
        return _laps_cache[ck]
    best, best_date = None, ""
    for d in DATA.iterdir():
        f = d / "session.json"
        if not f.exists() or d.name == str(s["session_key"]):
            continue
        with open(f) as fh:
            head = fh.read(2000)
        if (f'"circuit_key": {ck},' not in head and f'"circuit_key":{ck},' not in head) or '"session_name": "Race"' not in head:
            continue
        b = json.loads(f.read_text())
        if b["session"]["date_start"] > best_date and b["session"]["date_start"] < s["date_start"]:
            best_date, best = b["session"]["date_start"], max((l["lap_number"] for l in b["laps"]), default=None)
    _laps_cache[ck] = best
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1", help="address to listen on (e.g. the Tailscale IP)")
    ap.add_argument("--session", type=int)
    ap.add_argument("--simulate", type=int, metavar="SESSION_KEY")
    ap.add_argument("--from-lap", type=int)
    ap.add_argument("--from-min", type=float, help="minutes after lights out (negative = before)")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--off", action="store_true", help="serve the page only")
    a = ap.parse_args()
    load_env()
    for f in (Path.home() / ".config/racewatch/env",):  # on a server, keep the login outside the served folder
        if f.exists():
            for line in f.read_text().splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

    if a.simulate:
        feed, mode = SimFeed(a.simulate, a.from_lap, a.from_min, a.speed), "sim"
    elif a.off:
        feed, mode = None, "off"
    else:
        api = OpenF1()
        if not api.has_login:
            log("no OPENF1_USERNAME / OPENF1_PASSWORD in .env: serving replays only")
            feed, mode = None, "off"
        else:
            try:
                api.auth()
            except Exception as e:  # noqa: BLE001
                log("OpenF1 login failed:", e, "- serving replays only")
                api = None
            feed, mode = (LiveFeed(api, a.session), "live") if api else (None, "off")
    if feed:
        threading.Thread(target=feed.run, daemon=True).start()

    Handler.feed, Handler.mode = feed, mode
    srv = ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=str(ROOT)))

    def bye(*_):
        log("stopping")
        if mode == "live" and feed and feed.store:
            feed.store.save()
        os._exit(0)

    signal.signal(signal.SIGINT, bye)
    signal.signal(signal.SIGTERM, bye)
    log(f"Race Watch on http://{a.host}:{a.port}  ({mode})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
