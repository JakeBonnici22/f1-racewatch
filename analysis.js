// Race questions, answered from data up to the clock only (so it works live):
//   - who is faster (median of recent green-flag laps)
//   - will the car behind catch the car ahead, and on which lap
//   - how much time a pit stop costs here (measured from this race's stops)
//   - if a driver pits now, where do they rejoin
'use strict';

const PACE_LAPS = 5;           // green laps used for pace
const MIN_PIT_SAMPLES = 2;     // measured pit loss needs at least this many stops
const SC_FALLBACK_RATIO = 0.6; // neutralised loss vs green, until one is measured

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const fmtS = (x, dp = 1) => (x == null ? '–' : `${x.toFixed(dp)}s`);

// ---------- precompute once per session ----------
function prepAnalysis(d) {
  d.lapNo = new Map();
  for (const [n, s] of d.laps) d.lapNo.set(n, new Map(s.rows.map((l) => [l.n, l])));
  const pitLap = new Set(d.pits.rows.map((p) => `${p.num}:${p.lap}`));
  const lap = (n, k) => d.lapNo.get(n)?.get(k);
  // green for the whole window = same status row at both ends, and it is GREEN
  d.isGreen = (t0, t1) => {
    const i = lastIdx(d.status.ts, t0), j = lastIdx(d.status.ts, t1);
    return i === j && d.status.rows[i]?.s === 'GREEN';
  };

  // clean laps: green throughout, not lap 1, not an in-lap or out-lap
  d.clean = new Map();
  for (const [n, s] of d.laps) {
    const rows = s.rows.filter((l) => l.dur && l.end && l.n > 1 && !l.pitOut
      && !pitLap.has(`${n}:${l.n}`) && d.isGreen(l.t, l.end)).sort((a, b) => a.end - b.end);
    d.clean.set(n, { rows, ends: rows.map((l) => l.end) });
  }

  // pit loss per stop = (in-lap + out-lap) minus the same two laps for cars that
  // stayed out. Works under green AND safety car, because the stayers were slow too.
  d.pitSamples = [];
  for (const p of d.pits.rows) {
    const a = lap(p.num, p.lap), b = lap(p.num, p.lap + 1);
    if (!a?.dur || !b?.dur || p.lap < 2) continue;
    // green: whole in-lap and out-lap under green. neutral: the car came in
    // while a SC/VSC was already out. Stops caught by a SC mid-lap are 'mixed'
    // and left out of both, since they cost more than either.
    const entry = at(d.status, p.t)?.s;
    const kind = d.isGreen(a.t, b.end) ? 'green' : ['SC', 'VSC', 'SC_IN', 'VSC_END'].includes(entry) ? 'neutral' : 'mixed';
    // Under green any car on the same laps is a fair comparison. Under a
    // neutralisation, only cars that started the lap within 20 s of the pitting
    // car saw the same flags (a short VSC covers some cars' laps and not others).
    const pairs = []; let avail = b.end;
    for (const k of d.drivers.keys()) {
      if (k === p.num) continue;
      const x = lap(k, p.lap), y = lap(k, p.lap + 1);
      if (!x?.dur || !y?.dur) continue;
      if ([p.lap - 1, p.lap, p.lap + 1].some((q) => pitLap.has(`${k}:${q}`))) continue;
      if (kind !== 'green' && Math.abs(x.t - a.t) > 20_000) continue;
      pairs.push(x.dur + y.dur); avail = Math.max(avail, y.end);
    }
    if (pairs.length < (kind === 'green' ? 5 : 2)) continue;
    const loss = a.dur + b.dur - median(pairs);
    if (loss < 5 || loss > 60) continue; // incidents, damage, retirements
    p.loss = loss;
    d.pitSamples.push({ num: p.num, lap: p.lap, loss, avail, kind });
  }
}

