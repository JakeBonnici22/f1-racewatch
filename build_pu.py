"""
Build data/pu.json: how many power unit elements each driver has used this
season, what each driver's next new element would cost on the grid, and the
grid penalties already handed out. Everything comes from the FIA's own event
documents (the Technical Delegate's reports and the stewards' decisions):

    "PU Elements used per Driver up to now"   a snapshot at the start of each event
    "New PU Elements for this Competition"    elements fitted during the event
    "Infringement - Car N - ... PU element"   the penalty decision

    .venv/bin/python build_pu.py            current season
    .venv/bin/python build_pu.py 2026

PDFs are cached in data/fia/<year>/, so a re-run only downloads new documents.
Needs pdfplumber (requirements.txt).
"""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).parent
DATA = ROOT / "data"
FIA = "https://www.fia.com"
CHAMP = "/documents/championships/fia-formula-one-world-championship-14"
UA = {"User-Agent": "Mozilla/5.0 (compatible; RaceWatch)"}

ORDER = ["ICE", "TC", "EXH", "MGU-K", "ES", "PU-CE", "PU-ANC"]
NAMES = {
    "ICE": "Internal combustion engine", "TC": "Turbocharger", "EXH": "Exhaust set",
    "MGU-K": "Motor generator unit (kinetic)", "ES": "Energy store (battery)",
    "PU-CE": "Control electronics", "PU-ANC": "Ancillary components",
}
# 2026 Sporting Regulations B8.2.2 (one bonus element of each type for the new
# engine rules); overwritten by any limit the FIA documents state themselves
LIMITS = {2026: {"ICE": 4, "TC": 4, "EXH": 4, "MGU-K": 3, "ES": 3, "PU-CE": 3, "PU-ANC": 6}}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            wait = 5 * (i + 1)
            if getattr(e, "code", None) == 429:  # fia.com rate limit: back off properly
                wait = int(e.headers.get("Retry-After") or 0) or 60 * (i + 1)
            log("retry in", wait, "s:", url, e)
            time.sleep(wait)


def season_url(year):
    """The current season sits at the championship root; older ones have their own page."""
    root = get(FIA + CHAMP).decode("utf-8", "ignore")
    for val, label in re.findall(r'<option value="([^"]+)">\s*SEASON (\d{4})', root):
        if int(label) == year:
            return val if "/season/" in val else None
    return None


def events(year):
    page = season_url(year)
    if page is None:  # current season: its event links live on the season page itself
        root = get(FIA + CHAMP).decode("utf-8", "ignore")
        m = re.search(r'value="(/documents/championships/fia-formula-one-world-championship-14/season/season-%d-\d+)/event/' % year, root)
        page = m.group(1) if m else None
    if not page:
        raise SystemExit(f"no FIA document pages found for {year}")
    s = get(FIA + page).decode("utf-8", "ignore")
    names = sorted(set(urllib.parse.unquote(n) for n in re.findall(re.escape(page) + r'/event/([^"]+)"', s)))
    return page, names


def documents(page, event):
    s = get(FIA + page + "/event/" + urllib.parse.quote(event)).decode("utf-8", "ignore")
    docs = []
    for href, body in re.findall(r'href="([^"]+\.pdf)"[^>]*>(.*?)</a>', s, re.S):
        text = html.unescape(" ".join(re.sub(r"<[^>]+>", " ", body).split()))
        m = re.match(r"Doc (\d+) - (.*?) Published on (\d\d)\.(\d\d)\.(\d\d) (\d\d):(\d\d)", text)
        if not m:
            continue
        no, title, d, mo, y, h, mi = m.groups()
        docs.append({"no": int(no), "title": title.strip(), "url": urllib.parse.urljoin(FIA, href),
                     "published": f"20{y}-{mo}-{d}T{h}:{mi}"})
    return sorted(docs, key=lambda d: d["no"])


def pdf_text(year, doc):
    cache = DATA / "fia" / str(year) / doc["url"].rsplit("/", 1)[-1]
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(get(doc["url"]))
        time.sleep(1)  # be gentle with fia.com
    with pdfplumber.open(cache) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)


ROW7 = re.compile(r"^(\d{1,2})\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$")


def parse_snapshot(text):
    """'PU Elements used per Driver up to now': one row per driver, columns in ORDER."""
    out = {}
    for line in text.splitlines():
        m = ROW7.match(line.strip())
        if m:
            n, label, *vals = m.groups()
            out[int(n)] = {"label": label, "used": dict(zip(ORDER, map(int, vals)))}
    return out


def parse_new(text):
    """'New PU Elements for this Competition': per element, the drivers fitting a new
    one and how many they had before. Also picks up the limits the FIA quotes."""
    rows, limits, elem = [], {}, None
    for line in text.splitlines():
        line = line.strip()
        m = re.search(r"with a new .*?\(([A-Z][A-Z\-]+)\)", line)
        if m:
            elem = m.group(1)
            continue
        m = re.match(r"^(\d{1,2})\s+(.+?)\s+(\d+)$", line)
        if m and elem in ORDER:
            rows.append({"n": int(m.group(1)), "label": m.group(2), "elem": elem, "prev": int(m.group(3))})
            continue
        m = re.search(r"of the (\w+) \((\d+)\) new", line)
        if m and elem in ORDER:
            limits[elem] = int(m.group(2))
    return rows, limits


