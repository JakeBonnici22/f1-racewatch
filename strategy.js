// Tyre strategy: one row per driver in running order, each stint a bar in its
// compound's colour across the race distance, pit stops as gaps, and a line at
// the leader's current lap. Lives in the analysis panel next to the gaps view.
'use strict';

let anMode = 'gaps';
let stratAt = 0;

function stintsFor(d, n, curLap) {
  const sts = (d.stints.get(n) || []).filter((s) => s.lap_start <= Math.max(1, curLap)).sort((a, b) => a.lap_start - b.lap_start);
  const segs = sts.map((s, i) => ({
    from: s.lap_start,
    to: Math.min(s.lap_end ?? curLap, curLap, (sts[i + 1]?.lap_start ?? Infinity) - 1),
    c: s.compound, age0: s.tyre_age_at_start ?? 0, sure: true,
  }));
  // a stop the stint feed hasn't caught up with yet: new tyres, compound unknown
  const lastSeg = segs.at(-1);
  const pitLaps = d.pits.rows.filter((p) => p.num === n && p.lap < curLap).map((p) => p.lap);
  const missed = lastSeg && pitLaps.filter((l) => l >= lastSeg.from).at(-1);
  if (missed) { lastSeg.to = missed; segs.push({ from: missed + 1, to: curLap, c: null, age0: 0, sure: false }); }
  return segs.filter((s) => s.to >= s.from);
}

function renderStrategy(t) {
  const d = state.data, board = state.lastBoard;
  const box = document.querySelector('#strategy');
  if (!d || !board || !box) return;
  const total = Math.max(d.totalLaps || 0, 1);
  const leaderLap = board.find((r) => !r.out)?.curLap ?? 0;
  const nowX = (Math.min(leaderLap, total) / total) * 100;
  const rows = board.map((r) => {
    const segs = stintsFor(d, r.n, r.curLap || 0);
    const stops = Math.max(0, segs.length - 1);
    const cur = segs.at(-1);
    const age = cur ? (cur.age0 + (r.curLap - cur.from)) : null;
    const bars = segs.map((s) => {
      const [letter, colour] = s.c && TYRES[s.c] ? TYRES[s.c] : ['?', '#7a8698'];
      const x = ((s.from - 1) / total) * 100, w = ((s.to - s.from + 1) / total) * 100;
      const laps = s.to - s.from + 1;
      const tip = `${r.drv.code}: ${s.c ? s.c.toLowerCase() : 'new tyres, compound not confirmed'}, laps ${s.from}–${s.to} (${laps} lap${laps > 1 ? 's' : ''})${s.age0 ? `, ${s.age0} laps old at the start` : ''}`;
      return `<i class="st ${s.sure ? '' : 'unsure'} ${s.age0 ? 'used' : ''}" style="left:${x}%;width:${w}%;--c:${colour}" title="${esc(tip)}">${w > 3.2 ? `<b>${letter}</b>${w > 6 ? `<span>${laps}</span>` : ''}` : ''}</i>`;
    }).join('');
    const sel = state.selected === r.n ? 'sel' : state.compare === r.n ? 'cmp' : '';
    return `<div class="sr ${r.out ? 'out' : ''} ${sel}" data-n="${r.n}">
      <span class="sr-name" style="--c:${r.drv.colour}">${esc(r.drv.code)}</span>
      <span class="sr-track">${bars}</span>
      <span class="sr-tail">${r.out ? 'Out' : `${stops} stop${stops === 1 ? '' : 's'}${age != null ? ` · ${cur?.c ? TYRES[cur.c]?.[0] ?? '?' : '?'} ${age}` : ''}`}</span>
    </div>`;
  }).join('');
  const lapTicks = [];
  const step = total > 40 ? 10 : 5;
  for (let l = step; l < total; l += step) lapTicks.push(`<span style="left:${(l / total) * 100}%">${l}</span>`);
  box.innerHTML = `<div class="sr-grid" style="--nowf:${nowX / 100}">${rows}
      <div class="sr-axis"><span class="sr-name"></span><span class="sr-track">${lapTicks.join('')}<span class="sr-now" style="left:${nowX}%">L${leaderLap}</span></span><span class="sr-tail"></span></div>
      <span class="sr-line"></span>
    </div>`;
}

(function wireStrategy() {
  const tabs = document.querySelector('#an-tabs');
  const panel = document.querySelector('#analysis');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-an]');
    if (!b) return;
    anMode = b.dataset.an;
    for (const x of tabs.children) x.classList.toggle('on', x === b);
    panel.classList.toggle('show-tyres', anMode === 'tyres');
    panel.classList.toggle('show-speed', anMode === 'speed');
    if (anMode === 'speed' && typeof renderTelemetry === 'function') renderTelemetry(true);
    try { localStorage.setItem('racewatch.anMode', anMode); } catch { /* not saved */ }
    stratAt = 0;
    if (anMode === 'tyres') renderStrategy(state.t);
    else if (typeof fitView === 'function') state.lastPanelUpdate = 0;
  });
  document.querySelector('#strategy').addEventListener('click', (e) => {
    const r = e.target.closest('.sr[data-n]');
    if (r) { selectDriver(Number(r.dataset.n)); stratAt = 0; }
  });
  try { const m = localStorage.getItem('racewatch.anMode'); if (m && m !== 'gaps') tabs.querySelector(`[data-an="${m}"]`)?.click(); } catch { /* default view */ }
})();

// called from the frame loop with the other panels; redraw about once a second
function maybeRenderStrategy(t) {
  if (anMode !== 'tyres') return;
  const now = performance.now();
  if (now - stratAt < 900) return;
  stratAt = now;
  renderStrategy(t);
}
