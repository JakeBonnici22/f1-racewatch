# Race Watch

A live Formula 1 race dashboard: a track map with every car moving in real
time in the middle, and the things you actually want to know during a race
around it. Built on [OpenF1](https://openf1.org) data.

## What it shows

- **Live track map** with every car, and a timing board (gaps, tyres, pit
  stops) whose columns you can add, hide and reorder; panels resize.
- **Race calls**: who catches whom and when, undercut chances, where a car
  rejoins after a stop, and what a stop costs at this track (from previous
  races there, updated as stops happen).
- **Analysis**: gaps and fights over time, a tyre strategy chart, and a
  speed trace (one lap of a driver against a rival: speed, gap, throttle,
  brake, gear).
- **Team radio**, in step with the timeline, so rewinding never spoils what
  comes next.
- **Qualifying mode**: the knockout line, who is safe, and what time each
  driver needs to get through.
- **Title fight and records**: who can still win the championship, the
  clinch scenarios for the next weekend, and all-time records that could fall
  in this race.
- **Lobby** first: the next live session with a countdown (or a "Watch live"
  button while one is on), this weekend's sessions, and every finished session
  as a clearly marked replay.
- **Power units**: how many of each engine part every driver has used against
  the season allowance, what the next new part would cost on the grid, and
  every power unit penalty so far, read from the FIA's own documents.
- **Cost cap**: the cap, what it excludes, and every team's compliance record
  (spending itself isn't published).

## How it works

```
OpenF1  ──REST catch-up + MQTT push──▶  live_server.py  ──/live/bundle every 1 s──▶  browser
                                          │  keeps the session in memory,
                                          │  saves it to data/<session_key>/
                                          ▼
                                     replays = the same JSON files
```

The page is plain HTML/JS with no build step. A replay is a pure function of
the clock, so live mode is just the replay engine pointed at the live edge
(minus the delay you set to match your TV).

## Run it locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
python3 fetch_session.py          # cache the most recent race (free OpenF1 tier)
python3 build_calendar.py         # race calendar for the archive
python3 build_history.py          # optional: all-time records (Jolpica API, ~450 requests on the first run)
.venv/bin/python build_pu.py      # optional: power unit usage from FIA documents
python3 build_preview.py          # the lobby's moving mini map (latest race, one lap)
.venv/bin/python live_server.py   # then open http://127.0.0.1:8765
```

Live sessions need OpenF1 sponsor access: copy `.env.example` to `.env` and
fill in the login. Without it the server serves replays only. From 45 minutes
before a session the server follows it on its own; the page opens straight
into live mode.

To test the live pipeline without a session, replay a cached race (any
`session_key` in `data/index.json`) as if it were live:

```sh
.venv/bin/python live_server.py --simulate SESSION_KEY --from-min -3 --speed 4 --port 8766
# open http://127.0.0.1:8766/?live=1
```

## Run it on a server

Everything needed is in `deploy/` as templates (replace `YOUR_USER` and
`/path/to/f1-racewatch`):

- `racewatch.service.example`: the server as a systemd service. Keep the
  login in `~/.config/racewatch/env` (see `.env.example`), outside the served
  folder.
- `racewatch-refresh.*.example`: a daily refresh of history and calendar.
- `racewatch-pu.*.example`: an hourly power unit refresh from the FIA documents.
- `racewatch-tunnel.service.example` + `tunnel.yml.example`: a public address
  through a Cloudflare named tunnel, with no ports opened on your network.
  Create the tunnel with `cloudflared tunnel create racewatch` and point a
  proxied CNAME for your domain at `<tunnel-id>.cfargotunnel.com`.
- `post-receive.example`: push-to-deploy from a bare repo on the server.
  `./deploy.sh` pushes to GitHub and the server; its settings live in
  `local/deploy.env`, which git ignores.
- `ha-automation.yaml`: an optional phone alert (here via Home Assistant)
  when live data stops during a session.

The server only ever serves the page, its scripts and styles, and
`data/**.json`; never `.env`, Python files, logs or the virtualenv. Speed
traces and radio are fetched from OpenF1 on demand only for sessions the
server already has, capped at 20 uncached calls a minute so visitors can't
use up the live feed's rate limit.

## Offline tools (Node)

```sh
node build_priors.mjs   # pit-stop losses per track from cached races -> data/priors.json
node backtest.mjs       # hit rates of the race calls over every cached race
```

Both run the dashboard's own browser code in a Node VM, so the numbers are
what the page produces.

## Data and credits

Live and session data from [OpenF1](https://openf1.org); race history from
the [Jolpica F1 API](https://github.com/jolpica/jolpica-f1) (the Ergast
successor); power unit usage and penalties from the FIA's published event
documents; cost cap facts from FIA announcements (sources listed on the page). Check OpenF1's terms before running a public instance with a
sponsor login.

This is an unofficial fan project, not associated with Formula 1 companies.
F1, FORMULA ONE and related marks are trademarks of Formula One Licensing B.V.

## Licence

No open-source licence: the code is public to read, all rights reserved.
