// Race Watch - replays a cached OpenF1 session (see fetch_session.py).
// Every panel is a pure function of one clock value `state.t` (ms since the
// session's scheduled start), so a live source only has to append rows to the
// same arrays and keep `t` at "now".
'use strict';

const $ = (s) => document.querySelector(s);
const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
const TYRES = {
  SOFT: ['S', '#e8002d'], MEDIUM: ['M', '#ffd12e'], HARD: ['H', '#f0f0ec'],
  INTERMEDIATE: ['I', '#43b02a'], WET: ['W', '#2b7bff'],
};
const STATUS = {
  PRE: ['Pre-race', '#26303f'], GREEN: ['Green flag', '#34c27a'],
  SC: ['Safety car', '#f2c230'], SC_IN: ['Safety car in this lap', '#f2c230'],
  VSC: ['Virtual safety car', '#f2c230'], VSC_END: ['VSC ending', '#f2c230'],
  RED: ['Red flag', '#e5484d'], FINISH: ['Chequered flag', '#e4e9f0'],
};
const OUT_AFTER_MS = 30_000; // no location sample for this long = car is out

const state = {
  data: null, t: 0, playing: false, speed: 8, selected: null, compare: null, ghost: null, boardTab: 'timing',
  lastPanelUpdate: 0, seenRc: 0, seenPits: 0,
};

