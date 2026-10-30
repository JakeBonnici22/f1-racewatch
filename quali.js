// Qualifying mode: the board ranks drivers by their best lap in the current
// part (Q1/Q2/Q3, or SQ1/SQ2/SQ3 for sprint qualifying), draws the drop-out
// line, shows who is on a flying lap and what time each driver at risk needs
// to get through. Eliminated drivers sit below in their final order.
'use strict';

function isQuali(d) {
  const n = (d?.raw?.session?.session_name || '').toLowerCase();
  return n.includes('qualifying') || n.includes('shootout');
}

// phases, deleted laps and the knock-out sizes, from race control
function qualiPrep(d) {
  const rc = d.raw.race_control || [];
  const t0 = d.t0;
  const rel = (iso) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`) - t0;
  const phases = [];
  for (const r of rc) {
    const m = (r.message || '').toUpperCase();
    const p = r.qualifying_phase;
    if (!p) continue;
    if (r.category === 'SessionStatus' && m.includes('STARTED') && !phases[p - 1]) phases[p - 1] = { p, start: rel(r.date), end: null };
    if (phases[p - 1] && (m.includes('CHEQUERED') || (r.category === 'SessionStatus' && m.includes('FINISHED'))) && phases[p - 1].end == null) phases[p - 1].end = rel(r.date);
  }
  // lap times deleted for track limits: "CAR 44 (HAM) TIME 1:32.123 DELETED - ... LAP 7"
  const deleted = new Set();
  for (const r of rc) {
    const m = (r.message || '').toUpperCase();
    const hit = m.match(/CAR (\d+).*?TIME [\d:.]+ DELETED.*?LAP (\d+)/);
    if (hit) deleted.add(`${hit[1]}_${hit[2]}_${rel(r.date)}`);
  }
  const n = d.drivers.size;
  const q2out = Math.max(0, Math.round((n - 10) / 2));
  const q1out = Math.max(0, n - 10 - q2out);
  const sprint = (d.raw.session.session_name || '').toLowerCase().includes('sprint');
  const lengths = sprint ? [12, 10, 8] : [18, 15, 12]; // minutes, for the countdown before the flag
  d.quali = { phases: phases.filter(Boolean), deleted, q1out, q2out, sprint, lengths };
}

function lapDeletedBefore(Q, num, lap, t) {
  for (const k of Q.deleted) {
    const [n, l, at] = k.split('_').map(Number);
    if (n === num && l === lap && at <= t) return true;
  }
  return false;
}

function qualiAt(d, t) {
  if (!d.quali) qualiPrep(d);
  const Q = d.quali;
  let pi = -1;
  Q.phases.forEach((p, i) => { if (p.start <= t) pi = i; });
  const phaseOf = (lapT) => {
    let k = -1;
    Q.phases.forEach((p, i) => { if (p.start - 120_000 <= lapT) k = i; }); // out-laps can start just before the green
    return k;
  };
  // a lap far off the pace (red flag, crawling back) isn't a real time
  let fastest = Infinity;
  for (const s of d.laps.values()) for (const l of s.rows) if (l.end != null && l.end <= t && l.dur && !l.pitOut) fastest = Math.min(fastest, l.dur);
  const slow = fastest * 1.2;
  const live = pi >= 0 && (Q.phases[pi].end == null || t < Q.phases[pi].end);
  const rows = [];
  for (const [num, drv] of d.drivers) {
    const s = d.laps.get(num);
    const best = [Infinity, Infinity, Infinity];
    let onLap = false, laps = 0;
    for (const l of s?.rows || []) {
      if (l.t > t) break;
      const k = phaseOf(l.t);
      if (k < 0) continue;
      if (l.end != null && l.end <= t && l.dur && l.dur < slow && !l.pitOut && !lapDeletedBefore(Q, num, l.n, t)) best[k] = Math.min(best[k], l.dur);
      if (k === pi) laps++;
      if (live && k === pi && !l.pitOut && (l.end == null || l.end > t) && t - l.t < 150_000) onLap = true;
    }
    const st = (d.stints.get(num) || []).filter((x) => x.lap_start <= (s ? at(s, t)?.n ?? 0 : 0)).at(-1);
    rows.push({ n: num, drv, best, onLap, laps, tyre: st ? TYRES[st.compound]?.[0] : null, tyreC: st ? TYRES[st.compound]?.[1] : null, out: false });
  }
  const by = (k) => (a, b) => a.best[k] - b.best[k] || a.n - b.n;
  // who was knocked out at the end of each finished part
  const elim = new Map();
  let alive = rows.slice();
  const outs = [Q.q1out, Q.q2out];
  for (let k = 0; k < Math.min(2, Q.phases.length); k++) {
    const p = Q.phases[k];
    if (p.end == null || t < p.end || pi <= k) break;
    alive.sort(by(k));
    const cut = alive.length - outs[k];
    alive.slice(cut).forEach((r, i) => elim.set(r.n, { phase: k, rank: i }));
    alive = alive.slice(0, cut);
  }
  const k = Math.max(0, pi);
  alive.sort(by(k));
  const dropAt = k < 2 && Q.phases.length ? alive.length - outs[k] : null; // index of first car in the drop zone
  const p1 = alive[0]?.best[k];
  const cutoff = dropAt != null && dropAt > 0 ? alive[dropAt - 1]?.best[k] : null; // time of the last safe car
  const order = alive.map((r, i) => ({ ...r, cur: r.best[k], gap: r.best[k] < Infinity && p1 < Infinity ? r.best[k] - p1 : null, danger: dropAt != null && i >= dropAt,
  }));
  const knocked = [...elim.entries()].sort((a, b) => b[1].phase - a[1].phase || a[1].rank - b[1].rank)
    .map(([n, e]) => { const r = rows.find((x) => x.n === n); return { ...r, cur: r.best[e.phase], gap: null, elimIn: e.phase }; });
  const all = order.concat(knocked);
  all.forEach((r, i) => { r.pos = i + 1; });
  const p = Q.phases[pi];
  const name = (i) => `${Q.sprint ? 'SQ' : 'Q'}${i + 1}`;
  let clock = null, label = name(k);
  if (pi < 0) label = 'Pre';
  else if (p.end != null && t >= p.end) clock = pi === Q.phases.length - 1 && pi >= 2 ? 'Finished' : `${name(pi)} done`;
  else clock = Math.max(0, p.start + Q.lengths[pi] * 60_000 - t);
  return { rows: all, phase: k, pi, label, clock, dropAt, cutoff, name };
}

const fmtQ = (s) => (s && s < Infinity ? fmtLap(s) : '–');
const fmtD = (x) => (x == null ? '' : `+${x.toFixed(3)}`);

function renderQualiBoard(t) {
  const d = state.data;
  const q = qualiAt(d, t);
  state.lastBoard = q.rows;
  const head = document.querySelector('#board-head');
  const key = `quali|${q.phase}`;
  if (state.headKey !== key) {
    state.headKey = key;
    head.innerHTML = `<tr><th class="num">Pos</th><th>Driver</th><th class="num">${q.name(q.phase)} best</th><th class="num">Gap</th><th>Tyre</th><th class="num">Laps</th><th>To get through</th></tr>`;
  }
  const tbody = document.querySelector('#board');
  const animate = !state.jumped;
  state.jumped = false;
  const before = new Map();
  if (animate) for (const [n, tr] of rowEls) if (tr.isConnected) before.set(n, tr.getBoundingClientRect().top);
  q.rows.forEach((r, i) => {
    let tr = rowEls.get(r.n);
    if (!tr) { tr = document.createElement('tr'); tr.dataset.n = r.n; tr.tabIndex = 0; tr.style.setProperty('--team', r.drv.colour); rowEls.set(r.n, tr); }
    const cut = q.cutoff != null && q.cutoff < Infinity ? q.cutoff : null;
    const status = r.elimIn != null ? `<span class="muted">Out in ${q.name(r.elimIn)}</span>`
      : r.danger ? (r.cur < Infinity && cut ? `<span class="q-need">Needs ${(r.cur - cut + 0.001).toFixed(3)} faster · ${fmtLap(cut - 0.001)}</span>`
        : cut ? `<span class="q-need">No time yet · needs ${fmtLap(cut - 0.001)}</span>` : '<span class="q-need">No time yet</span>')
        : q.dropAt != null ? (cut && r.cur < Infinity ? `<span class="q-safe">${cut - r.cur < 0.0005 ? 'Last car through' : `Safe by ${(cut - r.cur).toFixed(3)}`}</span>` : '<span class="q-safe">Safe for now</span>') : '';
    const html = `
      <td class="pos">${i + 1}</td>
      <td><div class="drv"><span class="bar"></span><b>${r.drv.code}</b>${r.onLap ? '<span class="tag lap">On a lap</span>' : ''}<span class="team col-team">${r.drv.team}</span></div></td>
      <td class="num">${fmtQ(r.cur)}</td>
      <td class="num">${r.gap ? fmtD(r.gap) : ''}</td>
      <td>${r.tyre ? `<span class="tyre"><i style="--c:${r.tyreC}">${r.tyre}</i></span>` : ''}</td>
      <td class="num">${r.elimIn == null ? r.laps : ''}</td>
      <td>${status}</td>`;
    if (tr._html !== html) { tr.innerHTML = html; tr._html = html; }
    tr.className = [state.selected === r.n ? 'sel' : state.compare === r.n ? 'cmp' : '', r.elimIn != null ? 'out' : '', r.danger ? 'q-danger' : '', i === q.dropAt ? 'q-line' : ''].join(' ');
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
  });
  while (tbody.children.length > q.rows.length) tbody.lastChild.remove();
  if (typeof fitBoardWidth === 'function' && state.fitKey !== state.headKey && q.rows.length) { state.fitKey = state.headKey; fitBoardWidth(); }
  if (animate) for (const r of q.rows) {
    const tr = rowEls.get(r.n), was = before.get(r.n);
    if (was == null) continue;
    const dy = was - tr.getBoundingClientRect().top;
    if (!dy || Math.abs(dy) > tr.offsetHeight * 6) continue;
    tr.style.transition = 'none'; tr.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => { tr.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)'; tr.style.transform = ''; });
  }
  // top bar: part and time left instead of lap and race time
  document.querySelector('.lapbox .lbl').textContent = '';
  document.querySelector('#lap').textContent = q.label;
  document.querySelector('#lap-total').textContent = '';
  document.querySelector('.clockbox .lbl').textContent = typeof q.clock === 'number' ? 'Time left' : '';
  document.querySelector('#clock').textContent = typeof q.clock === 'number' ? fmtClock(q.clock).replace(/^0:/, '') : (q.clock || '–');
  return q;
}