// ---------- track history ----------
// priors.json holds, per circuit, the pit losses and fresh-tyre gains measured in
// every cached race there. A session only sees races held before it, so replays
// and backtests never peek at the future.
// Most recent race first, and older races only while they agree with it
// (within 2 s): when the pit lane changes (Singapore went from ~30 s to ~23 s
// in 2025 with a higher pit-lane speed limit) the old years are left out.
const PRIOR_AGREE = 2.0;
function priorsFor(all, circuitKey, date) {
  const races = (all?.[circuitKey] || []).filter((r) => r.date < date && !/qualifying|sprint/i.test(r.label || ''))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!races.length) return null;
  const solid = races.filter((r) => r.green.length >= 5);
  let used = races, changed = null;
  if (solid.length) {
    const base = median(solid[0].green);
    used = [solid[0]];
    for (const r of solid.slice(1)) {
      const m = median(r.green);
      if (Math.abs(m - base) <= PRIOR_AGREE) { used.push(r); continue; }
      changed = { year: solid[0].date.slice(0, 4), before: m, after: base };
      break;
    }
  }
  const years = [...new Set(used.map((r) => r.date.slice(0, 4)))].sort();
  return {
    races: used.length, years: years.length > 1 ? `${years[0]}–${years.at(-1)}` : years[0], changed,
    green: used.flatMap((r) => r.green), neutral: used.flatMap((r) => r.neutral), fresh: races.flatMap((r) => r.fresh),
  };
}

// ---------- queries at time t ----------
// Pit loss: this race's stops pooled with the stops at this track in earlier
// races. Track history carries the cold start; once this race has 5+ stops of
// a kind, only this race counts (pit lane rules or layout may have changed).
const POOL_UNTIL = 5;
const PRIOR_WEIGHT = 3;
function pitLossAt(d, t, kind) {
  const xs = d.pitSamples.filter((s) => s.avail <= t && s.kind === kind).map((s) => s.loss);
  const prior = d.priors?.[kind] || [];
  if (xs.length >= POOL_UNTIL || (xs.length >= MIN_PIT_SAMPLES && prior.length < 3)) {
    return { loss: median(xs), n: xs.length, measured: true };
  }
  if (prior.length >= 3) {
    // track history counts as PRIOR_WEIGHT stops; this race's stops pull the
    // estimate over quickly (pooling all history used to drown them out)
    const pm = median(prior), loss = xs.length ? (PRIOR_WEIGHT * pm + xs.length * median(xs)) / (PRIOR_WEIGHT + xs.length) : pm;
    const pool = [...prior, ...xs].sort((a, b) => a - b);
    const q = (f) => pool[Math.min(pool.length - 1, Math.floor(f * pool.length))];
    return { loss, n: xs.length, nPrior: prior.length, measured: true, prior: true, lo: q(0.25), hi: q(0.75) };
  }
  if (kind === 'green') {
    // before two green stops exist: time in the pit lane minus ~2 s of track
    // the car skips (calibrated on Kuala Lumpur: lane 28 s, measured loss 26 s)
    const lane = median(d.pits.rows.filter((p) => p.t <= t && p.lane && p.lane < 60).map((p) => p.lane));
    return lane ? { loss: lane - 2, n: 0, measured: false } : null;
  }
  const g = pitLossAt(d, t, 'green');
  return g ? { loss: g.loss * SC_FALLBACK_RATIO, n: 0, measured: false } : null;
}

function paceAt(d, n, t) {
  const c = d.clean.get(n);
  if (!c) return null;
  const k = lastIdx(c.ends, t);
  const laps = c.rows.slice(Math.max(0, k - PACE_LAPS + 1), k + 1);
  return laps.length >= 2 ? { pace: median(laps.map((l) => l.dur)), laps } : null;
}

const gapAt = (d, n, t) => {
  const g = at(d.intervals.get(n), t)?.gap;
  return typeof g === 'number' ? g : at(d.intervals.get(n), t) && at(d.position.get(n), t)?.pos === 1 ? 0 : null;
};

// Running order by time gap; the leader has gap 0. Ordered by the gap itself,
// not the position feed - around pit stops the two disagree for a few seconds.
function fieldAt(d, t, board) {
  const f = board.filter((r) => !r.out).map((r, i) => ({
    n: r.n, drv: r.drv, gap: i === 0 ? 0 : typeof r.gap === 'number' ? r.gap : null, r, i,
  }));
  return f.sort((a, b) => (a.gap == null) - (b.gap == null) || (a.gap ?? 0) - (b.gap ?? 0) || a.i - b.i);
}

