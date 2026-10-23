// Live championship standings: points before the race (from OpenF1's
// championship endpoints) plus the points each car would score if the race
// finished in the current running order.
'use strict';

const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

function liveStandings(d, board) {
  const startD = new Map((d.raw.championship_drivers || []).map((r) => [r.driver_number, r]));
  const startT = new Map((d.raw.championship_teams || []).map((r) => [r.team_name, r]));
  if (!startD.size) return null;
  const running = board.filter((r) => !r.out);
  const racePts = new Map(running.map((r, i) => [r.n, RACE_POINTS[i] ?? 0]));
  // once the flag is out, use the official totals (they include penalties)
  const official = typeof statusAt === 'function' && statusAt(state.t) === 'FINISH' && [...startD.values()].some((r) => r.points_current != null && r.points_current !== r.points_start);
  if (official) for (const [n, r] of startD) racePts.set(n, (r.points_current ?? r.points_start) - (r.points_start ?? 0));

  const drivers = [...d.drivers.values()].map((drv) => {
    const s = startD.get(drv.num);
    const add = racePts.get(drv.num) ?? 0;
    return { n: drv.num, drv, start: s?.points_start ?? 0, startPos: s?.position_start ?? 99, add, pts: (s?.points_start ?? 0) + add };
  }).sort((a, b) => b.pts - a.pts || a.startPos - b.startPos);
  drivers.forEach((r, i) => { r.pos = i + 1; });

  const teamAdd = new Map();
  for (const r of drivers) teamAdd.set(r.drv.team, (teamAdd.get(r.drv.team) ?? 0) + r.add);
  const teams = [...new Set([...startT.keys(), ...teamAdd.keys()])].map((name) => {
    const s = startT.get(name);
    const colour = [...d.drivers.values()].find((x) => x.team === name)?.colour ?? '#888888';
    const add = official && s?.points_current != null ? s.points_current - (s.points_start ?? 0) : teamAdd.get(name) ?? 0;
    return { name, colour, start: s?.points_start ?? 0, startPos: s?.position_start ?? 99, add, pts: (s?.points_start ?? 0) + add };
  }).sort((a, b) => b.pts - a.pts || a.startPos - b.startPos);
  teams.forEach((r, i) => { r.pos = i + 1; });
  return { drivers, teams };
}

const moved = (r) => {
  const dlt = r.startPos - r.pos;
  return dlt > 0 ? `<span class="delta-up">▲${dlt}</span>` : dlt < 0 ? `<span class="delta-down">▼${-dlt}</span>` : '<span class="flat">–</span>';
};

function renderStandings() {
  const d = state.data, board = state.lastBoard;
  if (!d || !board || state.boardTab === 'timing') return;
  const st = liveStandings(d, board);
  const el = document.querySelector(`#${state.boardTab}-body`);
  if (!st) { el.innerHTML = '<tr><td colspan="6" class="muted pad">No championship data for this session.</td></tr>'; return; }
  const sel = state.selected, cmp = state.compare;
  let html;
  if (state.boardTab === 'drivers') {
    const leader = st.drivers[0].pts;
    html = st.drivers.map((r) => `<tr data-n="${r.n}" style="--team:${r.drv.colour}" class="${r.n === sel ? 'sel' : r.n === cmp ? 'cmp' : ''}">
      <td class="pos">${r.pos}</td><td class="num mv">${moved(r)}</td>
      <td><div class="drv"><span class="bar"></span><b>${r.drv.code}</b><span class="team">${r.drv.team}</span></div></td>
      <td class="num"><b>${r.pts}</b></td>
      <td class="num ${r.add ? 'good' : 'muted'}">${r.add ? '+' + r.add : ''}</td>
      <td class="num muted">${r.pos === 1 ? '' : '−' + (leader - r.pts)}</td></tr>`).join('');
  } else {
    const leader = st.teams[0].pts;
    html = st.teams.map((r) => `<tr style="--team:${r.colour}">
      <td class="pos">${r.pos}</td><td class="num mv">${moved(r)}</td>
      <td><div class="drv"><span class="bar"></span><b>${r.name}</b></div></td>
      <td class="num"><b>${r.pts}</b></td>
      <td class="num ${r.add ? 'good' : 'muted'}">${r.add ? '+' + r.add : ''}</td>
      <td class="num muted">${r.pos === 1 ? '' : '−' + (leader - r.pts)}</td></tr>`).join('');
  }
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

document.querySelector('#board-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.boardTab = b.dataset.tab;
  for (const x of document.querySelectorAll('#board-tabs button')) x.classList.toggle('on', x === b);
  for (const id of ['timing', 'drivers', 'teams']) document.getElementById(`${id}-table`).hidden = id !== state.boardTab;
  state.lastPanelUpdate = 0;
});
document.querySelector('#drivers-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-n]');
  if (tr) selectDriver(Number(tr.dataset.n));
});
