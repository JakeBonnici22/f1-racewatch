// Title maths: who can still win the championship, what the leader needs to
// clinch it at the next weekend, and when each driver dropped out of it.
// Everything is computed "as it stands" at the moment you're watching: during
// a race the current running order counts as the result.
'use strict';

const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];
const EVENT_MAX = { d: { race: 25, sprint: 8 }, t: { race: 43, sprint: 15 } }; // a team can score 1st + 2nd

function weekendRaceStart(w) { return w.sessions.find((s) => s.name === 'Race')?.start || w.start; }

// the race being viewed, its season's weekends, and what's left after it
function titleContext() {
  const d = state.data;
  if (!d || !state.lastBoard || typeof races === 'undefined' || !races.cal) return null;
  const s = d.raw.session;
  const year = s.year ?? Number(s.date_start.slice(0, 4));
  const season = (races.cal.years[String(year)] || []).filter((w) => !w.cancelled && w.race_key);
  const here = season.find((w) => String(w.race_key) === String(s.session_key)) || season.find((w) => w.meeting_key === s.meeting_key);
  const at = Date.parse(s.date_start);
  const left = season.filter((w) => Date.parse(weekendRaceStart(w)) > at)
    .map((w) => ({ w, sprint: w.sessions.some((x) => x.name === 'Sprint' && !x.cancelled) }));
  const done = season.filter((w) => Date.parse(weekendRaceStart(w)) < at);
  const st = liveStandings(d, state.lastBoard);
  if (!st) return null;
  const running = statusAt(state.t) !== 'FINISH';
  return { d, year, here, left, done, st, running, finished: !running };
}

const maxLeft = (left, kind) => left.reduce((a, e) => a + EVENT_MAX[kind].race + (e.sprint ? EVENT_MAX[kind].sprint : 0), 0);
const eventMax = (e, kind) => EVENT_MAX[kind].race + (e.sprint ? EVENT_MAX[kind].sprint : 0);
const shortGP = (w) => w.name.replace(' Grand Prix', ' GP');

// Grand Prix wins so far (sprints don't count for the tie-break): finished
// weekends from the calendar, plus this race if it's won / as it stands
function winsSoFar(ctx, kind) {
  const wins = new Map();
  const teamOf = new Map();
  for (const w of ctx.done) for (const r of w.after?.drivers || []) teamOf.set(r.code, r.team);
  for (const r of ctx.st.drivers) teamOf.set(r.drv.code, r.drv.team);
  const bump = (code) => {
    const k = kind === 'd' ? code : teamOf.get(code);
    if (k != null) wins.set(k, (wins.get(k) || 0) + 1);
  };
  for (const w of ctx.done) if (w.podium?.[0]) bump(w.podium[0]);
  const leaderNow = (state.lastBoard || []).find((r) => !r.out);
  if (leaderNow && statusAt(state.t) !== 'PRE') bump(leaderNow.drv.code);
  return wins;
}

// one table for drivers or teams: rows sorted by points, with status
function titleTable(ctx, kind) {
  const rows = kind === 'd'
    ? ctx.st.drivers.map((r) => ({ id: r.n, label: r.drv.code, sub: r.drv.name, colour: r.drv.colour, pts: r.pts }))
    : ctx.st.teams.map((r) => ({ id: r.name, label: r.name, sub: '', colour: r.colour, pts: r.pts }));
  const wins = winsSoFar(ctx, kind);
  for (const r of rows) r.wins = wins.get(kind === 'd' ? r.label : r.id) || 0;
  rows.sort((a, b) => b.pts - a.pts || b.wins - a.wins);
  const M = maxLeft(ctx.left, kind);
  const races = ctx.left.length;
  const leader = rows[0];
  for (const r of rows) {
    r.max = r.pts + M;
    r.behind = leader.pts - r.pts;
    // level on points at the end only happens if r wins every race left and the
    // leader scores nothing - then r's wins decide it (most wins takes the title)
    r.alive = r === leader || r.max > leader.pts || (r.max === leader.pts && r.wins + races >= leader.wins);
    r.tieOnly = r !== leader && r.max === leader.pts;
  }
  const second = rows[1];
  const clinched = second && rows.slice(1).every((r) => !r.alive);
  return { rows, M, leader, clinched, kind, races };
}