// ---------- helpers ----------
// index of the last element with times[i] <= t, or -1
function lastIdx(times, t) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function series(rows) { // rows already have .t; sorted copy + time index
  const r = rows.slice().sort((a, b) => a.t - b.t);
  return { rows: r, ts: r.map((x) => x.t) };
}
function at(s, t) { const i = s ? lastIdx(s.ts, t) : -1; return i < 0 ? null : s.rows[i]; }
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
function fmtLap(s) {
  if (s == null) return '';
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
}
function fmtGap(g) {
  if (g == null) return '';
  return typeof g === 'number' ? `+${g.toFixed(3)}` : String(g);
}
function fmtClock(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${neg ? '−' : ''}${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- data prep ----------
function prepare(raw, loc) {
  const t0 = Date.parse(raw.session.date_start);
  // OpenF1's live (MQTT) rows come without a time zone; they are UTC. Without
  // this the browser reads them as local time and they land 2 h early.
  const utc = (iso) => (/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  const rel = (iso) => Date.parse(utc(iso)) - t0;

  const drivers = new Map(raw.drivers.map((d) => [d.driver_number, {
    num: d.driver_number, code: d.name_acronym || String(d.driver_number),
    name: d.full_name, team: d.team_name || '',
    colour: d.team_colour ? `#${d.team_colour}` : '#888888',
  }]));

  const laps = new Map();
  for (const [n, rows] of groupBy(raw.laps.filter((l) => l.date_start), 'driver_number')) {
    const ls = rows.map((l) => ({
      t: rel(l.date_start), n: l.lap_number, dur: l.lap_duration,
      end: l.lap_duration ? rel(l.date_start) + l.lap_duration * 1000 : null,
      pitOut: l.is_pit_out_lap,
      s1: l.duration_sector_1, s2: l.duration_sector_2, s3: l.duration_sector_3, trap: l.st_speed,
    }));
    const s = series(ls);
    s.ends = s.rows.filter((l) => l.end != null).sort((a, b) => a.end - b.end);
    s.endTs = s.ends.map((l) => l.end);
    laps.set(n, s);
  }

  const mapSeries = (rows, f) => {
    const m = new Map();
    for (const [n, rs] of groupBy(rows, 'driver_number')) m.set(n, series(rs.map(f)));
    return m;
  };
  const position = mapSeries(raw.position, (r) => ({ t: rel(r.date), pos: r.position }));
  const intervals = mapSeries(raw.intervals, (r) => ({ t: rel(r.date), gap: r.gap_to_leader, int: r.interval }));
  const stints = groupBy(raw.stints, 'driver_number');
  const pits = series(raw.pit.map((p) => ({
    t: rel(p.date), num: p.driver_number, lap: p.lap_number,
    lane: p.lane_duration ?? p.pit_duration, stop: p.stop_duration,
  })));
  const rc = series(raw.race_control.map((r) => ({ ...r, t: rel(r.date) })));
  const weather = series(raw.weather.map((w) => ({ ...w, t: rel(w.date) })));

  // grid position = first position record per driver
  const grid = new Map();
  for (const [n, s] of position) if (s.rows.length) grid.set(n, s.rows[0].pos);

  const location = new Map();
  for (const [n, pts] of Object.entries(loc)) {
    if (!pts.length) continue;
    location.set(Number(n), {
      t: Float64Array.from(pts, (p) => p[0]),
      x: Float32Array.from(pts, (p) => p[1]),
      y: Float32Array.from(pts, (p) => p[2]),
    });
  }

  // track status timeline from race control
  const statusTl = [];
  let st = 'PRE';
  const push = (t, s) => { if (s !== st) { st = s; statusTl.push({ t, s }); } };
  statusTl.push({ t: -Infinity, s: 'PRE' });
  for (const r of rc.rows) {
    const m = (r.message || '').toUpperCase();
    if (r.category === 'SessionStatus' && m.includes('STARTED')) push(r.t, 'GREEN');
    else if (m === 'SAFETY CAR DEPLOYED') push(r.t, 'SC');
    else if (m === 'VSC DEPLOYED') push(r.t, 'VSC');
    else if (m.includes('VSC ENDING')) push(r.t, 'VSC_END');
    else if (m.includes('SAFETY CAR IN THIS LAP')) push(r.t, 'SC_IN');
    else if (r.flag === 'RED') push(r.t, 'RED');
    else if (r.flag === 'CHEQUERED') push(r.t, 'FINISH');
    else if ((r.flag === 'CLEAR' || r.flag === 'GREEN') && r.scope === 'Track' && st !== 'PRE' && st !== 'FINISH') push(r.t, 'GREEN');
  }
  const status = { rows: statusTl, ts: statusTl.map((x) => x.t) };

  const allLaps = [...laps.values()].flatMap((s) => s.rows);
  const totalLaps = Math.max(0, ...allLaps.map((l) => l.n));
  const lightsOut = statusTl.find((x) => x.s === 'GREEN')?.t ?? Math.min(...allLaps.map((l) => l.t));
  // qualifying has a chequered flag per part: the session ends at the last one
  const quali = /qualifying|shootout/i.test(raw.session.session_name || '');
  const flags = statusTl.filter((x) => x.s === 'FINISH');
  const finish = (quali ? flags.at(-1) : flags[0])?.t ?? Math.max(...allLaps.map((l) => l.end || l.t));

  // leader lap starts, for scrubber ticks
  const leaderLaps = [];
  for (let n = 1; n <= totalLaps; n++) {
    const starts = allLaps.filter((l) => l.n === n).map((l) => l.t);
    if (starts.length) leaderLaps.push({ n, t: Math.min(...starts) });
  }

  const d = {
    raw, t0, drivers, laps, position, intervals, stints, pits, rc, weather, grid,
    location, status, totalLaps, lightsOut, finish, leaderLaps,
    tStart: lightsOut - 5 * 60_000, tEnd: finish + 3 * 60_000,
  };
  d.track = buildTrack(d);
  return d;
}

// Track outline = the fastest clean lap's location trace.
function buildTrack(d) {
  const cands = [];
  for (const [n, s] of d.laps) for (const l of s.rows) {
    if (l.dur && !l.pitOut && l.n > 1 && d.location.has(n)) cands.push({ n, l });
  }
  cands.sort((a, b) => a.l.dur - b.l.dur);
  for (const { n, l } of cands.slice(0, 10)) {
    const L = d.location.get(n);
    const i0 = lastIdx(L.t, l.t), i1 = lastIdx(L.t, l.end);
    if (i1 - i0 < 80) continue;
    const pts = [];
    for (let i = Math.max(0, i0); i <= i1; i++) pts.push([L.x[i], L.y[i]]);
    return pts;
  }
  return [];
}

// ---------- state at time t ----------
function statusAt(t) { return at(state.data.status, t)?.s || 'PRE'; }

function carXY(L, t) {
  const i = lastIdx(L.t, t);
  if (i < 0 || t - L.t[i] > OUT_AFTER_MS) return null;
  if (i === L.t.length - 1) return [L.x[i], L.y[i]];
  const f = Math.min(1, (t - L.t[i]) / (L.t[i + 1] - L.t[i]));
  return [L.x[i] + (L.x[i + 1] - L.x[i]) * f, L.y[i] + (L.y[i + 1] - L.y[i]) * f];
}

function boardAt(t) {
  const d = state.data;
  let overallBest = Infinity;
  const ob = { s1: Infinity, s2: Infinity, s3: Infinity, trap: 0 }; // session bests so far
  const rows = [];
  for (const [n, drv] of d.drivers) {
    const pos = at(d.position.get(n), t)?.pos ?? d.grid.get(n) ?? 99;
    const iv = at(d.intervals.get(n), t);
    const lapsS = d.laps.get(n);
    const curLap = lapsS ? at(lapsS, t)?.n ?? 0 : 0;
    let last = null, best = Infinity, lastLap = null;
    const pb = { s1: Infinity, s2: Infinity, s3: Infinity, trap: 0 };
    if (lapsS) {
      const k = lastIdx(lapsS.endTs, t);
      if (k >= 0) { lastLap = lapsS.ends[k]; last = lastLap.dur; }
      for (let i = 0; i <= k; i++) {
        const l = lapsS.ends[i];
        best = Math.min(best, l.dur);
        if (l.s1) pb.s1 = Math.min(pb.s1, l.s1);
        if (l.s2) pb.s2 = Math.min(pb.s2, l.s2);
        if (l.s3) pb.s3 = Math.min(pb.s3, l.s3);
        if (l.trap) pb.trap = Math.max(pb.trap, l.trap);
      }
    }
    overallBest = Math.min(overallBest, best);
    for (const k of ['s1', 's2', 's3']) ob[k] = Math.min(ob[k], pb[k]);
    ob.trap = Math.max(ob.trap, pb.trap);
    const stint = (d.stints.get(n) || []).find((s) =>
      curLap >= s.lap_start && (s.lap_end == null || curLap <= s.lap_end));
    let pitsDone = 0, inPit = false, lastPitLap = null;
    for (const p of d.pits.rows) {
      if (p.num !== n || p.t > t) continue;
      pitsDone++;
      lastPitLap = p.lap;
      if (p.lane && t <= p.t + p.lane * 1000) inPit = true;
    }
    let tyre = stint ? { c: stint.compound, age: stint.tyre_age_at_start + Math.max(0, curLap - stint.lap_start), sure: true } : null;
    // OpenF1's stint feed sometimes misses a stop (stint keeps running across
    // a pit). A pit after the stint began means new tyres from the next lap:
    // reset the age and mark the compound as unconfirmed.
    if (tyre && lastPitLap != null && lastPitLap + 1 > stint.lap_start && lastPitLap < curLap) {
      tyre = { c: stint.compound, age: curLap - (lastPitLap + 1), sure: false };
    }
    const L = d.location.get(n);
    // out of the race: no location for 30 s; without location data (backtests),
    // no lap started or finished for 4 minutes
    let out;
    // after the flag, judge "out" at the flag: parked cars aren't retirements
    const tOut = d.status.rows.some((x) => x.s === 'FINISH') ? Math.min(t, d.finish + 60_000) : t;
    if (d.location.size) out = tOut > d.lightsOut && (!L || !carXY(L, tOut));
    else {
      const lastStart = lapsS ? at(lapsS, t)?.t ?? -Infinity : -Infinity;
      const lastEnd = lapsS ? lapsS.endTs[lastIdx(lapsS.endTs, t)] ?? -Infinity : -Infinity;
      out = t > d.lightsOut + 240_000 && t - Math.max(lastStart, lastEnd) > 240_000;
    }
    rows.push({ n, drv, pos, gap: iv?.gap, int: iv?.int, curLap, last, best, lastLap, pb, tyre, pitsDone, inPit, out, grid: d.grid.get(n) });
  }
  // stable order: position, then gap, then car number, so two cars briefly
  // sharing a position in the feed don't swap places on every refresh
  const gapNum = (r) => (typeof r.gap === 'number' ? r.gap : Infinity);
  rows.sort((a, b) => (a.out - b.out) || (a.pos - b.pos) || (gapNum(a) - gapNum(b)) || (a.n - b.n));
  return { rows, overallBest, ob };
}

// ---------- rendering: panels ----------
function renderTop(t) {
  const d = state.data;
  const s = statusAt(t);
  const el = $('#status');
  el.className = `status ${s}`;
  el.textContent = STATUS[s][0];

  if (!(typeof isQuali === 'function' && isQuali(d))) { // qualifying shows its part and time left instead
    const leaderLap = d.leaderLaps[lastIdx(d.leaderLaps.map((l) => l.t), t)]?.n ?? 0;
    $('#lap').textContent = leaderLap || '–';
    $('#lap-total').textContent = d.live && !d.totalLapsKnown ? '' : ` / ${d.totalLaps}`;
    $('.clockbox .lbl').textContent = 'Race time';
    $('#clock').textContent = fmtClock(t - d.lightsOut);
  }

  const w = at(d.weather, t);
  $('#weather').innerHTML = w ? `
    <span>Air <b>${w.air_temperature.toFixed(1)}°</b></span>
    <span>Track <b>${w.track_temperature.toFixed(1)}°</b></span>
    <span>Humidity <b>${Math.round(w.humidity)}%</b></span>
    <span>Wind <b>${w.wind_speed.toFixed(1)} m/s</b></span>
    <span class="${w.rainfall ? 'rain' : ''}">Rain <b>${w.rainfall ? 'Yes' : 'No'}</b></span>` : '';
}

// ---------- timing board: one persistent row per driver ----------
// Rows are kept (not rebuilt) so hover, focus and position changes survive
// the 5 Hz refresh; when the order changes, rows slide to their new place.
const rowEls = new Map();
function actLabel(n) {
  if (state.selected === n) return 'Unfollow';
  if (state.compare === n) return 'Remove';
  return state.selected == null ? 'Follow' : 'Compare';
}
function renderBoard(t) {
  document.body.classList.toggle('is-quali', typeof isQuali === 'function' && isQuali(state.data));
  if (typeof isQuali === 'function' && isQuali(state.data)) { renderQualiBoard(t); return; }
  const { rows, overallBest, ob } = boardAt(t);
  if (typeof ensureBoardHeader === 'function') ensureBoardHeader();
  state.lastBoard = rows;
  const tbody = $('#board');
  const leader = rows.find((r) => !r.out);
  const animate = !state.jumped && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  state.jumped = false;
  const before = new Map();
  if (animate) for (const [n, tr] of rowEls) if (tr.isConnected) before.set(n, tr.getBoundingClientRect().top);

  rows.forEach((r, i) => {
    let tr = rowEls.get(r.n);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.n = r.n; tr.tabIndex = 0;
      tr.style.setProperty('--team', r.drv.colour);
      rowEls.set(r.n, tr);
    }
    const gained = r.grid && !r.out ? r.grid - r.pos : 0;
    const delta = gained > 0 ? `<span class="delta-up">▲${gained}</span>` : gained < 0 ? `<span class="delta-down">▼${-gained}</span>` : '';
    const ty = r.tyre ? TYRES[r.tyre.c] || ['?', '#888'] : null;
    const lastCls = r.last == null ? '' : r.last === overallBest ? 'best' : r.last === r.best ? 'pb' : '';
    const isLeader = r === leader;
    const cx = { i, isLeader, delta, ty, lastCls, overallBest, ob, t };
    const html = `
      <td class="pos">${r.out ? '' : i + 1}</td>
      <td><div class="drv"><span class="bar"></span><b>${r.drv.code}</b>
        ${r.inPit ? '<span class="tag pit">In pit</span>' : ''}${r.out ? '<span class="tag out">Out</span>' : ''}
        <span class="team col-team">${r.drv.team}</span><span class="act" aria-hidden="true">${actLabel(r.n)}</span></div></td>
      ${boardColumns().map((k) => `<td class="${BOARD_COLS[k].num ? 'num ' : ''}c-${k}">${BOARD_COLS[k].cell(r, cx)}</td>`).join('')}<td class="td-add"></td>`;
    if (tr._html !== html) { tr.innerHTML = html; tr._html = html; }
    tr.className = [state.selected === r.n ? 'sel' : state.compare === r.n ? 'cmp' : '', r.out ? 'out' : ''].join(' ');
    tr.setAttribute('aria-label', `${r.drv.name}, ${actLabel(r.n).toLowerCase()}`);
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
  });
  while (tbody.children.length > rows.length) tbody.lastChild.remove();
  if (typeof fitBoardWidth === 'function' && state.fitKey !== state.headKey && rows.length) {
    state.fitKey = state.headKey; fitBoardWidth();
  }

  if (animate) {
    for (const r of rows) {
      const tr = rowEls.get(r.n), was = before.get(r.n);
      if (was == null) continue;
      const dy = was - tr.getBoundingClientRect().top;
      // slide one- or two-place changes (overtakes); snap bigger jumps (pit cycles)
      if (!dy || Math.abs(dy) > tr.offsetHeight * 2.5) continue;
      tr.style.transition = 'none';
      tr.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        tr.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1), background .25s';
        tr.style.transform = '';
      });
    }
  }
}