function battleAt(d, t, n1, n2) {
  let A = n1, B = n2;
  let gA = gapAt(d, A, t), gB = gapAt(d, B, t);
  if (gA == null || gB == null) return { A, B, nodata: true };
  if (gA > gB) { [A, B] = [B, A]; [gA, gB] = [gB, gA]; } // A = ahead, B = behind
  const gap = gB - gA;
  const pA = paceAt(d, A, t), pB = paceAt(d, B, t);
  const delta = pA && pB ? pA.pace - pB.pace : null; // > 0: car behind is faster
  const lapsS = d.laps.get(B);
  const curLap = lapsS ? at(lapsS, t)?.n ?? 0 : 0;
  const lapsLeft = Math.max(0, d.totalLaps - curLap);
  let catchLap = null, need = lapsLeft > 0 ? gap / lapsLeft : null;
  if (delta && delta > 0.02) {
    const laps = gap / delta;
    if (laps <= lapsLeft) catchLap = curLap + Math.ceil(laps);
  }
  // gap history: sampled each time the car behind completes a lap
  const hist = [];
  for (const l of lapsS?.ends || []) {
    if (l.end > t) break;
    const a = gapAt(d, A, l.end), b = gapAt(d, B, l.end);
    if (a != null && b != null) hist.push({ lap: l.n, gap: b - a, green: d.isGreen(l.t, l.end) });
  }
  return { A, B, gap, pA, pB, delta, curLap, lapsLeft, catchLap, need, hist };
}

function rejoinAt(d, t, n, field, loss) {
  const me = field.find((f) => f.n === n);
  if (!me || me.gap == null || loss == null) return null;
  const proj = me.gap + loss;
  const others = field.filter((f) => f.n !== n && f.gap != null);
  let ahead = null, behind = null;
  for (const f of others) {
    if (f.gap < proj) ahead = f;
    else if (!behind) behind = f;
  }
  const pos = others.filter((f) => f.gap < proj).length + 1;
  const idx = field.indexOf(me);
  const nextNow = field.slice(idx + 1).find((f) => f.gap != null);
  return {
    proj, pos, ahead, behind,
    marginAhead: ahead ? proj - ahead.gap : null,
    marginBehind: behind ? behind.gap - proj : null,
    nowPos: idx + 1,
    freeStopGap: nextNow ? nextNow.gap - me.gap : null, freeStopTo: nextNow,
  };
}

// The closest fights on track: consecutive cars, smallest interval first.
function fightsAt(d, t, field) {
  const out = [];
  for (let i = 1; i < field.length; i++) {
    const a = field[i - 1], b = field[i];
    if (a.gap == null || b.gap == null) continue;
    const pa = paceAt(d, a.n, t), pb = paceAt(d, b.n, t);
    out.push({ a, b, gap: b.gap - a.gap, delta: pa && pb ? pa.pace - pb.pace : null });
  }
  return out.sort((x, y) => x.gap - y.gap).slice(0, 4);
}

// ---------- rendering ----------
const ribbon = document.querySelector('#ribbon');
const rctx = ribbon.getContext('2d');

function sizeRibbon() {
  const dpr = window.devicePixelRatio || 1;
  ribbon.width = ribbon.clientWidth * dpr; ribbon.height = ribbon.clientHeight * dpr;
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeRibbon);

