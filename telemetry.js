// Speed trace: the followed driver's last completed lap against the compared
// driver (or the car next to him) - speed over the lap, where the time is won
// or lost, and throttle/brake. Car data (about 4 samples a second) comes per
// lap from the server's /telemetry endpoint, which caches it.
'use strict';

const tele = { cache: new Map(), key: '', lapBack: 0, at: 0 };

function teleFetch(sk, n, lap) {
  const k = `${sk}_${n}_${lap}`;
  if (!tele.cache.has(k)) {
    tele.cache.set(k, fetch(`/telemetry?session=${sk}&driver=${n}&lap=${lap}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((x) => { if (!x?.samples?.length) setTimeout(() => tele.cache.delete(k), 5000); return x; }));
  }
  return tele.cache.get(k);
}

// last lap a car completed by time t (minus `back` laps)
function lastLapDone(d, n, t, back = 0) {
  const s = d.laps.get(n);
  if (!s) return null;
  const k = lastIdx(s.endTs, t);
  const l = s.ends[k - back];
  return l && l.dur ? l : null;
}

// distance along the lap from speed (km/h -> m/s, trapezoid), as a fraction of the lap
function withDistance(x) {
  const S = x.samples.filter((p) => p[1] != null);
  let dist = 0;
  const pts = S.map((p, i) => {
    if (i) dist += ((S[i - 1][1] + p[1]) / 2 / 3.6) * ((p[0] - S[i - 1][0]) / 1000);
    return { t: p[0] / 1000, v: p[1], thr: p[2], brk: p[3], gear: p[4], d: dist };
  }).filter((p) => p.t >= 0 && (x.dur == null || p.t <= x.dur));
  const total = pts.at(-1)?.d || 1;
  for (const p of pts) p.f = p.d / total;
  return { pts, total };
}

// value of a series at lap fraction f (linear between samples)
function atF(pts, f, key) {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].f <= f) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  if (!a || !b) return null;
  const w = b.f === a.f ? 0 : (f - a.f) / (b.f - a.f);
  return a[key] + (b[key] - a[key]) * Math.max(0, Math.min(1, w));
}

function teleOther(d, sel, t) {
  if (state.compare != null) return state.compare;
  const field = (state.lastBoard || []).filter((r) => !r.out);
  const i = field.findIndex((r) => r.n === sel);
  return (field[i - 1] || field[i + 1])?.n ?? null;
}

async function renderTelemetry(force) {
  const box = document.querySelector('#telemetry');
  const d = state.data;
  if (!box || !d) return;
  const sel = state.selected;
  if (sel == null) {
    tele.key = '';
    box.innerHTML = '<p class="muted pad">Follow a driver (click one on the board or the map) to see their speed through the last lap, against the car next to them or a second driver you pick.</p>';
    return;
  }
  const sk = d.raw.session.session_key;
  const other = teleOther(d, sel, state.t);
  const la = lastLapDone(d, sel, state.t, tele.lapBack);
  if (!la) { box.innerHTML = '<p class="muted pad">No completed lap yet.</p>'; return; }
  const lb = other != null ? (d.lapNo?.get(other)?.get(la.n)?.dur && d.lapNo.get(other).get(la.n).end <= state.t ? d.lapNo.get(other).get(la.n) : lastLapDone(d, other, state.t)) : null;
  const key = `${sk}|${sel}|${la.n}|${other}|${lb?.n}`;
  if (key === tele.key && !force) return;
  tele.key = key;
  const A = d.drivers.get(sel), B = other != null ? d.drivers.get(other) : null;
  box.innerHTML = `<p class="muted pad">Loading ${A.code} lap ${la.n}${B && lb ? ` and ${B.code} lap ${lb.n}` : ''}…</p>`;
  const [ta, tb] = await Promise.all([teleFetch(sk, sel, la.n), B && lb ? teleFetch(sk, other, lb.n) : null]);
  if (tele.key !== key) return; // moved on while loading
  if (!ta) { box.innerHTML = '<p class="muted pad">Car data isn\'t available for this lap.</p>'; return; }
  const a = withDistance(ta), b = tb ? withDistance(tb) : null;
  drawTrace(box, { A, B, la, lb, a, b });
}

function drawTrace(box, { A, B, la, lb, a, b }) {
  const W = 1000, H = 150, HD = 46, HT = 30, padL = 34, padR = 8;
  const vmax = Math.ceil(Math.max(...a.pts.map((p) => p.v), ...(b ? b.pts.map((p) => p.v) : [0])) / 50) * 50;
  const X = (f) => padL + f * (W - padL - padR);
  const Y = (v) => 8 + (1 - v / vmax) * (H - 16);
  const line = (pts, key, y) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.f).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const same = B && A.colour === B.colour;
  // corners: local speed minima of the followed car, at least 4% of the lap apart
  const mins = [];
  a.pts.forEach((p, i) => {
    const win = a.pts.slice(Math.max(0, i - 6), i + 7);
    if (p.v < vmax * 0.75 && win.every((q) => q.v >= p.v) && !mins.some((m) => Math.abs(m.f - p.f) < 0.04)) mins.push(p);
  });
  // where time goes: B's time minus A's time at the same point of the lap (> 0: A ahead)
  let delta = null, dmax = 0.2;
  if (b) {
    delta = [];
    for (let f = 0; f <= 1.0001; f += 0.005) {
      const ta = atF(a.pts, f, 't'), tb = atF(b.pts, f, 't');
      if (ta != null && tb != null) { delta.push({ f, v: tb - ta }); dmax = Math.max(dmax, Math.abs(tb - ta)); }
    }
  }
  const YD = (v) => HD / 2 - (v / dmax) * (HD / 2 - 3);
  const thr = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.f).toFixed(1)},${(HT - 2 - (p.thr / 100) * (HT - 6)).toFixed(1)}`).join('');
  const brakes = a.pts.filter((p) => p.brk > 0).map((p) => `<rect x="${X(p.f) - 1}" y="${HT - 4}" width="3" height="3" class="brk"/>`).join('');
  const grid = [100, 200, 300].filter((v) => v < vmax).map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${padL - 4}" y="${Y(v) + 3}" class="ax">${v}</text>`).join('');
  const fmt = (s) => fmtLap(s);
  const end = delta?.at(-1)?.v;
  box.innerHTML = `
    <div class="tl-head">
      <button type="button" class="tl-nav" data-lapnav="1" title="Previous lap">‹</button>
      <span class="chip" style="--c:${A.colour}">${A.code}</span> lap ${la.n} · <b>${fmt(la.dur)}</b>
      ${B && lb ? `<span class="tl-vs">vs</span><span class="chip ${same ? 'dash' : ''}" style="--c:${B.colour}">${B.code}</span> lap ${lb.n} · <b>${fmt(lb.dur)}</b>
        <span class="tl-diff">${end != null ? `${A.code} ${end >= 0 ? 'quicker' : 'slower'} by ${Math.abs(end).toFixed(3)} s` : ''}</span>` : ''}
      <button type="button" class="tl-nav" data-lapnav="-1" title="Next lap" ${tele.lapBack ? '' : 'disabled'}>›</button>
    </div>
    <svg class="tl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Speed through the lap">
      ${grid}<text x="${padL - 4}" y="12" class="ax">km/h</text>
      ${b ? `<path d="${line(b.pts, 'v', Y)}" class="sp ${same ? 'dash' : ''}" style="--c:${B.colour}"/>` : ''}
      <path d="${line(a.pts, 'v', Y)}" class="sp" style="--c:${A.colour}"/>
      ${mins.map((m) => `<text x="${X(m.f)}" y="${Y(m.v) + 13}" class="mn">${Math.round(m.v)}</text>`).join('')}
      <line class="tl-x" x1="-10" x2="-10" y1="0" y2="${H}"/>
    </svg>
    ${delta ? `<div class="tl-sub"><span class="tl-lbl">Gap</span><svg class="tl-svg" viewBox="0 0 ${W} ${HD}" preserveAspectRatio="none">
      <line x1="${padL}" x2="${W - padR}" y1="${HD / 2}" y2="${HD / 2}" class="gl"/>
      <path d="${delta.map((p, i) => `${i ? 'L' : 'M'}${X(p.f).toFixed(1)},${YD(p.v).toFixed(1)}`).join('')}" class="dl"/>
      <text x="${padL - 4}" y="10" class="ax">+${dmax.toFixed(1)}</text><text x="${padL - 4}" y="${HD - 2}" class="ax">−${dmax.toFixed(1)}</text>
      <line class="tl-x" x1="-10" x2="-10" y1="0" y2="${HD}"/>
    </svg></div>` : ''}
    <div class="tl-sub"><span class="tl-lbl">Throttle</span><svg class="tl-svg" viewBox="0 0 ${W} ${HT}" preserveAspectRatio="none">
      ${b ? `<path d="${thr(b.pts)}" class="th ${same ? 'dash' : ''}" style="--c:${B.colour}"/>` : ''}<path d="${thr(a.pts)}" class="th" style="--c:${A.colour}"/>${brakes}
      <line class="tl-x" x1="-10" x2="-10" y1="0" y2="${HT}"/>
    </svg></div>
    <div class="tl-read" id="tl-read">Hover the trace to compare speed, gear and throttle at any point of the lap.${delta ? ` Gap line above the middle: ${A.code} is ahead at that point.` : ''} Red ticks: ${A.code} braking.</div>`;
  // hover readout
  const read = box.querySelector('#tl-read');
  box.querySelectorAll('.tl-svg').forEach((svg) => {
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, ((e.clientX - r.left) / r.width * W - padL) / (W - padL - padR)));
      box.querySelectorAll('.tl-x').forEach((l) => { l.setAttribute('x1', X(f)); l.setAttribute('x2', X(f)); });
      const pa = a.pts[Math.min(a.pts.length - 1, Math.round(f * (a.pts.length - 1)))];
      const one = (pts, who) => {
        const v = atF(pts, f, 'v'), th = atF(pts, f, 'thr');
        const near = pts.reduce((m, p) => (Math.abs(p.f - f) < Math.abs(m.f - f) ? p : m), pts[0]);
        return `<b>${who.code}</b> ${Math.round(v)} km/h · gear ${near.gear ?? '–'} · throttle ${Math.round(th)}%${near.brk > 0 ? ' · braking' : ''}`;
      };
      const dv = delta ? atF(delta, f, 'v') : null;
      read.innerHTML = `${Math.round(f * a.total)} m · ${one(a.pts, A)}${b ? ` &nbsp;|&nbsp; ${one(b.pts, B)}` : ''}${dv != null ? ` &nbsp;|&nbsp; ${A.code} ${dv >= 0 ? 'ahead' : 'behind'} by ${Math.abs(dv).toFixed(2)} s here` : ''}`;
      void pa;
    });
  });
}

(function wireTelemetry() {
  const box = document.querySelector('#telemetry');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lapnav]');
    if (!b) return;
    tele.lapBack = Math.max(0, tele.lapBack + Number(b.dataset.lapnav));
    renderTelemetry(true);
  });
})();

function maybeRenderTelemetry() {
  if (typeof anMode === 'undefined' || anMode !== 'speed') return;
  const now = performance.now();
  if (now - tele.at < 1000) return;
  tele.at = now;
  renderTelemetry(false);
}
