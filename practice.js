// Practice mode: there are no gaps between cars in practice (OpenF1 only times
// intervals in races), so the board ranks drivers by their best lap, with the
// gap to the fastest, the last lap, tyre and laps done, and who is on a lap.
// The top bar shows the session and the time left instead of race laps.
'use strict';

function isPractice(d) {
  return /practice/i.test(d?.raw?.session?.session_name || '');
}

function practiceAt(d, t) {
  const rel = (iso) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`) - d.t0;
  const start = rel(d.raw.session.date_start), end = rel(d.raw.session.date_end);
  const live = t < end;
  // a lap far off the pace (in-lap, cool-down, red flag) isn't a real time
  let fastest = Infinity;
  for (const s of d.laps.values()) for (const l of s.rows) if (l.end != null && l.end <= t && l.dur && !l.pitOut) fastest = Math.min(fastest, l.dur);
  const slow = fastest * 1.25;
  const rows = [];
  for (const [num, drv] of d.drivers) {
    const s = d.laps.get(num);
    let best = Infinity, last = null, laps = 0, onLap = false;
    for (const l of s?.rows || []) {
      if (l.t > t) break;
      if (l.end != null && l.end <= t) {
        laps++;
        if (l.dur) { last = l.dur; if (l.dur < slow && !l.pitOut) best = Math.min(best, l.dur); }
      } else if (live && !l.pitOut && t - l.t < 150_000) onLap = true;
    }
    const st = (d.stints.get(num) || []).filter((x) => x.lap_start <= (s ? at(s, t)?.n ?? 0 : 0)).at(-1);
    rows.push({ n: num, drv, best, last, laps, onLap, tyre: st ? TYRES[st.compound]?.[0] : null, tyreC: st ? TYRES[st.compound]?.[1] : null });
  }
  rows.sort((a, b) => a.best - b.best || b.laps - a.laps || a.n - b.n);
  const p1 = rows[0]?.best;
  rows.forEach((r, i) => { r.pos = i + 1; r.gap = i > 0 && r.best < Infinity && p1 < Infinity ? r.best - p1 : null; });
  const label = (d.raw.session.session_name || 'Practice').replace(/^Practice\s*(\d)$/i, 'FP$1');
  const clock = t < start ? null : live ? Math.max(0, end - t) : 'Finished';
  return { rows, label, clock, p1 };
}

function renderPracticeBoard(t) {
  const d = state.data;
  const q = practiceAt(d, t);
  state.lastBoard = q.rows;
  const head = document.querySelector('#board-head');
  if (state.headKey !== 'practice') {
    state.headKey = 'practice';
    head.innerHTML = '<tr><th class="num">Pos</th><th>Driver</th><th class="num">Best</th><th class="num">Gap</th><th class="num">Last lap</th><th>Tyre</th><th class="num">Laps</th></tr>';
  }
  const tbody = document.querySelector('#board');
  const animate = !state.jumped && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  state.jumped = false;
  const before = new Map();
  if (animate) for (const [n, tr] of rowEls) if (tr.isConnected) before.set(n, tr.getBoundingClientRect().top);
  q.rows.forEach((r, i) => {
    let tr = rowEls.get(r.n);
    if (!tr) { tr = document.createElement('tr'); tr.dataset.n = r.n; tr.tabIndex = 0; tr.style.setProperty('--team', r.drv.colour); rowEls.set(r.n, tr); }
    const html = `
      <td class="pos">${i + 1}</td>
      <td><div class="drv"><span class="bar"></span><b>${r.drv.code}</b>${r.onLap ? '<span class="tag lap">On a lap</span>' : ''}<span class="team col-team">${r.drv.team}</span></div></td>
      <td class="num ${i === 0 && r.best < Infinity ? 'best' : ''}">${r.best < Infinity ? fmtLap(r.best) : '–'}</td>
      <td class="num">${r.gap != null ? `+${r.gap.toFixed(3)}` : ''}</td>
      <td class="num muted">${r.last ? fmtLap(r.last) : ''}</td>
      <td>${r.tyre ? `<span class="tyre"><i style="--c:${r.tyreC}">${r.tyre}</i></span>` : ''}</td>
      <td class="num">${r.laps || ''}</td>`;
    if (tr._html !== html) { tr.innerHTML = html; tr._html = html; }
    tr.className = state.selected === r.n ? 'sel' : state.compare === r.n ? 'cmp' : '';
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
  // top bar: session and time left instead of race laps
  document.querySelector('.lapbox .lbl').textContent = '';
  document.querySelector('#lap').textContent = q.label;
  document.querySelector('#lap-total').textContent = '';
  document.querySelector('.clockbox .lbl').textContent = typeof q.clock === 'number' ? 'Time left' : '';
  document.querySelector('#clock').textContent = typeof q.clock === 'number' ? fmtClock(q.clock).replace(/^0:/, '') : (q.clock || '–');
  return q;
}