// Field spread out by gap to leader. Dots in rows so labels don't collide;
// green links = within DRS (1 s); hollow dot = where the focused car would rejoin.
function drawRibbon(d, t, field, ghost) {
  const w = ribbon.clientWidth, h = ribbon.clientHeight;
  if (!w) return;
  if (ribbon.width !== Math.round(w * (window.devicePixelRatio || 1))) sizeRibbon();
  rctx.clearRect(0, 0, w, h);
  const pts = field.filter((f) => f.gap != null);
  if (!pts.length) {
    rctx.fillStyle = '#8b94a3'; rctx.font = '12px system-ui';
    rctx.fillText('Gaps appear once the timing feed has intervals (after lap 1).', 12, h / 2);
    return;
  }
  const maxGap = Math.max(10, ...pts.map((p) => p.gap), ghost ? ghost.proj : 0);
  const L = 30, R = 30, axisY = h - 18;
  const x = (g) => L + (g / maxGap) * (w - L - R);
  const step = maxGap > 120 ? 30 : maxGap > 60 ? 10 : maxGap > 25 ? 5 : 2;

  rctx.font = '10px system-ui'; rctx.textAlign = 'center';
  for (let g = 0; g <= maxGap; g += step) {
    rctx.fillStyle = '#212833'; rctx.fillRect(Math.round(x(g)), 6, 1, axisY - 6);
    rctx.fillStyle = '#6f7b8d'; rctx.font = '11px Archivo, system-ui'; rctx.fillText(g === 0 ? 'Leader' : `+${g}s`, x(g), h - 3);
  }
  rctx.fillStyle = '#26303f'; rctx.fillRect(L, axisY, w - L - R, 1);

  // DRS links between consecutive cars
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].gap - pts[i - 1].gap < 1) {
      rctx.fillStyle = '#34c27a';
      rctx.fillRect(x(pts[i - 1].gap), axisY - 2, Math.max(2, x(pts[i].gap) - x(pts[i - 1].gap)), 3);
    }
  }

  // greedy rows for labels; the top lane (y < 22) is kept for the pit ghost
  const rows = [-Infinity, -Infinity, -Infinity];
  const rowH = (axisY - 30) / rows.length;
  const placed = [];
  for (const p of pts) {
    const px = x(p.gap);
    let r = rows.findIndex((end) => end < px - 2);
    if (r < 0) r = rows.indexOf(Math.min(...rows));
    rows[r] = px + 30;
    placed.push({ p, px, py: axisY - 10 - r * rowH });
  }
  const sel = state.selected, cmp = state.compare;
  state.ribbonHits = placed.map(({ p, px, py }) => ({ n: p.n, x: px, y: py }));
  for (const { p, px, py } of placed) {
    const on = p.n === sel || p.n === cmp;
    rctx.globalAlpha = sel != null && !on ? 0.45 : 1;
    rctx.strokeStyle = '#26303f'; rctx.lineWidth = 1;
    rctx.beginPath(); rctx.moveTo(px, py); rctx.lineTo(px, axisY); rctx.stroke();
    rctx.beginPath(); rctx.arc(px, py, on ? 6.5 : 5, 0, Math.PI * 2);
    rctx.fillStyle = p.drv.colour; rctx.fill();
    rctx.lineWidth = 2; rctx.strokeStyle = '#1a2230'; rctx.stroke();
    if (on) {
      if (p.n === cmp) rctx.setLineDash([2, 2]);
      rctx.beginPath(); rctx.arc(px, py, 9.5, 0, Math.PI * 2);
      rctx.lineWidth = 1.5; rctx.strokeStyle = '#e4e9f0'; rctx.stroke(); rctx.setLineDash([]);
    }
    rctx.fillStyle = on ? '#fff' : '#c3cbd6'; rctx.font = `${on ? 700 : 600} 11px Archivo, system-ui`;
    rctx.textAlign = 'left'; rctx.fillText(p.drv.code, px + (on ? 12 : 8), py + 4);
    rctx.globalAlpha = 1;
  }
  if (ghost) {
    // own lane at the top: an arrow from the car's x to its post-stop x,
    // and a dashed drop to the axis so you can read who it lands between
    const me = placed.find((q) => q.p.n === sel);
    const gx = x(ghost.proj), gy = 14, fromX = me ? me.px : x(ghost.proj - ghost.loss);
    rctx.strokeStyle = d.drivers.get(sel).colour; rctx.lineWidth = 1.5;
    rctx.setLineDash([4, 3]);
    rctx.beginPath(); rctx.moveTo(fromX, gy); rctx.lineTo(gx - 7, gy); rctx.stroke();
    rctx.beginPath(); rctx.moveTo(gx, gy + 7); rctx.lineTo(gx, axisY); rctx.stroke();
    rctx.setLineDash([]);
    rctx.beginPath(); rctx.moveTo(fromX, gy - 4); rctx.lineTo(fromX, gy + 4); rctx.stroke();
    rctx.beginPath(); rctx.arc(gx, gy, 6, 0, Math.PI * 2); rctx.stroke();
    const code = d.drivers.get(sel).code;
    rctx.fillStyle = '#e4e9f0'; rctx.font = '600 11px Archivo, system-ui';
    const label = `${code} after a stop, +${ghost.loss.toFixed(1)}s`;
    const lw = rctx.measureText(label).width;
    const lx = gx + 10 + lw < w ? gx + 10 : gx - 10 - lw; // keep it on canvas
    rctx.textAlign = 'left'; rctx.fillText(label, lx, gy + 3.5);
  }
}

