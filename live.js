// Live mode: follows a session as it happens, fed by live_server.py.
// The server collects OpenF1 rows; this file pulls new ones every second,
// rebuilds the session every couple of seconds with the same prepare() the
// replays use, and keeps the clock at the "live edge" - the latest moment we
// have car positions for, minus any TV delay you set. Scrub back to rewind;
// "Go live" returns to the edge.
'use strict';

const LIVE_DELAY_KEY = 'racewatch.tvDelay';
window.liveInfo = null; // last /live/status, read by races.js for the pill and Tune in

const live = {
  on: false, since: 0, sessionKey: null, raw: null, locBuf: new Map(), keys: {},
  clock: null, // {ms, perf, rate}: server session time at a moment, to interpolate
  follow: true, dirty: false, lastBuild: 0, built: false,
  refTrack: null, refLaps: 0, priors: null, polling: false, failures: 0, lag: null, lagSamples: [],
  delay: (() => { try { return Number(localStorage.getItem(LIVE_DELAY_KEY)) || 0; } catch { return 0; } })(),
};

// same identity rules as the server, so an updated row replaces the old one
function liveKey(ep, r) {
  const n = r.driver_number;
  switch (ep) {
    case 'laps': case 'pit': return `${n}_${r.lap_number}`;
    case 'stints': return `${n}_${r.stint_number}`;
    case 'drivers': case 'championship_drivers': case 'session_result': return String(n);
    case 'championship_teams': return r.team_name;
    case 'race_control': return `${r.date}_${r.category}_${r.message}`;
    case 'weather': return r.date;
    default: return `${r.date}_${n}`;
  }
}

async function liveStatus() {
  try {
    const r = await fetch('/live/status', { cache: 'no-store' });
    window.liveInfo = r.ok ? await r.json() : null;
  } catch { window.liveInfo = null; }
  if (typeof renderNextPill === 'function') renderNextPill();
  return window.liveInfo;
}

function liveNow() {
  const c = live.clock;
  return c ? c.ms + (performance.now() - c.perf) * c.rate : 0;
}
// newest moment most cars have positions for (a few seconds behind real time)
function liveDataHead() {
  const lasts = [];
  for (const b of live.locBuf.values()) if (b.n) lasts.push(b.t[b.n - 1]);
  if (!lasts.length) return null;
  lasts.sort((a, b) => a - b);
  return lasts[Math.floor(lasts.length / 2)];
}
// The clock runs smoothly at real speed, a little behind the newest data:
// OpenF1 rows arrive a few seconds late and we fetch once a second, so we
// stay (worst recent lag + 1.2 s) behind "now" and the cars never run out of
// positions to glide between. `lag` eases towards that target, so a change in
// lag speeds the clock up or slows it down a touch instead of jumping.
function liveLagTarget() {
  // a high percentile of recent lags, ignoring the huge ones measured while a
  // (re)starting server is still filling up
  const all = live.lagSamples, rate = live.clock?.rate || 1;
  const w = all.filter((x) => x < 30_000 * rate).sort((a, b) => a - b);
  const base = w.length ? w[Math.min(w.length - 1, Math.floor(w.length * 0.8))] : all.length ? Math.min(...all) : 3000;
  return base + 1800 * rate;
}
function liveEdge() {
  if (live.lag == null) live.lag = liveLagTarget();
  return liveNow() - live.lag - live.delay * 1000;
}

// Car positions live in growing typed arrays per driver. Appending is cheap,
// and the map reads them through views that are refreshed at every poll, so
// new positions show up within a second without rebuilding the session.
function locPush(n, t, x, y) {
  let b = live.locBuf.get(n);
  if (!b) { b = { t: new Float64Array(8192), x: new Float32Array(8192), y: new Float32Array(8192), n: 0 }; live.locBuf.set(n, b); }
  if (b.n && t <= b.t[b.n - 1]) return; // late or repeated sample
  if (b.n === b.t.length) {
    const grow = (A) => { const z = new A.constructor(A.length * 2); z.set(A); return z; };
    b.t = grow(b.t); b.x = grow(b.x); b.y = grow(b.y);
  }
  b.t[b.n] = t; b.x[b.n] = x; b.y[b.n] = y; b.n++;
}
function locViews() {
  const m = new Map();
  for (const [n, b] of live.locBuf) if (b.n) m.set(n, { t: b.t.subarray(0, b.n), x: b.x.subarray(0, b.n), y: b.y.subarray(0, b.n) });
  return m;
}

