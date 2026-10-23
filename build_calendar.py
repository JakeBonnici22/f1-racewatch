"""
Build data/calendar.json: every Grand Prix weekend (official names, rounds,
session times) for the seasons we show, plus the podium for races we have
cached. The page reads it for the race archive and the "next live" card.

    python3 build_calendar.py              2023-current year
    python3 build_calendar.py 2025 2026

Re-run after fetching new races (it's ~2 requests a year).
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_session import get

DATA = Path(__file__).parent / "data"


def display_name(m):
    # "Bahrain Grand Prix" was held in Kuala Lumpur in 2026; the official name
    # says so ("... BAHRAIN GRAND PRIX IN MALAYSIA 2026"), so keep that part.
    name = m["meeting_name"]
    hit = re.search(r"GRAND PRIX IN ([A-Z ]+?) \d{4}$", m.get("meeting_official_name") or "")
    if hit:
        name += " in " + hit.group(1).title()
    return name


def standings_after(key):
    """Championship points after this race weekend (OpenF1 points_current)."""
    f = DATA / str(key) / "session.json"
    if not f.exists():
        return None
    b = json.loads(f.read_text())
    cd, ct = b.get("championship_drivers") or [], b.get("championship_teams") or []
    if not cd:
        return None
    code = {d["driver_number"]: d.get("name_acronym") for d in b["drivers"]}
    team = {d["driver_number"]: d.get("team_name") for d in b["drivers"]}
    return {"drivers": [{"n": r["driver_number"], "code": code.get(r["driver_number"]) or str(r["driver_number"]),
                         "team": team.get(r["driver_number"]), "pts": r.get("points_current"), "start": r.get("points_start")}
                        for r in cd],
            "teams": [{"team": r["team_name"], "pts": r.get("points_current"), "start": r.get("points_start")} for r in ct]}


def podium(key):
    f = DATA / str(key) / "session.json"
    if not f.exists():
        return None
    b = json.loads(f.read_text())
    code = {d["driver_number"]: d.get("name_acronym") for d in b["drivers"]}
    res = [r for r in b.get("session_result") or [] if r.get("position")]
    if res:  # official classification (includes penalties)
        top = [r["driver_number"] for r in sorted(res, key=lambda r: r["position"])[:3]]
        return [code.get(n, str(n)) for n in top]
    last = {}
    for p in b["position"]:
        last[p["driver_number"]] = p["position"]
    top = sorted(last, key=last.get)[:3]
    return [code.get(n, str(n)) for n in top]


def main():
    now = datetime.now(timezone.utc)
    years = [int(y) for y in sys.argv[1:]] or list(range(2023, now.year + 1))
    out = {"generated": now.isoformat(timespec="seconds"), "years": {}}
    for y in years:
        meetings = [m for m in get("meetings", year=y) if "testing" not in m["meeting_name"].lower()]
        sessions = get("sessions", year=y)
        by_meeting = {}
        for s in sessions:
            by_meeting.setdefault(s["meeting_key"], []).append(s)
        rows, rnd = [], 0
        for m in sorted(meetings, key=lambda m: m["date_start"]):
            cancelled = bool(m.get("is_cancelled"))
            if not cancelled:
                rnd += 1
            ss = sorted(by_meeting.get(m["meeting_key"], []), key=lambda s: s["date_start"])
            race = next((s for s in ss if s["session_name"] == "Race"), None)
            rows.append({
                "round": None if cancelled else rnd,
                "meeting_key": m["meeting_key"],
                "name": display_name(m),
                "official": m.get("meeting_official_name"),
                "location": m["location"],
                "country": m.get("country_name"),
                "country_code": m.get("country_code"),
                "circuit": m.get("circuit_short_name"),
                "start": m["date_start"], "end": m.get("date_end"),
                "cancelled": cancelled,
                "race_key": race and race["session_key"],
                "podium": race and podium(race["session_key"]),
                "after": race and standings_after(race["session_key"]),
                "sessions": [{"key": s["session_key"], "name": s["session_name"], "type": s["session_type"],
                              "start": s["date_start"], "end": s["date_end"],
                              "cancelled": bool(s.get("is_cancelled"))} for s in ss],
            })
        out["years"][str(y)] = rows
        print(f"{y}: {len(rows)} weekends, {rnd} rounds", flush=True)
    (DATA / "calendar.json").write_text(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