// Gap chart: one line, gap between the pair per lap, dashed projection to the catch.
function gapChart(b, d) {
  const W = 340, H = 96, L = 30, R = 8, T = 8, B = 18;
  const hist = b.hist;
  if (hist.length < 2) return '<div class="muted small">Gap history builds up lap by lap.</div>';
  const lastLap = Math.max(hist.at(-1).lap, b.catchLap || 0);
  const firstLap = hist[0].lap;
  const ys = hist.map((h) => h.gap);
  const yMax = Math.max(1, ...ys), yMin = Math.min(0, ...ys);
  const x = (l) => L + ((l - firstLap) / Math.max(1, lastLap - firstLap)) * (W - L - R);
  const y = (g) => T + ((yMax - g) / (yMax - yMin)) * (H - T - B);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Gap between ${d.drivers.get(b.B).code} and ${d.drivers.get(b.A).code} by lap">`;
  // neutralised laps shaded
  for (const hp of hist) if (!hp.green) svg += `<rect x="${x(hp.lap - 1)}" y="${T}" width="${Math.max(1, x(hp.lap) - x(hp.lap - 1))}" height="${H - T - B}" fill="#f2c230" opacity=".13"/>`;
  // grid: 0 line + top
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#26303f"/>`;
  svg += `<text x="${L - 4}" y="${y(0) + 3}" text-anchor="end" class="ax">0</text>`;
  svg += `<text x="${L - 4}" y="${y(yMax) + 8}" text-anchor="end" class="ax">${yMax.toFixed(0)}s</text>`;
  svg += `<text x="${L}" y="${H - 4}" class="ax">L${firstLap}</text><text x="${W - R}" y="${H - 4}" text-anchor="end" class="ax">L${lastLap}</text>`;
  const path = hist.map((h, i) => `${i ? 'L' : 'M'}${x(h.lap).toFixed(1)},${y(h.gap).toFixed(1)}`).join('');
  svg += `<path d="${path}" fill="none" stroke="${d.drivers.get(b.B).colour}" stroke-width="2" stroke-linejoin="round"/>`;
  const last = hist.at(-1);
  if (b.catchLap) {
    svg += `<line x1="${x(last.lap)}" y1="${y(last.gap)}" x2="${x(b.catchLap)}" y2="${y(0)}" stroke="#e4e9f0" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    svg += `<circle cx="${x(b.catchLap)}" cy="${y(0)}" r="4" fill="none" stroke="#e4e9f0" stroke-width="1.5"/>`;
  }
  svg += `<circle cx="${x(last.lap)}" cy="${y(last.gap)}" r="4" fill="${d.drivers.get(b.B).colour}" stroke="#121821" stroke-width="2"/>`;
  // hover targets
  for (const h of hist) svg += `<rect x="${x(h.lap) - 4}" y="${T}" width="8" height="${H - T - B}" fill="transparent"><title>Lap ${h.lap}: ${d.drivers.get(b.B).code} ${h.gap >= 0 ? h.gap.toFixed(2) + 's behind' : (-h.gap).toFixed(2) + 's ahead of'} ${d.drivers.get(b.A).code}${h.green ? '' : ' (SC/VSC)'}</title></rect>`;
  return svg + '</svg>';
}

function tyreBadge(r) {
  if (!r?.tyre) return '';
  const ty = TYRES[r.tyre.c] || ['?', '#888'];
  return `<span class="tyre"><i class="${r.tyre.sure ? '' : 'unsure'}" style="--c:${ty[1]}" data-l="${r.tyre.sure ? ty[0] : '?'}"></i>${r.tyre.age}</span>`;
}

function renderBattle(d, t, board, field) {
  const el = document.querySelector('#battle');
  const sel = state.selected;
  if (sel == null) {
    const fights = fightsAt(d, t, field);
    el.innerHTML = `<h3>Closest fights <span class="muted">Click one to follow it</span></h3>` + (fights.length
      ? `<ol class="fights">${fights.map((f) => {
          const closing = f.delta == null ? '' : f.delta > 0.02
            ? `<span class="good">closing ${f.delta.toFixed(2)}s a lap</span>`
            : f.delta < -0.02 ? `<span class="bad">dropping ${(-f.delta).toFixed(2)}s a lap</span>` : '<span class="muted">same pace</span>';
          return `<li data-a="${f.a.n}" data-b="${f.b.n}">
            <b style="color:${f.b.drv.colour}">${f.b.drv.code}</b> <span class="vs">on</span> <b style="color:${f.a.drv.colour}">${f.a.drv.code}</b>
            ${f.gap < 1 ? '<span class="chip drs">DRS</span>' : ''}<span class="num">${f.gap.toFixed(2)}s</span><span class="trend">${closing}</span></li>`;
        }).join('')}</ol>`
      : '<div class="muted small">Waiting for timing data.</div>');
    return;
  }
  // focus car vs explicit pick, or vs the car ahead (car behind for the leader)
  let other = state.compare, auto = false;
  if (other == null) {
    const i = field.findIndex((f) => f.n === sel);
    other = (field[i - 1] || field[i + 1])?.n; auto = true;
  }
  if (other == null) { el.innerHTML = '<div class="muted small">No car to compare with.</div>'; return; }
  const b = battleAt(d, t, sel, other);
  const cA = d.drivers.get(b.A), cB = d.drivers.get(b.B);
  const rA = board.find((r) => r.n === b.A), rB = board.find((r) => r.n === b.B);
  if (b.nodata) { el.innerHTML = `<h3>${cB.code} vs ${cA.code}</h3><div class="muted small">No gap data for one of them yet.</div>`; return; }

  let paceTxt, catchTxt;
  if (b.delta == null) {
    paceTxt = '<span class="muted">Needs 2+ green laps each</span>';
    catchTxt = '–';
  } else {
    const faster = b.delta > 0 ? cB : cA;
    paceTxt = Math.abs(b.delta) < 0.02 ? 'Same pace'
      : `<b style="color:${faster.colour}">${faster.code}</b> is ${Math.abs(b.delta).toFixed(2)}s a lap faster`;
    if (b.catchLap) catchTxt = `<b>Lap ${b.catchLap}</b> <span class="muted">of ${d.totalLaps}</span>`;
    else if (b.lapsLeft === 0) catchTxt = 'Race over';
    else catchTxt = `<span class="bad">Not at this pace</span><div class="muted small">Needs ${b.need.toFixed(2)}s a lap over the last ${b.lapsLeft} laps</div>`;
  }
  const lapsRow = b.pA && b.pB ? (() => {
    const mA = new Map(b.pA.laps.map((l) => [l.n, l.dur])), mB = new Map(b.pB.laps.map((l) => [l.n, l.dur]));
    const nums = [...new Set([...mA.keys(), ...mB.keys()])].sort((a, c) => a - c).slice(-PACE_LAPS);
    return `<table class="laps"><tr><th></th>${nums.map((k) => `<th>L${k}</th>`).join('')}<th>Median</th></tr>
      ${[[cB, mB, b.pB], [cA, mA, b.pA]].map(([c, m, p], row) => `<tr><td><b>${c.code}</b></td>${nums.map((k) => {
        const mine = m.get(k), theirs = (row ? mB : mA).get(k);
        const cls = mine && theirs ? (mine < theirs ? 'good' : 'bad') : '';
        return `<td class="${cls}">${mine ? fmtLap(mine) : '–'}</td>`;
      }).join('')}<td><b>${fmtLap(p.pace)}</b></td></tr>`).join('')}</table>`;
  })() : '';

  el.innerHTML = `
    <h3>Can <b style="color:${cB.colour}">${cB.code}</b> ${tyreBadge(rB)} catch <b style="color:${cA.colour}">${cA.code}</b> ${tyreBadge(rA)}?</h3>
    <div class="bt-main">
      <div class="stats vert">
        <div><span class="label">Gap</span><b class="big">${b.gap.toFixed(2)}s</b>${b.gap < 1 ? '<span class="chip drs">DRS</span>' : ''}</div>
        <div><span class="label">Pace over the last ${PACE_LAPS} green laps</span><div>${paceTxt}</div></div>
        <div><span class="label">Catches on</span><div>${catchTxt}</div></div>
      </div>
      <div><span class="label">Gap by lap. Shaded laps were under a safety car; the dashed line is the projection.</span>${gapChart(b, d)}</div>
    </div>
    ${lapsRow}`;
}

function renderPitCard(d, t, field) {
  const el = document.querySelector('#pitcard');
  const status = statusAt(t);
  const neutral = status === 'SC' || status === 'VSC' || status === 'SC_IN' || status === 'VSC_END';
  const g = pitLossAt(d, t, 'green'), s = pitLossAt(d, t, 'neutral');
  const src = (x) => {
    if (!x) return '';
    if (x.prior) {
      const here = `${x.nPrior} stops here in ${d.priors.races} earlier race${d.priors.races > 1 ? 's' : ''} (${d.priors.years})`;
      const range = x.lo != null ? ` Usually ${x.lo.toFixed(0)}–${x.hi.toFixed(0)} s.` : '';
      const ch = d.priors.changed ? ` Races before ${d.priors.changed.year} left out: the pit lane got ${Math.abs(d.priors.changed.before - d.priors.changed.after).toFixed(0)} s ${d.priors.changed.after < d.priors.changed.before ? 'quicker' : 'slower'} then.` : '';
      return (x.n ? `${x.n} stops this race weighed with ${here}.` : `From ${here}.`) + range + ch;
    }
    return x.measured ? `Median of ${x.n} stops this race` : 'Estimate until two stops are measured';
  };
  const sel = state.selected;
  if (sel == null) {
    el.innerHTML = `<h3>Pit stop cost</h3>
      <div class="stats two">
        <div><span class="label">Green flag</span><b class="big">${fmtS(g?.loss)}</b><div class="muted small">${src(g)}</div></div>
        <div><span class="label">Under SC / VSC</span><b class="big">${fmtS(s?.loss)}</b><div class="muted small">${src(s)}</div></div>
      </div>
      <p class="muted small">Measured as the in-lap plus out-lap, minus the same two laps for cars that stayed out. Follow a driver to see where they'd rejoin.</p>`;
    return null;
  }
  const now = neutral ? s : g, alt = neutral ? g : s;
  const code = d.drivers.get(sel).code;
  const r = rejoinAt(d, t, sel, field, now?.loss);
  const rAlt = rejoinAt(d, t, sel, field, alt?.loss);
  if (!r) { el.innerHTML = `<h3>If ${code} pits now</h3><div class="muted small">Needs a gap to the leader first.</div>`; return null; }
  const who = (f) => f ? `<b style="color:${f.drv.colour}">${f.drv.code}</b>` : '';
  const tight = (m) => m != null && m < 1.5 ? ' <span class="chip warn">traffic</span>' : '';
  const free = r.freeStopGap == null ? '' : r.freeStopGap > now.loss
    ? `<div class="good">Free stop: ${r.freeStopGap.toFixed(1)}s clear of ${who(r.freeStopTo)} - keeps P${r.nowPos}</div>`
    : `<div class="muted">${(now.loss - r.freeStopGap).toFixed(1)}s short of a free stop over ${who(r.freeStopTo)}</div>`;
  el.innerHTML = `<h3>If <b style="color:${d.drivers.get(sel).colour}">${code}</b> pits now
      <span class="chip ${neutral ? 'warn' : 'ok'}">${neutral ? 'SC/VSC' : 'Green'}</span></h3>
    <div class="stats">
      <div><span class="label">Time lost</span><b class="big">${fmtS(now?.loss)}</b><div class="muted small">${src(now)}</div></div>
      <div><span class="label">Rejoins</span><b class="big">P${r.pos}</b><div class="muted small">now P${r.nowPos}</div></div>
    </div>
    <div class="rejoin">
      ${r.ahead ? `<div>${fmtS(r.marginAhead)} behind ${who(r.ahead)}${tight(r.marginAhead)}</div>` : '<div>Leads the race</div>'}
      ${r.behind ? `<div>${fmtS(r.marginBehind)} ahead of ${who(r.behind)}${tight(r.marginBehind)}</div>` : ''}
    </div>
    ${free}
    ${rAlt && alt ? `<div class="alt muted">${neutral ? 'Under green' : 'If a SC/VSC comes out'}: lose ${fmtS(alt.loss)} → <b>P${rAlt.pos}</b></div>` : ''}`;
  return { proj: r.proj, loss: now.loss };
}