function rcColour(r) {
  const f = (r.flag || '').toUpperCase(), m = (r.message || '').toUpperCase();
  if (f === 'RED') return '#e5484d';
  if (f.includes('YELLOW') || r.category === 'SafetyCar') return '#f2c230';
  if (f === 'GREEN' || f === 'CLEAR') return '#34c27a';
  if (f === 'CHEQUERED') return '#e4e9f0';
  if (f === 'BLACK AND WHITE' || m.includes('PENALTY') || m.includes('INVESTIGAT')) return '#a970ff';
  return '#6f7b8d';
}

// Race control shouts in capitals; sentence case reads faster, but driver
// codes and acronyms stay upper case.
function tidyMsg(m) {
  const s = m.charAt(0) + m.slice(1).toLowerCase();
  return s.replace(/\(([a-z]{3})\)/g, (_, c) => `(${c.toUpperCase()})`)
    .replace(/\b(vsc|sc|drs|fia)\b/gi, (w) => w.toUpperCase());
}

// Feeds only re-render when something new arrives, so the highlight on a
// fresh message plays once and is not restarted five times a second.
function renderFeeds(t) {
  const d = state.data;
  const rcIdx = lastIdx(d.rc.ts, t);
  const pIdx = lastIdx(d.pits.ts, t);
  const costReady = (p) => p.loss != null && d.lapNo?.get(p.num)?.get(p.lap + 1)?.end <= t;
  const lossReady = d.pits.rows.filter((p, i) => i <= pIdx && costReady(p)).length;
  const key = `${rcIdx}:${pIdx}:${lossReady}`;
  if (key === state.feedKey) return;
  state.feedKey = key;

  // race control: newest first; blue flags and sector clears are noise during a race
  const msgs = [];
  for (let i = rcIdx; i >= 0 && msgs.length < 60; i--) {
    const r = d.rc.rows[i];
    if (r.flag === 'BLUE') continue;
    if (r.flag === 'CLEAR' && r.scope === 'Sector') continue;
    msgs.push({ r, i });
  }
  const freshRc = state.seenRc;
  $('#rc').innerHTML = msgs.map(({ r, i }) => `<li class="${i >= freshRc ? 'fresh' : ''}">
      <span class="when">${r.lap_number ? `L${r.lap_number}` : ''}</span>
      <span><span class="flag" style="background:${rcColour(r)}"></span>${tidyMsg(r.message)}</span></li>`).join('');
  state.seenRc = rcIdx + 1;

  const freshP = state.seenPits;
  const ps = d.pits.rows.slice(0, pIdx + 1).map((p, i) => ({ p, i })).reverse();
  $('#pits').innerHTML = ps.map(({ p, i }) => {
    const drv = d.drivers.get(p.num);
    return `<li class="${i >= freshP ? 'fresh' : ''}">
      <span class="when">L${p.lap}</span>
      <span><b style="color:${drv?.colour}">${drv?.code ?? p.num}</b>
      ${costReady(p) ? `lost <b>${p.loss.toFixed(1)}s</b> <span class="lost">(${p.lane ? p.lane.toFixed(1) + 's in the lane' : 'lane time n/a'})</span>`
             : `${p.lane ? p.lane.toFixed(1) + 's in the lane' : 'in the pit lane'}`}</span></li>`;
  }).join('') || '<li><span></span><span class="muted">No stops yet</span></li>';
  state.seenPits = pIdx + 1;
}

