"""
Build data/preview.json: one racing lap of the latest race, every car at four
samples a second, for the moving mini map in the lobby. About 20 KB, so the
lobby stays light; the full replay is only downloaded when someone opens it.

    python3 build_preview.py
"""
import json
from pathlib import Path

from live_server import ts  # Python 3.10-safe ISO parsing

ROOT = Path(__file__).parent
DATA = ROOT / "data"
STEP = 250  # ms between samples
LAP = 3     # the field has spread out by lap 3


def at(pts, t):
    """Position at time t (ms), linearly between the two nearest samples."""
    lo, hi = 0, len(pts) - 1
    if t <= pts[0][0]:
        return pts[0][1], pts[0][2]
    if t >= pts[hi][0]:
        return pts[hi][1], pts[hi][2]
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, x0, y0), (t1, x1, y1) = pts[lo], pts[hi]
    f = (t - t0) / (t1 - t0) if t1 > t0 else 0
    return x0 + (x1 - x0) * f, y0 + (y1 - y0) * f


def main():
    idx = json.loads((DATA / "index.json").read_text())
    races = sorted((e for e in idx if " Race " in e["label"] and e.get("map")), key=lambda e: e["date"])
    if not races:
        raise SystemExit("no race with a map yet")
    key = races[-1]["session_key"]
    b = json.loads((DATA / str(key) / "session.json").read_text())
    loc = json.loads((DATA / str(key) / "location.json").read_text())
    t_start = ts(b["session"]["date_start"])
    rel = lambda iso: int((ts(iso if iso[-6] in "+-" or iso.endswith("Z") else iso + "+00:00") - t_start).total_seconds() * 1000)

    starts = lambda n: [rel(l["date_start"]) for l in b["laps"] if l.get("lap_number") == n and l.get("date_start")]
    t0, t1 = min(starts(LAP)), min(starts(LAP + 1))
    order = sorted((l for l in b["laps"] if l.get("lap_number") == LAP and l.get("date_start")), key=lambda l: l["date_start"])
    leader = order[0]["driver_number"]

    drivers = {d["driver_number"]: d for d in b.get("drivers", [])}
    cars = []
    for l in order:  # running order at the start of the lap
        n = l["driver_number"]
        pts = loc.get(str(n))
        if not pts:
            continue
        xy, prev = [], (0, 0)
        for t in range(t0, t1, STEP):
            x, y = at(pts, t)
            x, y = int(round(x)), int(round(y))
            xy += [x - prev[0], y - prev[1]]
            prev = (x, y)
        d = drivers.get(n, {})
        cars.append({"n": n, "code": d.get("name_acronym") or str(n), "colour": d.get("team_colour") or "8d97a6", "xy": xy})

    lead = [p for p in loc[str(leader)] if t0 <= p[0] <= t1]
    track = [v for p in lead[:: max(1, len(lead) // 300)] for v in (int(p[1]), int(p[2]))]

    name = b["session"].get("location")
    cal = DATA / "calendar.json"
    if cal.exists():
        for rows in json.loads(cal.read_text())["years"].values():
            for w in rows:
                if str(w.get("race_key")) == str(key):
                    name = w["name"]
    out = {"session_key": key, "name": name, "lap": LAP, "step": STEP, "track": track, "cars": cars}
    (DATA / "preview.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"preview.json: {name} lap {LAP}, {len(cars)} cars, {(t1 - t0) / 1000:.0f} s")


if __name__ == "__main__":
    main()
