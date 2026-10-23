// Records in play: all-time and season records, streaks, "youngest ever"
// marks and round-number milestones that the race being watched could set,
// with a live status from the current running order. History comes from
// data/history.json (build_history.py, every Grand Prix since 1950); the race
// itself and its pole come from the session being watched.
'use strict';

let HIST = null;
async function loadHistory() {
  if (HIST) return HIST;
  try {
    const r = await fetch('data/history.json');
    if (!r.ok) return null;
    HIST = await r.json();
  } catch { return null; }
  return HIST;
}

const DAY = 86_400_000;
const ageOf = (dob, date) => (Date.parse(date) - Date.parse(dob)) / DAY;
const ageTxt = (days) => { const y = Math.floor(days / 365.25); return `${y} years ${Math.round(days - y * 365.25)} days`; };
const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

// tallies over every Grand Prix before `date`
function tally(H, date, year) {
  const D = new Map(), T = new Map();
  const dr = (id) => { let x = D.get(id); if (!x) D.set(id, x = { wins: 0, podiums: 0, poles: 0, starts: 0, sw: 0, sp: 0, spo: 0, streakW: 0, streakP: 0, streakPts: 0, won: false, podium: false, scored: false, pole: false }); return x; };
  const tm = (id) => { let x = T.get(id); if (!x) T.set(id, x = { sw: 0, streakW: 0 }); return x; };
  const rec = { wins: [0], podiums: [0], poles: [0], starts: [0], sw: [0], sp: [0], spo: [0], streakW: [0], streakP: [0], streakPts: [0],
    yWin: [Infinity], yPole: [Infinity], yPodium: [Infinity], yPoints: [Infinity], tsw: [0], tStreakW: [0] };
  const best = (key, v, who, extra) => { if (v > rec[key][0]) rec[key] = [v, who, extra]; };
  const young = (key, v, who, extra) => { if (v < rec[key][0]) rec[key] = [v, who, extra]; };
  const season = new Map(); // `${id}|${year}` -> {w,p,po}
  const teamSeason = new Map();
  let lastWinner = null, lastTeam = null, curYear = null;
  for (const race of H.races) {
    if (race.date >= date) break;
    if (race.season !== curYear) { curYear = race.season; }
    for (const [id, team, pos, , pts] of race.results) {
      const x = dr(id);
      x.starts++; best('starts', x.starts, id);
      const k = `${id}|${race.season}`, s = season.get(k) || { w: 0, p: 0, po: 0 };
      if (pos === 1) {
        x.wins++; s.w++; best('wins', x.wins, id); best('sw', s.w, id, race.season);
        const dob = H.drivers[id]?.dob; if (dob) young('yWin', ageOf(dob, race.date), id, race);
        const ts = `${team}|${race.season}`; teamSeason.set(ts, (teamSeason.get(ts) || 0) + 1); best('tsw', teamSeason.get(ts), team, race.season);
      }
      if (pos && pos <= 3) {
        x.podiums++; s.p++; x.streakP++; best('podiums', x.podiums, id); best('sp', s.p, id, race.season); best('streakP', x.streakP, id);
        const dob = H.drivers[id]?.dob; if (dob) young('yPodium', ageOf(dob, race.date), id, race);
      } else x.streakP = 0;
      if (pts > 0) {
        x.streakPts++; best('streakPts', x.streakPts, id);
        const dob = H.drivers[id]?.dob; if (dob) young('yPoints', ageOf(dob, race.date), id, race);
      } else x.streakPts = 0;
      season.set(k, s);
    }
    if (race.pole) {
      const x = dr(race.pole); x.poles++; best('poles', x.poles, race.pole);
      const k = `${race.pole}|${race.season}`, s = season.get(k) || { w: 0, p: 0, po: 0 }; s.po++; season.set(k, s); best('spo', s.po, race.pole, race.season);
      const dob = H.drivers[race.pole]?.dob; if (dob) young('yPole', ageOf(dob, race.date), race.pole, race);
    }
    const win = race.results.find((r) => r[2] === 1);
    if (win) {
      const w = dr(win[0]);
      w.streakW = lastWinner === win[0] ? w.streakW + 1 : 1; best('streakW', w.streakW, win[0]);
      if (lastWinner && lastWinner !== win[0]) dr(lastWinner).streakW = 0;
      lastWinner = win[0];
      const t = tm(win[1]);
      t.streakW = lastTeam === win[1] ? t.streakW + 1 : 1; best('tStreakW', t.streakW, win[1]);
      if (lastTeam && lastTeam !== win[1]) tm(lastTeam).streakW = 0;
      lastTeam = win[1];
    }
  }
  for (const [k, s] of season) {
    const [id, y] = k.split('|');
    if (Number(y) === year) { const x = dr(id); x.sw = s.w; x.sp = s.p; x.spo = s.po; }
  }
  for (const [k, n] of teamSeason) { const [team, y] = k.split('|'); if (Number(y) === year) tm(team).sw = n; }
  return { D, T, rec, lastWinner, lastTeam };
}