def parse_penalty(text):
    """A stewards' decision on PU elements: driver, the elements, and the decision."""
    flat = " ".join(text.split())
    drv = re.search(r"No / Driver (\d+) - (.+?) Competitor", flat)
    fact = re.search(r"Fact (.+?) Infringement", flat)
    dec = re.search(r"Decision (.+?) Reason", flat)
    if not (drv and dec):
        return None
    decision = dec.group(1).strip()
    places = re.search(r"Drop of (\d+) grid positions", decision)
    elems = re.findall(r"(\d+)(?:st|nd|rd|th) ([A-Za-z ]+?) \(([A-Z][A-Z\-]+)\)", fact.group(1) if fact else "")
    return {"n": int(drv.group(1)), "driver": drv.group(2).strip(), "decision": decision,
            "places": int(places.group(1)) if places else None,
            "pit_lane": "pit lane" in decision.lower(),
            "elements": [{"nth": int(k), "elem": e} for k, _, e in elems]}


def drivers_info(year):
    """Acronym, name, team and colour per car number, from the newest saved session."""
    idx = json.loads((DATA / "index.json").read_text()) if (DATA / "index.json").exists() else []
    for e in sorted((x for x in idx if x.get("year") == year), key=lambda x: x["date"], reverse=True):
        f = DATA / str(e["session_key"]) / "session.json"
        if f.exists():
            b = json.loads(f.read_text())
            return {d["driver_number"]: {"acronym": d.get("name_acronym"), "name": d.get("full_name"),
                                         "team": d.get("team_name"), "colour": d.get("team_colour")}
                    for d in b.get("drivers", [])}
    return {}


def guess_driver(label, labels, info):
    """A driver missing from the latest session (a stand-in, say): take the team from
    whichever known car's FIA label starts the same way, the rest is the name."""
    words, best = label.split(), (0, None)
    for n, other in labels.items():
        if n not in info:
            continue
        ow = other.split()
        k = next((i for i, (a, b) in enumerate(zip(words, ow)) if a != b), min(len(words), len(ow)))
        if k > best[0]:
            best = (k, n)
    k, n = best
    if not n:
        return {"name": label}
    return {"name": " ".join(words[k:]), "team": info[n]["team"], "colour": info[n]["colour"],
            "acronym": words[-1][:3].upper() if words[k:] else None}


def main():
    year = int(sys.argv[1]) if len(sys.argv) > 1 else datetime.now(timezone.utc).year
    limits = dict(LIMITS.get(year, LIMITS[2026]))
    page, names = events(year)
    log(f"{year}: {len(names)} events on fia.com")
    # each event's document list is cached; only events with recent documents are
    # fetched again, so an hourly run costs fia.com two or three page loads
    cache_f = DATA / "fia" / str(year) / "events.json"
    cache = json.loads(cache_f.read_text()) if cache_f.exists() else {}
    recent = (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M")
    evs = []
    for name in names:
        docs = cache.get(name)
        if not docs or max(d["published"] for d in docs) >= recent:
            docs = documents(page, name)
            cache[name] = docs
            time.sleep(0.5)
        if not docs:
            continue
        pick = lambda pat: [d for d in docs if re.search(pat, d["title"], re.I)]
        evs.append({"name": name, "start": min(d["published"] for d in docs),
                    "snapshot": pick(r"^PU Elements used per Driver"),
                    "new": pick(r"^New PU Elements"),
                    "penalties": pick(r"^Infringement - Car \d+ - .*PU element")})
    cache_f.parent.mkdir(parents=True, exist_ok=True)
    cache_f.write_text(json.dumps(cache))
    evs.sort(key=lambda e: e["start"])

    used, labels, history, penalties = {}, {}, [], []
    for i, ev in enumerate(evs, 1):
        if ev["snapshot"]:  # the FIA's own count at the start of the event resets ours
            snap = parse_snapshot(pdf_text(year, ev["snapshot"][-1]))
            for n, r in snap.items():
                used[n] = dict(r["used"]); labels[n] = r["label"]
        fitted = []
        for d in ev["new"]:
            rows, lim = parse_new(pdf_text(year, d))
            limits.update(lim)
            for r in rows:
                u = used.setdefault(r["n"], {k: 0 for k in ORDER})
                u[r["elem"]] = max(u.get(r["elem"], 0), r["prev"] + 1)
                labels.setdefault(r["n"], r["label"])
                fitted.append({"n": r["n"], "elem": r["elem"], "count": r["prev"] + 1})
        for d in ev["penalties"]:
            p = parse_penalty(pdf_text(year, d))
            if p:
                penalties.append({**p, "event": ev["name"], "round": i, "doc": d["url"], "published": d["published"]})
        history.append({"event": ev["name"], "round": i, "start": ev["start"], "fitted": fitted,
                        "snapshot": bool(ev["snapshot"])})
        log(f"R{i} {ev['name']}: snapshot={'yes' if ev['snapshot'] else 'no'} new={len(fitted)} penalties={len(ev['penalties'])}")

    info = drivers_info(year)
    latest = next((h for h in reversed(history) if h["snapshot"] or h["fitted"]), None)
    fresh = {(f["n"], f["elem"]) for f in (latest["fitted"] if latest else [])}
    drivers = []
    for n, u in sorted(used.items()):
        meta = info.get(n) or guess_driver(labels.get(n) or "", labels, info)
        drivers.append({"n": n, "label": labels.get(n), **meta,
                        "used": {k: u.get(k, 0) for k in ORDER},
                        "fresh": [e for e in ORDER if (n, e) in fresh]})
    out = {"season": year, "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "latest_event": latest["event"] if latest else None, "latest_round": latest["round"] if latest else None,
           "order": ORDER, "names": NAMES, "limits": limits, "drivers": drivers,
           "penalties": penalties, "events": history,
           "source": "FIA Technical Delegate reports and Stewards' decisions, fia.com"}
    (DATA / "pu.json").write_text(json.dumps(out, indent=1))
    log(f"wrote data/pu.json: {len(drivers)} drivers, {len(penalties)} PU penalties, latest {out['latest_event']}")


if __name__ == "__main__":
    main()
