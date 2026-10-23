"""
Build data/history.json: every Grand Prix result since 1950 plus season points
totals and driver birthdays, from the Jolpica F1 API (the Ergast successor).
The page uses it for the all-time records that could fall in a race.

    python3 build_history.py            fetch what's missing, refresh the current season

Raw API pages are cached in data/jolpica/, so a re-run only fetches the
current season again (a few requests). Jolpica allows ~500 requests an hour
without a key; a first full run needs about 450.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
CACHE = DATA / "jolpica"
API = "https://api.jolpi.ca/ergast/f1"
CACHE.mkdir(parents=True, exist_ok=True)
THIS_YEAR = datetime.now(timezone.utc).year
CACHE_ONLY = "--cache-only" in sys.argv  # build from what's downloaded so far (for testing)


def get(path, fresh=False):
    """One API page, cached on disk (the current season is always re-fetched)."""
    f = CACHE / (path.replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "-") + ".json")
    if f.exists() and (not fresh or CACHE_ONLY):
        return json.loads(f.read_text())
    if CACHE_ONLY:
        return None
    for attempt in range(40):  # the hourly limit can take a while to refill
        try:
            with urllib.request.urlopen(f"{API}/{path}", timeout=60) as r:
                d = json.load(r)["MRData"]
            time.sleep(0.8)
            f.write_text(json.dumps(d))
            return d
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = min(30 * (attempt + 1), 180)
                print(f"  rate limited, waiting {wait}s", flush=True)
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"gave up on {path}")


def paged(path, key, fresh=False):
    out, offset = [], 0
    while True:
        sep = "&" if "?" in path else "?"
        d = get(f"{path}{sep}limit=100&offset={offset}", fresh)
        if d is None:
            return out
        out.append(d)
        offset += 100
        if offset >= int(d["total"]):
            return out


def main():
    first = 1950
    races = {}  # (season, round) -> race
    for year in range(first, THIS_YEAR + 1):
        fresh = year == THIS_YEAR
        for page in paged(f"{year}/results.json", "Races", fresh):
            for r in page["RaceTable"]["Races"]:
                k = (int(r["season"]), int(r["round"]))
                race = races.setdefault(k, {"season": k[0], "round": k[1], "name": r["raceName"], "date": r["date"],
                                            "circuit": r["Circuit"]["circuitId"], "results": []})
                for x in r["Results"]:
                    race["results"].append([
                        x["Driver"]["driverId"], x["Constructor"]["constructorId"],
                        int(x["position"]) if x.get("positionText", "").isdigit() else None,
                        int(x.get("grid") or 0), float(x.get("points") or 0), int(x["number"]) if str(x.get("number") or "").isdigit() else 0,
                    ])
        print(f"{year}: {sum(1 for k in races if k[0] == year)} races", flush=True)

    # poles: the official credit goes to whoever starts at the front of the grid
    # (penalties promote the next driver; 2021 sprint winners took pole), so use
    # grid 1, and qualifying P1 only where no grid-1 starter is recorded
    for year in range(1994, THIS_YEAR + 1):
        for page in paged(f"{year}/qualifying.json", "Races", year == THIS_YEAR):
            for r in page["RaceTable"]["Races"]:
                k = (int(r["season"]), int(r["round"]))
                if k in races:
                    for q in r["QualifyingResults"]:
                        if q["position"] == "1":
                            races[k]["pole"] = q["Driver"]["driverId"]
    for race in races.values():
        g1 = next((x[0] for x in race["results"] if x[3] == 1), None)
        race["pole"] = g1 or race.get("pole")

    # sprint races (2021 on): kept apart - official stats don't count them as wins
    sprints = []
    for year in range(2021, THIS_YEAR + 1):
        for page in paged(f"{year}/sprint.json", "Races", year == THIS_YEAR):
            for r in page["RaceTable"]["Races"]:
                sprints.append({"season": int(r["season"]), "round": int(r["round"]), "name": r["raceName"], "date": r["date"],
                                "results": [[x["Driver"]["driverId"], x["Constructor"]["constructorId"],
                                             int(x["position"]) if x.get("positionText", "").isdigit() else None,
                                             int(x.get("grid") or 0), float(x.get("points") or 0),
                                             int(x["number"]) if str(x.get("number") or "").isdigit() else 0] for x in r["SprintResults"]]})

    # season points (handles every era's scoring, shared drives and sprints)
    standings, teams = {}, {}
    for year in range(first, THIS_YEAR + 1):
        d = get(f"{year}/driverStandings.json?limit=100", year == THIS_YEAR)
        if d is None:
            continue
        lists = d["StandingsTable"]["StandingsLists"]
        if lists:
            standings[year] = {s["Driver"]["driverId"]: float(s["points"]) for s in lists[0]["DriverStandings"]}

    drivers = {}
    for page in paged("drivers.json", "Drivers", True):
        for x in page["DriverTable"]["Drivers"]:
            drivers[x["driverId"]] = {"code": x.get("code"), "name": f"{x['givenName']} {x['familyName']}",
                                      "dob": x.get("dateOfBirth"), "number": x.get("permanentNumber")}
    for page in paged("constructors.json", "Constructors", True):
        for x in page["ConstructorTable"]["Constructors"]:
            teams[x["constructorId"]] = x["name"]

    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "Jolpica F1 (Ergast) API",
           "drivers": drivers, "teams": teams, "standings": standings,
           "races": [races[k] for k in sorted(races)], "sprints": sprints}
    add_recent_from_openf1(out)
    (DATA / ("history_test.json" if CACHE_ONLY else "history.json")).write_text(json.dumps(out, separators=(",", ":")))
    last = out["races"][-1]
    print(f"history.json: {len(out['races'])} races, last {last['season']} R{last['round']} {last['name']}", flush=True)


def add_recent_from_openf1(out):
    """Races we recorded ourselves that Jolpica hasn't published yet (it usually
    lags a day): take the official classification from OpenF1 so the records
    are right straight after the flag."""
    cal_f = DATA / "calendar.json"
    if not cal_f.exists():
        return
    cal = json.loads(cal_f.read_text())
    have = {r["date"] for r in out["races"]}
    # OpenF1 car number -> Jolpica driver id / team, from this season's results
    num_to_id, id_team = {}, {}
    for r in out["races"]:
        if r["season"] == THIS_YEAR:
            for x in r["results"]:
                if len(x) > 5 and x[5]:
                    num_to_id[x[5]] = x[0]
                id_team[x[0]] = x[1]
    code_to_id = {v.get("code"): k for k, v in out["drivers"].items() if v.get("code")}
    added = 0
    for w in cal["years"].get(str(THIS_YEAR), []):
        key = w.get("race_key")
        race_s = next((x for x in w.get("sessions", []) if x["name"] == "Race"), None)
        f = DATA / str(key) / "session.json"
        if not key or not race_s or not f.exists() or race_s["start"][:10] in have:
            continue
        b = json.loads(f.read_text())
        res = b.get("session_result") or []
        if not res:
            try:
                from fetch_session import get as of1
                res = of1("session_result", session_key=key)
            except Exception as e:  # noqa: BLE001
                print(f"  no classification for {w['name']}: {e}")
                continue
        if not res:
            continue
        codes = {d["driver_number"]: d.get("name_acronym") for d in b["drivers"]}
        grid = {}
        for p in sorted(b.get("position", []), key=lambda p: p["date"]):
            grid.setdefault(p["driver_number"], p["position"])
        rows = []
        for x in res:
            n = x["driver_number"]
            did = num_to_id.get(n) or code_to_id.get(codes.get(n))
            if not did:
                continue
            pos = x.get("position") if not (x.get("dnf") or x.get("dns") or x.get("dsq")) else None
            rows.append([did, id_team.get(did, ""), pos, grid.get(n, 0), float(x.get("points") or 0), n])
        pole = next((r[0] for r in rows if r[3] == 1), None)
        out["races"].append({"season": THIS_YEAR, "round": w.get("round"), "name": w["name"], "date": race_s["start"][:10],
                             "circuit": w.get("circuit"), "results": rows, "pole": pole, "source": "openf1"})
        added += 1
        print(f"  added {w['name']} from OpenF1 ({len(rows)} drivers)")
    out["races"].sort(key=lambda r: (r["season"], r["date"]))


if __name__ == "__main__":
    sys.exit(main())