// sprint races, counted on their own (official stats don't add them to wins)
function sprintTally(H, date) {
  const D = new Map(), rec = { wins: [0], podiums: [0], streakW: [0] };
  const dr = (id) => { let x = D.get(id); if (!x) D.set(id, x = { wins: 0, podiums: 0, starts: 0, streakW: 0 }); return x; };
  let lastWinner = null;
  for (const sp of H.sprints || []) {
    if (sp.date >= date) break;
    for (const [id, , pos] of sp.results) {
      const x = dr(id); x.starts++;
      if (pos === 1) { x.wins++; if (x.wins > rec.wins[0]) rec.wins = [x.wins, id]; }
      if (pos && pos <= 3) { x.podiums++; if (x.podiums > rec.podiums[0]) rec.podiums = [x.podiums, id]; }
    }
    const w = sp.results.find((r) => r[2] === 1);
    if (w) {
      const x = dr(w[0]); x.streakW = lastWinner === w[0] ? x.streakW + 1 : 1;
      if (x.streakW > rec.streakW[0]) rec.streakW = [x.streakW, w[0]];
      if (lastWinner && lastWinner !== w[0]) dr(lastWinner).streakW = 0;
      lastWinner = w[0];
    }
  }
  return { D, rec };
}

// match OpenF1 drivers (number, code) to Jolpica ids by code among recent drivers
function matchDrivers(H, d, year) {
  const recent = new Set();
  for (const race of H.races) if (race.season >= year - 1) for (const r of race.results) recent.add(r[0]);
  const byCode = new Map();
  for (const id of recent) { const c = H.drivers[id]?.code; if (c) byCode.set(c, id); }
  // car numbers in this season's results, for drivers without a code
  const byNum = new Map();
  for (const race of H.races) if (race.season === year) for (const r of race.results) if (r[5]) byNum.set(r[5], r[0]);
  const out = new Map();
  for (const drv of d.drivers.values()) { const id = byCode.get(drv.code) || byNum.get(drv.num); if (id) out.set(drv.num, id); }
  return out;
}

const who = (H, id) => H.drivers[id]?.code || H.drivers[id]?.name || id;
const whoFull = (H, id) => H.drivers[id]?.name || id;
const teamName = (H, id) => H.teams?.[id] || id;