function liveMerge(rows) {
  const raw = live.raw;
  for (const row of rows) {
    if (row[0] === 'L') {
      const [, n, t, x, y] = row;
      locPush(n, t, x, y);
      continue;
    }
    const [ep, r] = row;
    if (!raw[ep]) raw[ep] = [];
    const keys = (live.keys[ep] ||= new Map());
    const k = liveKey(ep, r), i = keys.get(k);
    if (i == null) { keys.set(k, raw[ep].length); raw[ep].push(r); } else raw[ep][i] = r;
  }
  if (rows.length) live.dirty = true;
}

function liveBuild() {
  const prev = state.data;
  const d = prepare(live.raw, {}); // positions are attached below, not copied
  d.location = locViews();
  // a session that hasn't started yet has no laps: anchor on the scheduled start
  if (!Number.isFinite(d.lightsOut)) d.lightsOut = 0;
  d.tStart = Math.min(d.lightsOut - 5 * 60_000, prev?.live ? prev.tStart : Infinity);
  const finished = d.status.rows.some((s) => s.s === 'FINISH');
  d.tEnd = finished ? Math.max(d.tEnd, liveEdge()) : Math.max(liveEdge(), d.tStart + 60_000);
  if (!Number.isFinite(d.finish)) d.finish = d.tEnd;
  d.totalLaps = Math.max(d.totalLaps, live.refLaps || 0);
  d.totalLapsKnown = !!live.refLaps;
  d.live = true;
  // keep the outline and rotation steady once we have them; before the first
  // clean lap, borrow last year's outline
  const sameSession = prev?.live && prev.raw.session.session_key === d.raw.session.session_key;
  if (sameSession && prev.track?.length > 80 && prev.trackFromLive) { d.track = prev.track; d.trackFromLive = true; }
  else {
    const tr = buildTrack(d);
    if (tr.length > 80) { d.track = tr; d.trackFromLive = true; } else d.track = live.refTrack || [];
  }
  if (sameSession && prev.mapDeg != null && (d.trackFromLive === prev.trackFromLive)) d.mapDeg = prev.mapDeg;
  d.priors = live.priors;
  // race calls take ~70 ms to rebuild late in a race: refresh them every 8 s,
  // not on every 2 s rebuild, so the map never stutters
  if (sameSession && prev.calls && performance.now() - (live.callsAt || 0) < 8000) { d.calls = prev.calls; d.freshSamples = prev.freshSamples; }
  else live.callsAt = performance.now();
  const refit = !sameSession || d.track !== prev.track;
  state.data = d;
  live.dirty = false; live.lastBuild = performance.now();
  buildTimeline();
  if (refit) fitView();
  state.lastPanelUpdate = 0;
  if (!live.built) { live.built = true; setT(liveEdge()); liveLoading(); if (typeof renderNextPill === 'function') renderNextPill(); }
}