// Who is being followed / compared, with one-click removal. The panel's top
// edge takes the two drivers' team colours so the pairing reads at a glance.
function renderFocusBar(d, field) {
  const bar = document.querySelector('#focusbar'), panel = document.querySelector('#analysis');
  const sel = state.selected, cmp = state.compare;
  let other = cmp, auto = false;
  if (sel != null && other == null) {
    const i = field.findIndex((f) => f.n === sel);
    other = (field[i - 1] || field[i + 1])?.n ?? null; auto = true;
  }
  const key = `${sel}|${other}|${auto}`;
  panel.classList.toggle('focused', sel != null);
  if (sel != null) {
    panel.style.setProperty('--fc', d.drivers.get(sel).colour);
    panel.style.setProperty('--cc', other != null ? d.drivers.get(other).colour : d.drivers.get(sel).colour);
  }
  if (key === state.focusKey) return false;
  const changedPick = state.focusKey == null || state.focusKey.split('|')[0] !== String(sel) || (!auto && state.focusKey.split('|')[1] !== String(other));
  state.focusKey = key;
  // nobody followed: no bar at all, just a short hint beside the gap strip title
  bar.hidden = sel == null;
  document.querySelector('#follow-hint').hidden = sel != null;
  if (sel == null) { bar.innerHTML = ''; return true; }
  const a = d.drivers.get(sel), b = other != null ? d.drivers.get(other) : null;
  bar.innerHTML = `
    <span class="pick ${changedPick ? 'new' : ''}" style="--pc:${a.colour}"><span class="role">Following</span><b style="color:${a.colour}">${a.code}</b><span>${a.name.split(' ')[0]}</span>
      <button data-act="unfollow" aria-label="Stop following ${a.code}" title="Stop following">×</button></span>
    ${b ? `<span class="versus">vs</span>
    <span class="pick ${auto ? 'auto' : ''} ${changedPick ? 'new' : ''}" style="--pc:${b.colour}"><b style="color:${b.colour}">${b.code}</b>
      <span class="role">${auto ? 'car next to them' : 'compared'}</span>
      ${auto ? '' : `<button data-act="uncompare" aria-label="Stop comparing ${b.code}" title="Stop comparing">×</button>`}</span>` : ''}
    <span class="tip">${auto ? 'Click another driver to compare' : 'Esc clears both'}</span>`;
  return true;
}