// ---------- rendering: map ----------
const canvas = $('#map');
const ctx = canvas.getContext('2d');
let view = null; // {rot, scale, ox, oy}

function fitView() {
  const d = state.data, pts = d?.track;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!pts || !pts.length) { view = null; return; }
  // pick the rotation that lets the circuit fill the panel best, once per
  // session: re-picking on every resize made the track spin when panels changed size
  let best = null;
  const degs = d.mapDeg != null ? [d.mapDeg] : Array.from({ length: 36 }, (_, i) => i * 5);
  for (const deg of degs) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      const rx = x * c - y * s, ry = x * s + y * c;
      x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
    }
    const pad = 44;
    const scale = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0));
    if (!best || scale > best.scale) best = { deg, a, c, s, scale, x0, x1, y0, y1, w, h };
  }
  const b = best;
  if (d.mapDeg == null && w > 100 && h > 100) d.mapDeg = b.deg;
  view = {
    c: b.c, s: b.s, scale: b.scale,
    ox: (b.w - (b.x1 - b.x0) * b.scale) / 2 - b.x0 * b.scale,
    // y is flipped: OpenF1 y grows "up", canvas y grows down
    oy: (b.h - (b.y1 - b.y0) * b.scale) / 2 + b.y1 * b.scale,
  };
}
function project(x, y) {
  const rx = x * view.c - y * view.s, ry = x * view.s + y * view.c;
  return [rx * view.scale + view.ox, -ry * view.scale + view.oy];
}
// dark text on light team colours (Haas white, McLaren papaya), light on dark
function inkFor(hex) {
  const v = parseInt(hex.slice(1), 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#121821' : '#ffffff';
}
// laps behind the leader, from the timing feed ("+1 LAP") or lap counts
function lapsDown(r, leader) {
  const m = typeof r.gap === 'string' && r.gap.match(/(\d+)\s*LAP/i);
  // only trust the timing feed: comparing lap counts flags every car as lapped
  // for a moment each time the leader crosses the line
  return m ? Number(m[1]) : 0;
}
function halo(px, py, label, fill, stroke = '#121821') {
  ctx.lineWidth = 3.5; ctx.strokeStyle = stroke; ctx.strokeText(label, px, py);
  ctx.fillStyle = fill; ctx.fillText(label, px, py);
}

function drawMap(t, board) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!view) return;
  const d = state.data;
  const status = statusAt(t);
  const now = performance.now();

  // track: a soft band (tinted under SC / red flag) and the tarmac on top
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const path = new Path2D();
  d.track.forEach(([x, y], i) => { const [px, py] = project(x, y); i ? path.lineTo(px, py) : path.moveTo(px, py); });
  path.closePath();
  const neutral = status === 'SC' || status === 'VSC' || status === 'SC_IN' || status === 'VSC_END';
  ctx.strokeStyle = neutral ? 'rgba(242,194,48,.35)' : status === 'RED' ? 'rgba(229,72,77,.4)' : '#1f2836';
  ctx.lineWidth = 20; ctx.stroke(path);
  ctx.strokeStyle = '#2f3a4b'; ctx.lineWidth = 11; ctx.stroke(path);

  // start/finish
  const [sx, sy] = project(...d.track[0]);
  const [nx, ny] = project(...d.track[Math.min(4, d.track.length - 1)]);
  const ang = Math.atan2(ny - sy, nx - sx) + Math.PI / 2;
  ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(sx - Math.cos(ang) * 12, sy - Math.sin(ang) * 12);
  ctx.lineTo(sx + Math.cos(ang) * 12, sy + Math.sin(ang) * 12);
  ctx.stroke();

  const pos = new Map();
  for (const r of board || []) {
    const L = d.location.get(r.n);
    const p = L && carXY(L, t);
    if (p) pos.set(r.n, project(p[0], p[1]));
  }
  const sel = state.selected, cmp = state.compare;
  const any = sel != null;

  // battle line between the followed car and the compared one, labelled with the gap
  if (sel != null && cmp != null && pos.has(sel) && pos.has(cmp)) {
    const [ax, ay] = pos.get(sel), [bx, by] = pos.get(cmp);
    ctx.setLineDash([2, 5]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(228,233,240,.55)';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    const ga = typeof gapAt === 'function' ? gapAt(d, sel, t) : null;
    const gb = typeof gapAt === 'function' ? gapAt(d, cmp, t) : null;
    if (ga != null && gb != null) {
      ctx.font = '600 12px Archivo, system-ui, sans-serif'; ctx.textAlign = 'center';
      halo((ax + bx) / 2, (ay + by) / 2 - 6, `${Math.abs(gb - ga).toFixed(1)}s`, '#e4e9f0');
      ctx.textAlign = 'left';
    }
  }

  // cars: back-markers first so the leaders sit on top; picked cars last of all
  const running = (board || []).filter((r) => !r.out);
  const leaderRow = running[0];
  const posOf = new Map(running.map((r, i) => [r.n, i + 1]));
  const order = (board || []).slice().reverse();
  order.sort((a, b) => ((a.n === sel || a.n === cmp) - (b.n === sel || b.n === cmp)));
  state.carScreen = [];
  for (const r of order) {
    const p = pos.get(r.n);
    if (!p) continue;
    const [px, py] = p;
    const isSel = r.n === sel, isCmp = r.n === cmp, on = isSel || isCmp;
    state.carScreen.push({ n: r.n, x: px, y: py });
    ctx.globalAlpha = any && !on ? 0.32 : 1;

    // a ring pulses outward once when a driver is picked
    if (on && state.pickedAt && state.pickedAt.n === r.n && now - state.pickedAt.t < 700) {
      const k = (now - state.pickedAt.t) / 700;
      ctx.beginPath(); ctx.arc(px, py, 10 + k * 22, 0, Math.PI * 2);
      ctx.strokeStyle = r.drv.colour; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // dot carries the running position; lapped cars get a dashed outline
    const place = posOf.get(r.n), down = lapsDown(r, leaderRow);
    const rad = on ? 10.5 : 8.5;
    ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fillStyle = r.drv.colour; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#121821'; ctx.stroke();
    if (down > 0) {
      ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(px, py, rad + 2.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#8b97a8'; ctx.stroke(); ctx.setLineDash([]);
    }
    if (place) {
      ctx.font = `700 ${place > 9 ? 9.5 : 10.5}px Archivo, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = inkFor(r.drv.colour); ctx.fillText(String(place), px, py + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    if (on) {
      if (isCmp) ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(px, py, rad + 4.5, 0, Math.PI * 2);
      ctx.lineWidth = 2; ctx.strokeStyle = '#e4e9f0'; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = `${on ? 700 : 600} ${on ? 13 : 11}px Archivo, system-ui, sans-serif`;
    const label = down > 0 ? `${r.drv.code} +${down}L` : r.drv.code;
    halo(px + rad + (on ? 6 : 4), py - (on ? 9 : 7), label, on ? '#ffffff' : down > 0 ? '#8b97a8' : '#c3cbd6');
    ctx.globalAlpha = 1;
  }

  // pit ghost: where the followed car would be in the field after a stop =
  // where it was itself `loss` seconds ago on its own trace
  if (state.ghost && sel != null) {
    const L = d.location.get(sel);
    const p = L && carXY(L, t - state.ghost.loss * 1000);
    if (p) {
      const [px, py] = project(p[0], p[1]);
      ctx.setLineDash([3, 3]); ctx.lineWidth = 2; ctx.strokeStyle = d.drivers.get(sel).colour;
      ctx.beginPath(); ctx.arc(px, py, 8.5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '600 11px Archivo, system-ui, sans-serif';
      halo(px + 13, py + 15, `${d.drivers.get(sel).code} after a stop`, '#e4e9f0');
    }
  }

  const hint = $('#map-hint');
  const txt = sel == null ? 'Click a car to follow it'
    : cmp == null ? `Click another car to compare it with ${d.drivers.get(sel).code}`
    : 'Click empty track to clear';
  if (hint.textContent !== txt) hint.textContent = txt;
}

// ---------- controls ----------
function setT(t, fromPlayback = false) {
  const d = state.data;
  const prev = state.t;
  state.t = Math.max(d.tStart, Math.min(d.tEnd, t));
  if (state.t < prev || (!fromPlayback && state.t - prev > 15000)) { state.seenRc = Infinity; state.seenPits = Infinity; state.callsSeen = Infinity; } // no flash on jumps
  $('#scrub').value = state.t;
  if (!fromPlayback) { state.lastPanelUpdate = 0; state.jumped = true; } // a jump redraws at once, rows don't slide
}
function setPlaying(p) {
  state.playing = p;
  $('#play').textContent = p ? '❚❚' : '▶';
  $('#mode').textContent = p ? 'Replaying' : 'Replay paused';
  $('#play').setAttribute('aria-label', p ? 'Pause' : 'Play');
}

// first click = focus driver; a second driver = compare with it;
// clicking the focus again clears both, clicking the compared one drops it
function selectDriver(n) {
  if (state.selected == null) state.selected = n;
  else if (n === state.selected) { state.selected = null; state.compare = null; }
  else if (n === state.compare) state.compare = null;
  else state.compare = n;
  if (n === state.selected || n === state.compare) state.pickedAt = { n, t: performance.now() };
  state.lastPanelUpdate = 0;
}
function clearSelection() { state.selected = null; state.compare = null; state.lastPanelUpdate = 0; }

function buildControls() {
  $('#speeds').innerHTML = SPEEDS.map((s) => `<button data-s="${s}" class="${s === state.speed ? 'on' : ''}">${s}×</button>`).join('');
  $('#speeds').onclick = (e) => {
    const s = Number(e.target.dataset.s); if (!s) return;
    state.speed = s;
    for (const b of $('#speeds').children) b.classList.toggle('on', Number(b.dataset.s) === s);
  };
  $('#play').onclick = () => setPlaying(!state.playing);
  $('#to-start').onclick = () => setT(state.data.lightsOut - 2000);
  $('#scrub').oninput = (e) => setT(Number(e.target.value));
  document.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('lobby-on')) return; // shortcuts are for the race view
    if (e.target.closest?.('select, input, textarea')) return; // typing, not driving the replay
    if (e.code === 'Space' && !e.target.closest?.('button')) { e.preventDefault(); setPlaying(!state.playing); }
    const step = e.shiftKey ? 60_000 : 10_000;
    if (e.code === 'ArrowRight') { e.preventDefault(); setT(state.t + step); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); setT(state.t - step); }
    if (e.code === 'Escape') clearSelection();
    const row = e.target.closest?.('#board tr');
    if (row && (e.code === 'Enter' || e.code === 'NumpadEnter')) selectDriver(Number(row.dataset.n));
  });
  $('#board').onclick = (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    selectDriver(Number(tr.dataset.n));
  };
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let hit = null, bestD = 18 * 18;
    for (const c of state.carScreen || []) {
      const dd = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (dd < bestD) { bestD = dd; hit = c.n; }
    }
    if (hit == null) clearSelection();
    else selectDriver(hit);
  };
  // the map panel changes size with the analysis panel, not just the window
  new ResizeObserver(() => fitView()).observe(canvas);
}

function buildTimeline() {
  const d = state.data, span = d.tEnd - d.tStart;
  const scrub = $('#scrub');
  scrub.min = d.tStart; scrub.max = d.tEnd;
  // status strip as a gradient: grey before lights out, then status colours
  const stops = [];
  const rows = d.status.rows;
  for (let i = 0; i < rows.length; i++) {
    const a = Math.max(d.tStart, rows[i].t), b = Math.min(d.tEnd, rows[i + 1]?.t ?? d.tEnd);
    if (b <= a) continue;
    const col = STATUS[rows[i].s][1];
    const pa = ((a - d.tStart) / span) * 100, pb = ((b - d.tStart) / span) * 100;
    stops.push(`${col} ${pa.toFixed(2)}%`, `${col} ${pb.toFixed(2)}%`);
  }
  $('#strip').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  const step = d.totalLaps > 40 ? 10 : 5;
  $('#ticks').innerHTML = d.leaderLaps.filter((l) => l.n === 1 || l.n % step === 0)
    .map((l) => `<span style="left:${(((l.t - d.tStart) / span) * 100).toFixed(2)}%">L${l.n}</span>`).join('');
}

// ---------- main loop ----------
let lastFrame = performance.now();
function frame(now) {
  // cap the step: a hidden tab pauses frames, and resuming must not jump the race
  const dt = Math.min(100, now - lastFrame); lastFrame = now;
  if (state.data) {
    if (typeof liveTick === 'function') liveTick(); // live: keeps the clock at the live edge
    if (state.playing) {
      setT(state.t + dt * state.speed, true);
      if (state.t >= state.data.tEnd) setPlaying(false);
    }
    // panels at ~5 Hz, the map every frame
    if (now - state.lastPanelUpdate > 200) {
      renderTop(state.t); renderBoard(state.t);
      if (typeof renderAnalysis === 'function') renderAnalysis(state.t); // also computes pit losses
      if (typeof maybeRenderStrategy === 'function') maybeRenderStrategy(state.t);
      if (typeof maybeRenderTelemetry === 'function') maybeRenderTelemetry();
      if (typeof maybeRenderRadio === 'function') maybeRenderRadio();
      renderFeeds(state.t);
      if (typeof renderCalls === 'function') renderCalls(state.t);
      if (typeof renderStandings === 'function') renderStandings();
      state.lastPanelUpdate = now;
    }
    drawMap(state.t, state.lastBoard);
  }
  requestAnimationFrame(frame);
}

// car positions come as per-driver delta columns (less than half the download)
async function fetchLocation(key) {
  const loc = await fetch(`data/${key}/location.json?fmt=d`).then((r) => r.json());
  if (loc.v !== 2) return loc;
  const out = {};
  for (const [n, [dt, dx, dy]] of Object.entries(loc.d)) {
    const pts = new Array(dt.length);
    let t = 0, x = 0, y = 0;
    for (let i = 0; i < dt.length; i++) { t += dt[i]; x += dx[i]; y += dy[i]; pts[i] = [t, x, y]; }
    out[n] = pts;
  }
  return out;
}

async function loadSession(key, { autoplay = true } = {}) {
  if (typeof exitLive === 'function') exitLive();
  const [raw, loc] = await Promise.all([
    fetch(`data/${key}/session.json`).then((r) => r.json()),
    fetchLocation(key),
  ]);
  state.data = prepare(raw, loc);
  // pit loss and tyre history from earlier races at this circuit (cold start)
  const priors = await fetch('data/priors.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  state.data.priors = priorsFor(priors, raw.session.circuit_key, raw.session.date_start);
  state.selected = null; state.compare = null; state.ghost = null; state.seenRc = Infinity; state.seenPits = Infinity;
  state.feedKey = null; state.callsKey = null; state.callsSeen = Infinity; rowEls.clear(); $('#board').innerHTML = '';
  buildTimeline();
  fitView();
  // open a few seconds before lights out and start playing: the first thing a visitor
  // sees is the cars moving, not a paused grid
  setT(state.data.lightsOut - 4000);
  const p = new URLSearchParams(location.search);
  if (p.has('lap')) {
    const l = state.data.leaderLaps.find((x) => x.n === Number(p.get('lap')));
    if (l) setT(l.t + 1000);
  }
  if (p.has('follow')) state.selected = Number(p.get('follow'));
  if (p.has('vs')) state.compare = Number(p.get('vs'));
  if (autoplay && p.get('play') !== '0') setPlaying(true);
}

// the leader's lap at the current time (for share links)
function lapNow() {
  const d = state.data;
  if (!d?.leaderLaps?.length) return null;
  let n = null;
  for (const l of d.leaderLaps) { if (l.t <= state.t) n = l.n; else break; }
  return n;
}

async function init() {
  buildControls();
  // the page needs car locations for the map; sessions cached without them are backtest-only
  const all = await fetch('data/index.json', { cache: 'no-store' }).then((r) => r.json());
  const idx = all.filter((s) => s.map !== false);
  const want = new URLSearchParams(location.search).get('session');
  const raceIdx = idx.filter((s) => / Race /.test(s.label)); // the live server also saves practice and qualifying
  const key = want && idx.some((s) => String(s.session_key) === want) ? want : String((raceIdx.length ? raceIdx : idx).at(-1).session_key);
  if (typeof initRaces === 'function') {
    await initRaces(all, key, (k) => {
      history.pushState(null, '', `?session=${k}`);
      loadSession(k);
    });
  }
  if (new URLSearchParams(location.search).has('clean')) document.body.classList.add('clean'); // screenshots: no countdowns
  requestAnimationFrame(frame);
  if (typeof liveStatus === 'function') await liveStatus(); // the lobby shows what's live
  // the lobby first; a link to a session (?session=, ?live=1) opens it directly
  if (typeof route === 'function') return route();
  if (typeof liveAutoStart === 'function' && await liveAutoStart()) return;
  await loadSession(key);
}
// wait for every script (live.js, races.js...) before starting
document.addEventListener('DOMContentLoaded', init);