// the weekend after each completed race when a driver/team could no longer catch the leader
function outSince(ctx, kind) {
  const out = new Map();
  ctx.done.forEach((w, i) => {
    const a = w.after;
    if (!a) return;
    const list = kind === 'd' ? a.drivers.map((r) => ({ id: r.n, pts: r.pts })) : a.teams.map((r) => ({ id: r.team, pts: r.pts }));
    if (!list.length) return;
    const lead = Math.max(...list.map((r) => r.pts));
    // max still available after this weekend = the rest of the done ones + this race + everything left
    const rest = ctx.done.slice(i + 1).concat(ctx.here ? [ctx.here] : []).map((x) => ({ sprint: x.sessions.some((s) => s.name === 'Sprint' && !s.cancelled) }));
    const M = maxLeft(rest, kind) + maxLeft(ctx.left, kind);
    for (const r of list) if (!out.has(r.id) && r.pts + M < lead) out.set(r.id, w);
  });
  return out;
}

// what the next weekend can decide: per rival, the points swing that settles it
function nextWeekend(ctx, tab) {
  const next = ctx.left[0];
  if (!next) return null;
  const E = eventMax(next, tab.kind);
  const Mafter = tab.M - E;
  const L = tab.leader;
  const rivals = tab.rows.slice(1).filter((r) => r.alive).map((r) => {
    const lead = L.pts - r.pts;
    const need = Mafter - lead + 1; // leader must outscore r by this much to rule r out
    return { r, need, survive: 1 - need };
  });
  const canClinch = rivals.length && rivals.every((x) => x.need <= E);
  // earliest weekend the leader could possibly seal it (wins everything, P2 scores nothing)
  let earliest = null;
  const p2 = tab.rows[1];
  if (p2 && !tab.clinched) {
    let lead = L.pts - p2.pts, left = tab.M;
    for (const e of ctx.left) {
      const m = eventMax(e, tab.kind);
      lead += m; left -= m;
      if (lead > left) { earliest = e.w; break; }
    }
  }
  return { next, E, Mafter, rivals, canClinch, earliest };
}

// sprint weekend: a few ways the leader's weekend could go, and what the rival
// must be held to across the sprint and the race
function sprintCombos(need) {
  const R = (p) => RACE_POINTS[p - 1] ?? 0, S = (p) => SPRINT_POINTS[p - 1] ?? 0;
  const outcomes = [[1, 1], [1, 2], [2, 1], [1, 4], [2, 2], [3, 3], [2, 5]];
  const out = [];
  for (const [rp, sp] of outcomes) {
    const a = R(rp) + S(sp), allow = a - need;
    if (allow < 0) continue;
    // an example for the rival: best race finish whose points fit, then the sprint
    let q = 1;
    while (q <= 21 && (R(q) > allow || q === rp)) q++;
    const left = allow - R(q);
    let qs = 1;
    while (qs <= 21 && (S(qs) > left || qs === sp)) qs++;
    out.push({ rp, sp, a, allow, q, qs });
    if (out.length >= 5) break;
  }
  return out;
}

// race-only weekend: every finishing position for the leader and how low the rival must finish
function clinchCombos(need) {
  const pts = (p) => RACE_POINTS[p - 1] ?? 0;
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const allow = pts(p) - need; // the rival may score at most this
    if (allow < 0) break;
    let q = 1;
    while (q <= 21 && (pts(q) > allow || q === p)) q++;
    out.push({ p, q });
  }
  return out;
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const posTxt = (q) => (q >= 11 ? 'out of the points' : `${ordinal(q)} or lower`);