async function livePoll() {
  if (!live.on || live.polling) return;
  live.polling = true;
  try {
    let more = true;
    while (more && live.on) {
      const r = await fetch(`/live/bundle?since=${live.since}&session=${live.sessionKey ?? ''}${live.boot ? `&boot=${live.boot}` : ''}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`live feed ${r.status}`);
      const text = await r.text();
      const b = JSON.parse(text);
      if (!live.built) { live.loadedBytes = (live.loadedBytes || 0) + text.length; liveLoading(); }
      // the server restarted (its row numbers began again) or moved to another
      // session: it has answered from the beginning, so start over with this
      if (live.sessionKey != null && (b.session.session_key !== live.sessionKey || (live.boot && b.boot !== live.boot))) liveReset(b.session);
      live.boot = b.boot;
      if (live.sessionKey == null) liveReset(b.session);
      live.clock = { ms: b.now_ms, perf: performance.now(), rate: b.rate || 1 };
      liveMerge(b.rows);
      live.since = b.seq; more = b.more;
    }
    if (state.data?.live && live.built) state.data.location = locViews();
    const head = liveDataHead();
    if (head != null) { live.lagSamples.push(Math.max(0, liveNow() - head)); if (live.lagSamples.length > 15) live.lagSamples.shift(); }
    live.failures = 0;
  } catch (e) {
    live.failures++;
    console.warn('[live]', e.message);
  } finally {
    live.polling = false;
  }
  // rebuild at most every 2 s (more often while catching up is wasted work)
  if (live.dirty && (performance.now() - live.lastBuild > 2000 || !live.built)) liveBuild();
}

function liveReset(session) {
  live.sessionKey = session.session_key;
  live.raw = { session, drivers: [], laps: [], position: [], intervals: [], pit: [], stints: [], race_control: [], weather: [], championship_drivers: [], championship_teams: [] };
  live.locBuf = new Map(); live.keys = {}; live.since = 0; live.built = false; live.dirty = false;
  live.refTrack = null; live.refLaps = window.liveInfo?.ref_laps || 0; live.lag = null; live.lagSamples = [];
  state.selected = null; state.compare = null; state.ghost = null; state.feedKey = null; state.callsKey = null;
  state.seenRc = Infinity; state.seenPits = Infinity; state.callsSeen = Infinity;
  rowEls.clear(); $('#board').innerHTML = '';
  // pit-stop history and a reference outline from earlier races at this circuit
  fetch('data/priors.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((p) => { live.priors = priorsFor(p, session.circuit_key, session.date_start); if (state.data?.live) state.data.priors = live.priors; });
  const ref = window.liveInfo?.ref;
  if (ref) {
    Promise.all([fetch(`data/${ref}/session.json`).then((r) => r.json()), fetch(`data/${ref}/location.json`).then((r) => r.json())])
      .then(([raw, loc]) => {
        const rd = prepare(raw, loc);
        live.refTrack = rd.track.length ? rd.track : null;
        live.refLaps = live.refLaps || rd.totalLaps;
        live.dirty = true;
      }).catch(() => {});
  }
  if (typeof races !== 'undefined') { races.current = String(session.session_key); renderRaceButton(); }
}

let livePollTimer = null;
// while the race so far downloads (10-30 MB mid-race), say so instead of showing an empty page
function liveLoading() {
  const el = $('#live-loading');
  if (!el) return;
  el.hidden = !live.on || live.built;
  if (el.hidden) return;
  const mb = ((live.loadedBytes || 0) / 1e6).toFixed(1);
  const name = window.liveInfo?.session ? `${window.liveInfo.session.location} ${window.liveInfo.session.session_name}` : 'the session';
  el.innerHTML = `<span class="dot"></span><b>Joining ${name} live</b><span>Catching up on everything so far · ${mb} MB</span>`;
}

async function enterLive() {
  const st = window.liveInfo?.session ? window.liveInfo : await liveStatus();
  if (!st?.session) return false;
  origSetPlaying(false);
  live.on = true; live.follow = true; live.sessionKey = null; live.loadedBytes = 0;
  document.body.classList.add('is-live');
  renderLiveBadge(true); liveLoading();
  if (typeof renderNextPill === 'function') renderNextPill();
  history.replaceState(null, '', '?live=1');
  await livePoll();
  clearInterval(livePollTimer);
  livePollTimer = setInterval(livePoll, 1000);
  renderLiveBadge(true);
  return true;
}
function exitLive() {
  if (!live.on) return;
  live.on = false; live.sessionKey = null;
  clearInterval(livePollTimer);
  document.body.classList.remove('is-live');
  renderLiveBadge(true);
}

// called by the frame loop before anything renders
let lastTick = performance.now();
function liveTick() {
  if (!live.on || !state.data?.live) return;
  const nowP = performance.now(), dt = Math.min(200, nowP - lastTick); lastTick = nowP;
  const target = liveLagTarget();
  if (Math.abs(target - live.lag) > 10_000 * (live.clock?.rate || 1)) live.lag = target; // a big change: jump, don't fast-forward
  else live.lag += (target - live.lag) * Math.min(1, dt / 1500);
  const edge = liveEdge();
  const d = state.data;
  if (!d.status.rows.some((s) => s.s === 'FINISH') || edge > d.tEnd) d.tEnd = Math.max(d.tEnd, edge);
  const scrub = $('#scrub');
  if (Number(scrub.max) !== d.tEnd) scrub.max = d.tEnd;
  if (live.follow) setT(edge, true);
  else if (state.playing && state.t >= edge - 500) goLive(); // caught up
  renderLiveBadge();
}

let liveBadgeKey = '';
function renderLiveBadge(force) {
  const mode = $('#mode');
  let txt, cls;
  if (!live.on) { txt = state.playing ? 'Replaying' : 'Replay paused'; cls = ''; }
  else if (live.failures > 2) { txt = 'Live feed lost, retrying'; cls = 'live lost'; }
  else if (!live.built) { txt = 'Connecting…'; cls = 'live'; }
  else if (live.follow) { txt = live.delay ? `Live · ${live.delay}s delay` : 'Live'; cls = 'live'; }
  else {
    const b = Math.max(0, liveEdge() - state.t) / 1000;
    const ago = b < 3600 ? `${Math.floor(b / 60)}:${String(Math.floor(b % 60)).padStart(2, '0')}` : fmtClock(b * 1000);
    txt = `Live · ${state.playing ? '' : 'paused, '}${ago} behind`; cls = 'live behind';
  }
  const key = `${txt}|${cls}|${live.on}|${live.follow}|${live.delay}`;
  if (!force && key === liveBadgeKey) return;
  liveBadgeKey = key;
  mode.textContent = txt;
  mode.className = `mode ${cls}`;
  $('#play').textContent = live.on && live.follow ? '❚❚' : state.playing ? '❚❚' : '▶';
  const ctl = $('#live-ctl');
  ctl.hidden = !live.on;
  document.body.classList.toggle('live-edge', live.on && live.follow);
  $('#go-live').hidden = live.follow;
  $('#delay-val').textContent = `${live.delay}s`;
}

function setDelay(s) {
  live.delay = Math.max(0, Math.min(120, s));
  try { localStorage.setItem(LIVE_DELAY_KEY, String(live.delay)); } catch { /* not saved */ }
  renderLiveBadge(true);
}

// play button while following shows pause: pressing it freezes the picture
// here (like pausing live TV); play continues from there; Go live jumps back
function liveSetPlaying(p) {
  if (live.on && live.follow && p) { live.follow = false; origSetPlaying(false); }
  else origSetPlaying(p);
  if (live.on) renderLiveBadge(true);
}
function goLive() {
  origSetPlaying(false);
  live.follow = true; state.jumped = true; state.lastPanelUpdate = 0;
  renderLiveBadge(true);
}
let origSetPlaying = null;

// app.js init asks this first: on race day open straight into the live
// session (a simulation only with ?live=1)
async function liveAutoStart() {
  const st = await liveStatus();
  const want = new URLSearchParams(location.search).has('live');
  if (st?.live && (want || st.mode === 'live')) return enterLive();
  return false;
}

(function wireLive() {
  $('#go-live').addEventListener('click', goLive);
  $('#live-ctl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-delay]');
    if (b) setDelay(live.delay + Number(b.dataset.delay) * (e.shiftKey ? 5 : 1));
  });
  // any manual jump decides whether we're still at the live edge
  const origSetT = setT;
  window.setT = setT = function (t, fromPlayback = false) {
    origSetT(t, fromPlayback);
    if (live.on && !fromPlayback && live.built) live.follow = t >= liveEdge() - 1500;
  };
  origSetPlaying = setPlaying;
  window.setPlaying = setPlaying = liveSetPlaying;
  setInterval(liveStatus, 30_000);
})();