function renderAnalysis(t) {
  const d = state.data, board = state.lastBoard;
  if (!d || !board) return;
  if (!d.pitSamples) prepAnalysis(d);
  const field = fieldAt(d, t, board);
  const swapped = renderFocusBar(d, field);
  renderBattle(d, t, board, field);
  state.ghost = renderPitCard(d, t, field);
  if (swapped) {
    for (const el of document.querySelectorAll('.card')) {
      el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
    }
  }
  state.field = field;
  drawRibbon(d, t, field, state.ghost);
}

document.querySelector('#focusbar').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'unfollow') clearSelection();
  if (act === 'uncompare') { state.compare = null; state.lastPanelUpdate = 0; }
});
ribbon.addEventListener('click', (e) => {
  const rect = ribbon.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  let hit = null, best = 16 * 16;
  for (const h of state.ribbonHits || []) {
    const dd = (h.x - x) ** 2 + (h.y - y) ** 2;
    if (dd < best) { best = dd; hit = h.n; }
  }
  if (hit != null) selectDriver(hit);
});

document.querySelector('#battle').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-a]');
  if (!li) return;
  state.selected = Number(li.dataset.b); state.compare = Number(li.dataset.a);
  state.pickedAt = { n: state.selected, t: performance.now() };
  state.lastPanelUpdate = 0;
});