function recordsInPlay(H, ctx) {
  const d = ctx.d, s = d.raw.session;
  const date = s.date_start.slice(0, 10), year = ctx.year;
  const { D, T, rec } = tally(H, date, year);
  const ids = matchDrivers(H, d, year);
  const sprint = /sprint/i.test(s.session_name || '') && !/qualifying|shootout/i.test(s.session_name || '');
  const SP = sprintTally(H, date);
  const startPts = new Map((d.raw.championship_drivers || []).map((r) => [r.driver_number, r.points_start]));
  // career points: finished seasons from Jolpica, this season from OpenF1 (includes sprints)
  const career = new Map();
  for (const [y, tbl] of Object.entries(H.standings)) {
    if (Number(y) >= year) continue;
    for (const [id, p] of Object.entries(tbl)) career.set(id, (career.get(id) || 0) + p);
  }
  for (const [n, id] of ids) career.set(id, (career.get(id) || 0) + (startPts.get(n) || 0));
  let ptsRec = [0];
  for (const [id, p] of career) if (p > ptsRec[0]) ptsRec = [p, id];
  let seasonPtsRec = [0];
  for (const [y, tbl] of Object.entries(H.standings)) if (Number(y) < year) for (const [id, p] of Object.entries(tbl)) if (p > seasonPtsRec[0]) seasonPtsRec = [p, id, y];

  // where everyone is right now (or finished), and who took pole
  const board = state.lastBoard || [];
  const running = board.filter((r) => !r.out);
  const posNow = new Map(running.map((r, i) => [r.n, i + 1]));
  const finished = ctx.finished;
  const poleNum = [...d.grid.entries()].find(([, p]) => p === 1)?.[0];
  const teamOf = new Map([...d.drivers.values()].map((x) => [x.num, x.team]));
  const items = [];
  const add = (it) => items.push(it);

  // status for "needs to finish P<=k"
  const status = (n, k) => {
    const p = posNow.get(n);
    if (p == null) return finished ? ['miss', 'Retired'] : ['miss', 'Out of the race'];
    if (p <= k) return finished ? ['done', `Done · P${p}`] : ['on', `On course · P${p} now`];
    return finished ? ['miss', `Missed · P${p}`] : ['off', `Needs P${k === 1 ? 1 : `≤${k}`} · P${p} now`];
  };

  if (sprint) return sprintRecords(H, ctx, ids, SP, posNow, finished, status, items, add, rec, ptsRec, seasonPtsRec);

  for (const drv of d.drivers.values()) {
    const id = ids.get(drv.num);
    const x = (id && D.get(id)) || { wins: 0, podiums: 0, poles: 0, starts: 0, sw: 0, sp: 0, spo: 0, streakW: 0, streakP: 0, streakPts: 0 };
    const base = { n: drv.num, code: drv.code, colour: drv.colour };
    const dob = id && H.drivers[id]?.dob;
    const age = dob ? ageOf(dob, date) : null;
    const career_ = (key, label, k, noun) => {
      const [R, holder] = rec[key];
      const v = x[key] + 1;
      if (v < R || R === 0) return false;
      const own = holder === id;
      const kind = own ? 'extend' : v > R ? 'break' : 'equal';
      const txt = own ? `${noun} would be his <b>${nth(v)}</b>, extending his own record for ${label} (${R}).`
        : kind === 'break' ? `${noun} would be his <b>${nth(v)}</b>, breaking ${whoFull(H, holder)}'s record for ${label} (${R}).`
          : `${noun} would be his <b>${nth(v)}</b>, equalling ${whoFull(H, holder)}'s record for ${label} (${R}).`;
      add({ ...base, group: 'All-time', kind, txt, st: status(drv.num, k) });
      return true;
    };
    const flags = {};
    flags.w = career_('wins', 'most Grand Prix wins', 1, 'A win');
    flags.p = career_('podiums', 'most podiums', 3, 'A podium');
    // starts and pole are already decided once the race is on
    if (x.starts + 1 >= rec.starts[0] && rec.starts[0]) {
      const own = rec.starts[1] === id, v = x.starts + 1;
      add({ ...base, group: 'All-time', kind: own ? 'extend' : v > rec.starts[0] ? 'break' : 'equal',
        txt: own ? `His <b>${nth(v)}</b> Grand Prix start, extending his own record.` : `His <b>${nth(v)}</b> start, ${v > rec.starts[0] ? 'breaking' : 'equalling'} ${whoFull(H, rec.starts[1])}'s record (${rec.starts[0]}).`,
        st: posNow.has(drv.num) || board.some((r) => r.n === drv.num) ? ['done', 'Done · started'] : ['miss', 'Did not start'] });
      flags.s = true;
    }
    if (drv.num === poleNum && x.poles + 1 >= rec.poles[0]) {
      const own = rec.poles[1] === id, v = x.poles + 1;
      add({ ...base, group: 'All-time', kind: own ? 'extend' : 'break', txt: `Pole today is his <b>${nth(v)}</b>, ${own ? 'extending his own record' : `${v > rec.poles[0] ? 'breaking' : 'equalling'} ${whoFull(H, rec.poles[1])}'s record (${rec.poles[0]})`}.`, st: ['done', 'Done · on pole'] });
    }
    const cp = career.get(id) || 0;
    if (ptsRec[0] && cp + 25 >= ptsRec[0]) {
      const own = ptsRec[1] === id;
      const gain = (RACE_POINTS[(posNow.get(drv.num) ?? 99) - 1] ?? 0);
      const need = Math.ceil(ptsRec[0] - cp + (own ? 0 : 0.5));
      add({ ...base, group: 'All-time', kind: own ? 'extend' : 'break',
        txt: own ? `Holds the record for career points (${Math.round(cp)}); every point today adds to it.` : `Needs <b>${need}</b> points to pass ${whoFull(H, ptsRec[1])}'s record of ${Math.round(ptsRec[0])} career points.`,
        st: own ? (gain ? ['on', `+${gain} as it stands`] : ['off', 'No points as it stands']) : gain >= need ? ['on', `+${gain} as it stands`] : ['off', `+${gain} as it stands`] });
    }
    // season records
    const season_ = (key, label, k, noun) => {
      const [R, holder, y] = rec[key];
      const v = x[key] + 1;
      if (!R || v < R) return;
      const own = holder === id && Number(y) === year;
      add({ ...base, group: `${year} season`, kind: own ? 'extend' : v > R ? 'break' : 'equal',
        txt: `${noun} would be his <b>${nth(v)}</b> this year, ${v > R ? 'beating' : 'equalling'} the record for ${label} (${R}, ${whoFull(H, holder)} in ${y}).`, st: status(drv.num, k) });
    };
    season_('sw', 'wins in a season', 1, 'A win');
    season_('sp', 'podiums in a season', 3, 'A podium');
    const sp = startPts.get(drv.num) || 0;
    if (seasonPtsRec[0] && sp + 25 >= seasonPtsRec[0]) {
      const gain = RACE_POINTS[(posNow.get(drv.num) ?? 99) - 1] ?? 0;
      const need = Math.floor(seasonPtsRec[0] - sp) + 1;
      add({ ...base, group: `${year} season`, kind: 'break', txt: `Needs <b>${need}</b> points to beat the record for points in a season (${seasonPtsRec[0]}, ${whoFull(H, seasonPtsRec[1])} in ${seasonPtsRec[2]}).`, st: gain >= need ? ['on', `+${gain} as it stands`] : ['off', `+${gain} as it stands`] });
    }
    // streaks
    const streak_ = (key, label, k, noun) => {
      const [R, holder] = rec[key];
      const v = x[key] + 1;
      if (!R || x[key] < 3 || v < R) return;
      const own = holder === id;
      add({ ...base, group: 'Streaks', kind: own ? 'extend' : v > R ? 'break' : 'equal',
        txt: `${noun} would make it <b>${v} in a row</b>, ${own ? 'extending his own record' : `${v > R ? 'breaking' : 'equalling'} the record for ${label} (${R}, ${whoFull(H, holder)})`}.`, st: status(drv.num, k) });
    };
    streak_('streakW', 'consecutive wins', 1, 'A win');
    streak_('streakP', 'consecutive podiums', 3, 'A podium');
    streak_('streakPts', 'consecutive points finishes', 10, 'Points');
    // youngest ever
    if (age != null) {
      const yng = (key, done, label, k) => {
        const [R, holder] = rec[key];
        if (done || !(age < R)) return;
        add({ ...base, group: 'Youngest ever', kind: 'break', txt: `At ${ageTxt(age)} he would be the youngest ever ${label} (record: ${whoFull(H, holder)}, ${ageTxt(R)}).`, st: status(drv.num, k) });
      };
      yng('yWin', x.wins > 0, 'Grand Prix winner', 1);
      yng('yPodium', x.podiums > 0, 'podium finisher', 3);
      if (drv.num === poleNum) yng('yPole', x.poles > 0, 'pole-sitter', 99);
    }
    // milestones and firsts
    const P = posNow.get(drv.num);
    if (!flags.w) {
      const v = x.wins + 1;
      if (v === 1 && P != null && P <= 3) add({ ...base, group: 'Milestones', kind: 'milestone', txt: '<b>First career win</b> if he takes it from here.', st: status(drv.num, 1) });
      else if (v > 1 && (v % 10 === 0 || v === 25 || v === 75)) add({ ...base, group: 'Milestones', kind: 'milestone', txt: `A win would be his <b>${nth(v)}</b>.`, st: status(drv.num, 1) });
    }
    if (!flags.p) {
      const v = x.podiums + 1;
      if (v === 1 && P != null && P <= 4) add({ ...base, group: 'Milestones', kind: 'milestone', txt: '<b>First career podium</b> within reach.', st: status(drv.num, 3) });
      else if (v > 1 && v % 25 === 0) add({ ...base, group: 'Milestones', kind: 'milestone', txt: `A podium would be his <b>${nth(v)}</b>.`, st: status(drv.num, 3) });
    }
    if (!flags.s && (x.starts + 1) % 50 === 0) add({ ...base, group: 'Milestones', kind: 'milestone', txt: `His <b>${nth(x.starts + 1)}</b> Grand Prix start.`, st: ['done', 'Done · started'] });
    if (drv.num === poleNum && (x.poles + 1) % 10 === 0) add({ ...base, group: 'Milestones', kind: 'milestone', txt: `Pole today is his <b>${nth(x.poles + 1)}</b>.`, st: ['done', 'Done'] });
    const nextK = Math.ceil((cp + 0.01) / 500) * 500;
    if (cp && nextK - cp <= 25 && !(ptsRec[0] && cp + 25 >= ptsRec[0])) {
      const gain = RACE_POINTS[(P ?? 99) - 1] ?? 0, need = Math.ceil(nextK - cp);
      add({ ...base, group: 'Milestones', kind: 'milestone', txt: `Needs <b>${need}</b> point${need === 1 ? '' : 's'} to reach ${nextK} career points.`, st: gain >= need ? ['on', `+${gain} as it stands`] : ['off', `+${gain} as it stands`] });
    }
  }

  // teams: wins in a season, consecutive wins
  const teamIds = new Map(); // OpenF1 team name -> Jolpica constructor id (via this year's results)
  for (const race of H.races) if (race.season === year) for (const r of race.results) {
    const num = [...ids.entries()].find(([, id]) => id === r[0])?.[0];
    if (num != null) teamIds.set(teamOf.get(num), r[1]);
  }
  for (const [tname, tid] of teamIds) {
    const t = T.get(tid) || { sw: 0, streakW: 0 };
    const colour = [...d.drivers.values()].find((x) => x.team === tname)?.colour || '#888';
    const leaderTeam = running[0] && teamOf.get(running[0].n) === tname;
    const st = leaderTeam ? (finished ? ['done', 'Done'] : ['on', 'On course · leading']) : (finished ? ['miss', 'Missed'] : ['off', 'Needs the win']);
    const [R, holder, y] = rec.tsw;
    if (R && t.sw + 1 >= R) add({ n: null, code: tname, colour, group: 'Teams', kind: t.sw + 1 > R ? 'break' : 'equal', txt: `A win would be ${tname}'s <b>${nth(t.sw + 1)}</b> this year, ${t.sw + 1 > R ? 'beating' : 'equalling'} the record for wins in a season (${R}, ${teamName(H, holder)} in ${y}).`, st });
    const [RS, hs] = rec.tStreakW;
    if (RS && t.streakW >= 3 && t.streakW + 1 >= RS) add({ n: null, code: tname, colour, group: 'Teams', kind: hs === tid ? 'extend' : 'break', txt: `A win would be ${tname}'s <b>${t.streakW + 1} in a row</b>, ${t.streakW + 1 > RS ? 'beating' : 'equalling'} the record (${RS}, ${teamName(H, hs)}).`, st });
  }
  // the records themselves, for context
  const table = recordTable(rec, ptsRec, seasonPtsRec, SP);
  return { items, table, date, lastRace: H.races.filter((r) => r.date < date).at(-1) };
}

function recordTable(rec, ptsRec, seasonPtsRec, SP) {
  return [
    ['Most wins', rec.wins], ['Most podiums', rec.podiums], ['Most poles', rec.poles], ['Most starts', rec.starts],
    ['Most career points', ptsRec], ['Most wins in a season', rec.sw], ['Most points in a season', seasonPtsRec],
    ['Most consecutive wins', rec.streakW], ['Youngest winner', rec.yWin],
    ['Most sprint wins', SP.rec.wins], ['Most sprint podiums', SP.rec.podiums],
  ].map(([label, r]) => ({ label, v: r[0], holder: r[1], extra: r[2] }));
}

// a sprint session: sprint wins, podiums and streaks instead of Grand Prix records
function sprintRecords(H, ctx, ids, SP, posNow, finished, status, items, add, rec, ptsRec, seasonPtsRec) {
  const d = ctx.d;
  for (const drv of d.drivers.values()) {
    const id = ids.get(drv.num);
    const x = (id && SP.D.get(id)) || { wins: 0, podiums: 0, streakW: 0 };
    const base = { n: drv.num, code: drv.code, colour: drv.colour };
    const one = (key, label, k, noun) => {
      const [R, holder] = SP.rec[key];
      const v = x[key] + 1;
      if (!R || v < R) return false;
      const own = holder === id;
      add({ ...base, group: 'Sprint records', kind: own ? 'extend' : v > R ? 'break' : 'equal',
        txt: `${noun} would be his <b>${nth(v)}</b>, ${own ? 'extending his own record' : `${v > R ? 'breaking' : 'equalling'} ${whoFull(H, holder)}'s record`} for ${label} (${R}).`, st: status(drv.num, k) });
      return true;
    };
    const w = one('wins', 'most sprint wins', 1, 'A sprint win');
    one('podiums', 'most sprint podiums', 3, 'A sprint podium');
    const P = posNow.get(drv.num);
    if (!w && x.wins === 0 && P != null && P <= 3) add({ ...base, group: 'Milestones', kind: 'milestone', txt: '<b>First sprint win</b> if he takes it from here.', st: status(drv.num, 1) });
    if (!w && x.wins > 0 && (x.wins + 1) % 5 === 0) add({ ...base, group: 'Milestones', kind: 'milestone', txt: `A sprint win would be his <b>${nth(x.wins + 1)}</b>.`, st: status(drv.num, 1) });
  }
  return { items, table: recordTable(rec, ptsRec, seasonPtsRec, SP), date: ctx.d.raw.session.date_start.slice(0, 10), lastRace: H.races.filter((r) => r.date < ctx.d.raw.session.date_start.slice(0, 10)).at(-1) };
}

async function renderRecords() {
  const box = document.querySelector('#records-pane');
  const ctx = titleContext();
  if (!ctx) { box.innerHTML = '<p class="muted pad">Load a race to see records in play.</p>'; return; }
  const H = await loadHistory();
  if (!H) { box.innerHTML = '<p class="muted pad">The race history isn\'t downloaded yet (build_history.py is still running on the server). Try again in a few minutes.</p>'; return; }
  const { items, table, lastRace } = recordsInPlay(H, ctx);
  const order = ['on', 'done', 'off', 'miss'];
  const groups = ['Sprint records', 'All-time', `${ctx.year} season`, 'Streaks', 'Youngest ever', 'Teams', 'Milestones'];
  const kindTxt = { break: 'Record', equal: 'Equal record', extend: 'Extends record', milestone: 'Milestone' };
  const card = (it) => `<li class="rec ${it.st[0]}">
      <span class="chip" style="--c:${it.colour}">${esc(it.code)}</span>
      <span class="rec-txt"><span class="rec-kind ${it.kind}">${kindTxt[it.kind]}</span> ${it.txt}</span>
      <span class="rec-st">${esc(it.st[1])}</span></li>`;
  const body = groups.map((g) => {
    const list = items.filter((i) => i.group === g).sort((a, b) => order.indexOf(a.st[0]) - order.indexOf(b.st[0]));
    return list.length ? `<h4>${esc(g)}</h4><ul class="recs">${list.map(card).join('')}</ul>` : '';
  }).join('');
  const fmtR = (r) => {
    if (!r.holder) return '–';
    if (r.label === 'Youngest winner') return `${whoFull(H, r.holder)} · ${ageTxt(r.v)}`;
    return `${whoFull(H, r.holder)} · ${Math.round(r.v)}${r.extra && typeof r.extra !== 'object' ? ` (${r.extra})` : ''}`;
  };
  box.innerHTML = `<p class="title-where">${esc(ctx.here?.name || 'This race')} · ${ctx.running ? '<span class="live-tag">live: status from the current order</span>' : ctx.finished ? 'final result' : ''}</p>
    ${body || '<p class="muted">No records or milestones in reach in this race.</p>'}
    <h4>The records going into this race</h4>
    <div class="rec-table">${table.map((r) => `<div><span>${esc(r.label)}</span><b>${esc(fmtR(r))}</b></div>`).join('')}</div>
    <p class="title-foot">History: every Grand Prix since 1950 from the Jolpica F1 (Ergast) database, up to ${esc(lastRace ? `${lastRace.season} ${lastRace.name}` : '–')}${lastRace?.source === 'openf1' ? ' (the latest from OpenF1\'s official classification, until the database publishes it)' : ''}. Sprints are counted separately, as in the official statistics. Pole is credited to the driver who started at the front of the grid, as in the official statistics.</p>`;
}