function renderTitleKind(ctx, kind) {
  const tab = titleTable(ctx, kind);
  const outs = outSince(ctx, kind);
  const nw = nextWeekend(ctx, tab);
  const L = tab.leader;
  const noun = kind === 'd' ? 'drivers' : 'teams';
  const name = (r) => (kind === 'd' ? r.label : r.label.replace(' Racing', '').replace(' F1 Team', ''));
  const asIs = ctx.running ? 'if the race finished in the current order' : `after the ${ctx.here ? shortGP(ctx.here) : 'race'}`;
  const nLeft = ctx.left.length, nSprint = ctx.left.filter((e) => e.sprint).length;

  // headline
  let head;
  if (!nLeft) head = `<b>${esc(name(L))}</b> ${ctx.running ? 'is on course to be' : 'is'} champion.`;
  else if (tab.clinched) head = `<b>${esc(name(L))}</b> ${ctx.running ? 'would clinch' : 'has clinched'} the title: a ${tab.rows[0].pts - tab.rows[1].pts}-point lead with only ${tab.M} left.`;
  else {
    const alive = tab.rows.filter((r) => r.alive);
    head = `<b>${alive.length}</b> ${noun} can still win it ${asIs}. ${tab.M} points are left: ${nLeft} race${nLeft > 1 ? 's' : ''}${nSprint ? ` and ${nSprint} sprint${nSprint > 1 ? 's' : ''}` : ''}.`;
  }

  // bars: points now + the most each could still add; the line is the leader's total today
  const shown = tab.rows.filter((r, i) => r.alive || i < 8).slice(0, Math.max(8, tab.rows.filter((r) => r.alive).length));
  const scale = Math.max(...shown.map((r) => r.max), 1);
  const lx = (L.pts / scale) * 100;
  const bars = shown.map((r) => {
    const w0 = (r.pts / scale) * 100, w1 = (tab.M / scale) * 100;
    const o = outs.get(r.id);
    const state = r === L ? (tab.clinched ? 'Champion' : `Leader · ${r.wins} win${r.wins === 1 ? '' : 's'}`)
      : r.alive ? (r.tieOnly ? `Only a tie: needs every win left (${r.wins} + ${tab.races} vs ${L.wins})` : `${r.behind} behind`)
        : o ? `Out since ${shortGP(o)}` : r.max === L.pts ? `Out on countback (${r.wins + tab.races} wins max vs ${L.wins})` : ctx.running ? 'Out if it ends like this' : 'Out after this race';
    return `<div class="tb-row ${r.alive ? '' : 'out'}" title="${esc(r.sub || r.label)}: ${r.pts} pts now, ${r.max} at most">
      <span class="tb-name">${esc(name(r))}</span>
      <span class="tb-track"><i class="now" style="width:${w0}%;--c:${r.colour}"></i><i class="max" style="left:${w0}%;width:${w1}%;--c:${r.colour}"></i></span>
      <span class="tb-pts">${r.pts}</span>
      <span class="tb-state">${state}</span>
    </div>`;
  }).join('');

  // next weekend
  let nextHtml = '';
  if (nw && !tab.clinched) {
    const nm = shortGP(nw.next.w);
    const items = nw.rivals.map(({ r, need, survive }) => {
      let txt;
      if (survive > nw.E) txt = `<b>Out after ${esc(nm)}</b> whatever happens: ${tab.M - nw.E} points will be left and ${kind === 'd' ? "he's" : "they're"} ${r.behind} behind.`;
      else if (survive > 0) txt = `Must outscore ${esc(name(L))} by <b>${survive}+</b> in ${esc(nm)} to stay alive.`;
      else if (need <= nw.E) txt = `Out after ${esc(nm)} if ${esc(name(L))} outscores ${kind === 'd' ? 'him' : 'them'} by <b>${need}+</b>.`;
      else txt = `Safe through ${esc(nm)}: can't be ruled out there.`;
      return `<li><span class="chip" style="--c:${r.colour}">${esc(name(r))}</span><span>${txt}</span></li>`;
    }).join('');
    let clinch = '';
    if (nw.canClinch) {
      const p2 = nw.rivals[0];
      const others = nw.rivals.slice(1).filter((x) => x.need > 0);
      const combos = kind === 'd' && !nw.next.sprint ? clinchCombos(p2.need) : [];
      const sCombos = kind === 'd' && nw.next.sprint ? sprintCombos(p2.need) : [];
      const sTxt = (q, qs) => `${q >= 11 ? 'out of the points in the race' : `${ordinal(q)} or lower in the race`}${qs >= 9 ? ' and out of the sprint points' : ` and ${ordinal(qs)} or lower in the sprint`}`;
      clinch = `<div class="clinch"><b>${esc(name(L))} can clinch it in ${esc(nm)}</b> by outscoring ${esc(name(p2.r))} by ${p2.need}+${others.length ? ` and ${others.map((x) => `${esc(name(x.r))} by ${x.need}+`).join(', ')}` : ''}${nw.next.sprint ? ' over the sprint and the race' : ''}.
        ${combos.length ? `<ul class="combos">${combos.map((c) => `<li>${esc(name(L))} ${c.p === 1 ? 'wins' : `finishes ${ordinal(c.p)}`} → ${esc(name(p2.r))} ${posTxt(c.q)}</li>`).join('')}</ul>` : ''}
        ${sCombos.length ? `<ul class="combos wide">${sCombos.map((c) => `<li>${esc(name(L))} ${ordinal(c.rp)} in the race, ${ordinal(c.sp)} in the sprint (${c.a} pts) → ${esc(name(p2.r))} scores ${c.allow} or fewer, e.g. ${sTxt(c.q, c.qs)}</li>`).join('')}</ul>` : ''}</div>`;
    } else if (nw.earliest) {
      clinch = `<div class="clinch muted">Can't be decided in ${esc(nm)}. Earliest possible: <b>${esc(shortGP(nw.earliest))}</b>, if ${esc(name(L))} wins everything until then and ${esc(name(tab.rows[1]))} scores nothing.</div>`;
    }
    nextHtml = `<h4>Next: ${esc(nw.next.w.name)}${nw.next.sprint ? ' (sprint weekend)' : ''} · ${nw.E} points up for grabs per ${kind === 'd' ? 'driver' : 'team'}</h4>${clinch}<ul class="rivals">${items}</ul>`;
  }

  return `<section class="title-kind">
    <h3>${kind === 'd' ? "Drivers' championship" : "Constructors' championship"}</h3>
    <p class="title-head">${head}</p>
    <div class="tb-legend"><span><i class="k-now"></i>Points ${asIs}</span><span><i class="k-max"></i>Most they can still add (${tab.M})</span><span><i class="k-line"></i>${esc(name(L))}'s total today</span></div>
    <div class="tb" style="--lx:${lx}%">${bars}<span class="tb-line" style="left:calc(var(--name-w) + (100% - var(--name-w) - var(--tail-w)) * ${lx / 100})"></span></div>
    ${nextHtml}
  </section>`;
}

function renderTitle() {
  const box = document.querySelector('#title-pane');
  const ctx = titleContext();
  if (!ctx) { box.innerHTML = '<p class="muted pad">Load a race to see the title maths.</p>'; return; }
  if (!ctx.d.raw.championship_drivers?.length) { box.innerHTML = '<p class="muted pad">No championship data for this session.</p>'; return; }
  const where = ctx.here ? `${ctx.year} season · ${ctx.running ? 'during' : 'after'} Round ${ctx.here.round}, ${ctx.here.name}` : `${ctx.year} season`;
  box.innerHTML = `<p class="title-where">${esc(where)}${ctx.running ? ' · <span class="live-tag">as it stands</span>' : ''}</p>
    ${renderTitleKind(ctx, 'd')}${renderTitleKind(ctx, 't')}
    <p class="title-foot">Points: 25-18-15-12-10-8-6-4-2-1 for a race, 8 down to 1 for a sprint, no fastest-lap point. A tie on points goes to the most Grand Prix wins (sprints don't count), so someone who can only draw level is alive only if winning every race left would give them more wins than the leader.</p>`;
}
