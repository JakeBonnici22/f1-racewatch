// Lobby: the landing page. What's live (or next) at the top, then every
// finished session as a replay, plus season pages: power units and cost cap.
// The race view opens only when a session is picked. URLs:
//   /                 lobby          /?session=K   replay of session K
//   /?live=1          live session   #power-units, #cost-cap   lobby tabs
'use strict';

const lobby = { tab: 'races', year: null, pu: null, puState: 'idle', timer: null };
const LOBBY_TABS = { races: '', pu: '#power-units', cap: '#cost-cap' };
const SES_SHORT = { 'Practice 1': 'FP1', 'Practice 2': 'FP2', 'Practice 3': 'FP3', 'Sprint Qualifying': 'Sprint Quali', 'Sprint Shootout': 'Sprint Quali' };

const inLobby = () => document.body.classList.contains('lobby-on');
const loadedKey = () => String(state.data?.raw?.session?.session_key ?? '');
const hasReplay = (key) => races.idx.some((s) => String(s.session_key) === String(key) && s.map !== false);

// ---------- switching between lobby and race view ----------
function showLobby(tab) {
  if (tab) lobby.tab = tab;
  if (typeof live !== 'undefined' && live.on) exitLive();
  setPlaying(false);
  document.body.classList.add('lobby-on');
  document.querySelector('#lobby').hidden = false;
  document.querySelector('#lobby').scrollTop = 0;
  renderLobby();
}
function showRace() {
  document.body.classList.remove('lobby-on');
  document.querySelector('#lobby').hidden = true;
  dispatchEvent(new Event('resize')); // canvases size themselves to the now-visible layout
}
function openReplay(key) {
  history.pushState(null, '', `?session=${key}`);
  showRace();
  races.current = String(key); renderRaceButton();
  if (loadedKey() !== String(key) || (typeof live !== 'undefined' && live.on)) loadSession(key);
}
async function openLive() {
  history.pushState(null, '', '?live=1');
  showRace();
  if (!(await enterLive())) { // the session ended in the meantime
    history.replaceState(null, '', location.pathname);
    showLobby();
  }
}
function toLobby(tab = lobby.tab) {
  history.pushState(null, '', location.pathname + (LOBBY_TABS[tab] || ''));
  showLobby(tab);
}
// what the address says decides what's on screen (first load and back/forward)
async function route() {
  const p = new URLSearchParams(location.search);
  if (p.has('live')) {
    showRace();
    if (await liveAutoStart()) return;
    history.replaceState(null, '', location.pathname);
  } else if (p.get('session') && hasReplay(p.get('session'))) {
    showRace();
    races.current = p.get('session'); renderRaceButton();
    if (loadedKey() !== p.get('session')) await loadSession(p.get('session'));
    return;
  }
  const tab = Object.keys(LOBBY_TABS).find((k) => LOBBY_TABS[k] && LOBBY_TABS[k] === location.hash) || 'races';
  showLobby(tab);
}
addEventListener('popstate', route);

// ---------- races tab ----------
function weekendOfSession(key) {
  return allWeekends().find((w) => w.sessions.some((s) => String(s.key) === String(key)));
}
function sesLabel(s) { return SES_SHORT[s.name] || s.name; }
const LB_WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const LB_WEEKDAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const lbWhen = (iso) => `${RACE_FMT.day.format(new Date(iso))}, ${RACE_FMT.time.format(new Date(iso))}`;
const lbDayTime = (iso) => `${LB_WEEKDAY.format(new Date(iso))} ${RACE_FMT.time.format(new Date(iso))}`;
// what a pit board would say: three letters for the event, short for the session
const BOARD_SES = { 'Practice 1': 'FP1', 'Practice 2': 'FP2', 'Practice 3': 'FP3', Qualifying: 'QUALI', 'Sprint Qualifying': 'SQ', 'Sprint Shootout': 'SQ', Sprint: 'SPRINT', Race: 'RACE' };
const evCode = (w, s) => (w?.country_code || (w?.location || s?.location || '').slice(0, 3)).toUpperCase();
function boardCount(ms) {
  if (ms <= 0) return 'NOW';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const p = (x) => String(x).padStart(2, '0');
  return d >= 1 ? `${d}D ${p(h)}H` : `${p(h)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
// "today", "tomorrow", "on Friday", or a date further out
function lbRelDay(iso) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(iso); b.setHours(0, 0, 0, 0);
  const k = Math.round((b - a) / 864e5);
  return k === 0 ? 'today' : k === 1 ? 'tomorrow' : k < 7 ? `on ${LB_WEEKDAY_LONG.format(new Date(iso))}` : `on ${RACE_FMT.day.format(new Date(iso))}`;
}

function heroBoard(top, mid, big, cls = '', attrs = '') {
  return `<div class="pitboard hero-pb" aria-hidden="true">
    <div class="hp-row"><span>${esc(top[0])}</span><span class="hp-dim">${esc(top[1])}</span></div>
    <div class="hp-row"><span>${esc(mid[0])}</span><span class="hp-dim">${esc(mid[1])}</span></div>
    <div class="hp-big ${cls}" ${attrs}>${esc(big)}</div>
  </div>`;
}

function heroLive(li) {
  const s = li.session, w = allWeekends().find((x) => x.meeting_key === s.meeting_key);
  const now = Date.now(), started = now >= Date.parse(s.date_start), ended = now > Date.parse(s.date_end);
  const state = li.mode === 'sim' ? 'is running as a simulation' : ended ? 'has just finished and is still live here'
    : started ? 'is on now' : 'starts soon, and live tracking is already open';
  const when = started ? `Started at ${RACE_FMT.time.format(new Date(s.date_start))}` : `Starts at ${RACE_FMT.time.format(new Date(s.date_start))}`;
  return `<section class="lb-hero is-live">
    ${heroBoard([evCode(w, s), BOARD_SES[s.session_name] || s.session_name], [LB_WEEKDAY.format(new Date(s.date_start)).toUpperCase(), RACE_FMT.time.format(new Date(s.date_start))], 'LIVE', 'live')}
    <div class="hero-copy">
      <h1>${esc(w?.name || s.location)}</h1>
      <p>${esc(s.session_name)} ${state}. ${when}, ends at ${RACE_FMT.time.format(new Date(s.date_end))} your time.</p>
      <button type="button" class="btn-live" data-act="live">Watch live</button>
      <p class="hero-note">Everything else on this page is a replay.</p>
    </div>
  </section>`;
}

function heroNext(n) {
  if (!n) {
    return `<section class="lb-hero">
      ${heroBoard(['SEASON', ''], ['OVER', ''], 'FIN')}
      <div class="hero-copy"><h1>That's the season</h1><p>Every race is below as a replay. The next live session shows up here once next year's calendar is out.</p></div>
    </section>`;
  }
  const { w, s } = n, ms = Date.parse(s.start) - Date.now();
  return `<section class="lb-hero">
    ${heroBoard([evCode(w), BOARD_SES[s.name] || s.name], [LB_WEEKDAY.format(new Date(s.start)).toUpperCase(), RACE_FMT.time.format(new Date(s.start))],
      boardCount(ms), 'count', `data-countdown="${s.start}" data-fmt="board"`)}
    <div class="hero-copy">
      <h1>${esc(w.name)}</h1>
      <p>${esc(s.name)} goes live here ${lbRelDay(s.start)} at ${RACE_FMT.time.format(new Date(s.start))} your time. The track map, timing and race calls open 30 minutes before the start.</p>
      <button type="button" class="btn-paint" data-act="cal" data-mk="${w.meeting_key}">Add the weekend to my calendar</button>
    </div>
  </section>`;
}

// the weekend that's on now (or next), as a line of sessions in order
function weekendStrip(w, li) {
  if (!w) return '';
  const now = Date.now();
  const state = (s) => (li?.live && String(li.session?.session_key) === String(s.key) ? 'live' : sessionState(s, now));
  const next = w.sessions.find((s) => state(s) === 'upcoming');
  const items = w.sessions.map((s) => {
    const st = state(s);
    const isLive = li?.live && String(li.session?.session_key) === String(s.key);
    let act = '';
    if (st === 'live') act = isLive ? '<button type="button" class="btn-live sm" data-act="live">Watch live</button>' : '<span class="wk-live">Live now</span>';
    else if (st === 'done') act = hasReplay(s.key) ? `<button type="button" class="link" data-replay="${s.key}">Watch the replay</button>` : '<span class="wk-st">No replay</span>';
    else if (st === 'cancelled') act = '<span class="wk-st">Cancelled</span>';
    else if (s === next) act = `<span class="wk-st" data-countdown="${s.start}">${countdown(Date.parse(s.start) - now)}</span>`;
    return `<li class="wk-s ${st}${s === next ? ' next' : ''}"><b>${esc(s.name)}</b><span class="wk-when">${lbDayTime(s.start)}</span>${act}</li>`;
  }).join('');
  return `<section class="wk"><h2 class="lb-h2">${esc(w.name)} weekend</h2><ol class="wk-line">${items}</ol></section>`;
}

// one row per round, like a results sheet
function replayRow(w) {
  const saved = w.sessions.filter((s) => hasReplay(s.key));
  const race = w.sessions.find((s) => s.name === 'Race');
  const main = saved.find((s) => s.name === 'Race');
  const extra = saved.filter((s) => s !== main);
  const pod = (w.podium || []).map((c, i) => `<span><em>${i + 1}</em>${esc(c)}</span>`).join('');
  return `<tr class="${main ? '' : 'no-race'}">
    <td class="rp-r">${w.round ? 'R' + w.round : ''}</td>
    <td class="rp-gp"><b>${esc(w.name)}</b><small>${esc(w.location)}, ${RACE_FMT.date.format(new Date(race?.start || w.start))}</small></td>
    <td class="rp-pod">${pod}</td>
    <td class="rp-act">${extra.map((s) => `<button type="button" class="link" data-replay="${s.key}">${esc(sesLabel(s))}</button>`).join('')}${main
      ? `<button type="button" class="btn-paint sm" data-replay="${main.key}">Watch the race</button>`
      : '<span class="wk-st">Race not downloaded yet</span>'}</td>
  </tr>`;
}

function renderLobbyRaces() {
  const li = window.liveInfo?.live && window.liveInfo.session ? window.liveInfo : null;
  const n = nextSession();
  const wkNow = li ? allWeekends().find((x) => x.meeting_key === li.session.meeting_key) : n?.w;
  const years = Object.keys(races.cal?.years || {}).sort().reverse();
  const y = lobby.year || years[0];
  const now = Date.now();
  const done = (races.cal?.years[y] || []).filter((w) => !w.cancelled && w.sessions.some((s) => s.name === 'Race' && Date.parse(s.end) < now))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  document.querySelector('#lobby-races').innerHTML = `
    <div class="hero-wrap">
      ${li ? heroLive(li) : heroNext(n)}
      <section class="lb-preview" aria-label="One lap of the latest race">
        <canvas id="pv-map"></canvas>
        <div class="pv-foot"><span id="pv-label">Latest race</span><button type="button" id="pv-watch" class="btn-quiet sm">Watch the replay</button></div>
      </section>
    </div>
    ${weekendStrip(wkNow, li)}
    <section class="rp">
      <div class="rp-head">
        <h2 class="lb-h2">Replays <span class="lb-sub-inline">Finished sessions, played back as they happened</span></h2>
        <div class="lb-years" role="tablist" aria-label="Season">${years.map((k) => `<button type="button" role="tab" data-year="${k}" class="${k === y ? 'on' : ''}" aria-selected="${k === y}">${k}</button>`).join('')}</div>
      </div>
      <table class="rp-sheet"><caption class="sr-only">Finished races in ${y}, newest first</caption><tbody>${done.map(replayRow).join('')}</tbody></table>
      ${done.length ? '' : '<p class="muted">No finished races this season yet.</p>'}
    </section>`;
  if (typeof startPreview === 'function') startPreview();
}

// ---------- power units tab ----------
const PU_SHORT = { ICE: 'ICE', TC: 'Turbo', EXH: 'Exhaust', 'MGU-K': 'MGU-K', ES: 'Battery', 'PU-CE': 'Control el.', 'PU-ANC': 'Ancillaries' };
const PU_PROSE = { ICE: 'engine (ICE)', TC: 'turbo', EXH: 'exhaust set', 'MGU-K': 'MGU-K', ES: 'battery (energy store)', 'PU-CE': 'control electronics unit', 'PU-ANC': 'ancillary set' };
const titleCase = (s) => String(s || '').replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase());

// what the next new element of each type would cost on the grid
function nextCost(used, limit) {
  if (used < limit) return 0;
  return used === limit ? 10 : 5;
}

function puCell(d, e, L) {
  const u = d.used[e], lim = L[e], over = Math.max(0, u - lim);
  const pips = Array.from({ length: Math.max(u, lim) }, (_, i) => `<i class="${i >= lim ? 'x' : i < u ? 'u' : ''}"></i>`).join('');
  const cost = nextCost(u, lim);
  const cls = over ? 'over' : u === lim ? 'full' : 'ok';
  const fresh = d.fresh?.includes(e);
  const tip = `${d.name || d.label}: ${u} of ${lim} ${lobby.pu.names[e]}${over ? ` (${over} over the limit)` : ''}. ${cost ? `Another new one costs ${cost} grid places.` : `${lim - u} more allowed without a penalty.`}${fresh ? ' New one fitted this weekend.' : ''}`;
  return `<td class="pu ${cls}${fresh ? ' fresh' : ''}" title="${esc(tip)}"><span class="pu-n">${u}</span><span class="pips">${pips}</span></td>`;
}

function renderPU() {
  const box = document.querySelector('#lobby-pu');
  const P = lobby.pu;
  if (!P) {
    box.innerHTML = `<section class="lb-intro"><h2>Power units</h2><p class="muted">${lobby.puState === 'error' ? 'The power unit data isn\'t available yet.' : 'Loading…'}</p></section>`;
    return;
  }
  const L = P.limits, O = P.order;
  const teams = new Map();
  for (const d of P.drivers) {
    const k = d.team || d.label || '?';
    if (!teams.has(k)) teams.set(k, []);
    teams.get(k).push(d);
  }
  // most over the limit first: that's where the penalties are
  const overOf = (d) => O.reduce((a, e) => a + Math.max(0, d.used[e] - L[e]), 0);
  const tlist = [...teams.entries()].sort((a, b) => b[1].reduce((s, d) => s + overOf(d), 0) - a[1].reduce((s, d) => s + overOf(d), 0));
  const rows = tlist.map(([team, ds]) => {
    const col = ds[0].colour ? `#${ds[0].colour}` : 'var(--fog)';
    const tOver = ds.reduce((s, d) => s + overOf(d), 0);
    return `<tr class="pu-team"><th colspan="${O.length + 2}" style="--c:${col}"><i class="cc-sw"></i>${esc(team)}<small>${tOver ? `${tOver} element${tOver > 1 ? 's' : ''} over the limit across its drivers` : 'Every driver within the allowance'}</small></th></tr>` +
      ds.map((d) => {
        const costs = O.map((e) => [e, nextCost(d.used[e], L[e])]).filter(([, c]) => c);
        const grp = (c) => costs.filter(([, x]) => x === c).map(([e]) => PU_SHORT[e]);
        const nextTxt = costs.length
          ? [10, 5].filter((c) => grp(c).length).map((c) => `<span class="pu-grp"><span class="pu-cost c${c}">+${c}</span>${grp(c).length === O.length ? 'any part' : grp(c).join(', ')}</span>`).join('')
          : '<span class="muted">None: a spare of every part left</span>';
        return `<tr><th scope="row"><span class="pu-drv" style="--c:${col}">${esc(d.acronym || d.n)}</span><small>${esc(titleCase(d.name || d.label || ''))}</small></th>${O.map((e) => puCell(d, e, L)).join('')}<td class="pu-next">${nextTxt}</td></tr>`;
      }).join('');
  }).join('');
  const pens = [...P.penalties].reverse();
  const ex = pens.find((p) => p.places && p.elements.length > 1) || pens[0];
  const example = ex ? `For example, at the ${esc(ex.event)} ${esc(ex.driver)} fitted ${ex.elements.map((x) => `a ${puOrd(x.nth)} ${esc(PU_PROSE[x.elem] || x.elem)}`).join(' and ')} with only ${ex.elements.map((x) => L[x.elem]).filter((v, i, a) => a.indexOf(v) === i).join(' or ')} allowed: <b>${esc(ex.decision.replace(/ (for|in) the next Race.*$/i, '').toLowerCase())}</b>.` : '';
  box.innerHTML = `
    <section class="lb-intro">
      <h2>Power units in ${P.season}</h2>
      <p>Every driver gets a fixed number of each engine part for the season. Going over costs grid places: <b>10 places</b> the first time a driver exceeds the allowance for a part, <b>5 places</b> for each one after that. ${example}</p>
      <div class="pu-limits">${O.map((e) => `<span title="${esc(P.names[e])}"><b>${L[e]}</b> ${esc(PU_SHORT[e])}</span>`).join('')}<em>allowed per driver, per season</em></div>
    </section>
    <div class="pu-legend"><span><i class="lg ok"></i>Within the allowance</span><span><i class="lg full"></i>At the limit: the next one costs 10 places</span><span><i class="lg over"></i>Over the limit</span><span><i class="lg fresh"></i>New part this weekend</span></div>
    <div class="cc-scroll"><table class="pu-table">
      <thead><tr><th>Driver</th>${O.map((e) => `<th title="${esc(P.names[e])}">${esc(PU_SHORT[e])}<small>max ${L[e]}</small></th>`).join('')}<th>Grid places for the next new part</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h3 class="lb-h3">Power unit grid penalties this season</h3>
    ${pens.length ? `<ol class="pu-pens">${pens.map((p) => `<li><span class="pp-ev">${esc(p.event.replace(' Grand Prix', ' GP'))}</span><b>${esc(p.driver)}</b><span class="pp-what">${p.elements.map((x) => `${puOrd(x.nth)} ${esc(PU_PROSE[x.elem] || x.elem)}`).join(', ') || 'power unit elements'}</span><span class="pp-dec">${esc(p.decision.replace(/ (for|in) the next Race in which the driver participates\.?/i, ''))}</span><a href="${p.doc}" target="_blank" rel="noopener" title="Stewards' decision (PDF)">FIA ↗</a></li>`).join('')}</ol>` : '<p class="muted">None so far.</p>'}
    <p class="lb-foot">Counts after the ${esc(P.latest_event || '')}, from the FIA Technical Delegate's reports and the stewards' decisions (fia.com). Updated ${esc(new Date(P.built).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}.</p>`;
}
function puOrd(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

async function loadPU() {
  if (lobby.puState === 'loading' || lobby.puState === 'ok') return;
  lobby.puState = 'loading';
  try {
    const r = await fetch('data/pu.json', { cache: 'no-store' });
    lobby.pu = r.ok ? await r.json() : null;
    lobby.puState = lobby.pu ? 'ok' : 'error';
  } catch { lobby.puState = 'error'; }
  if (lobby.tab === 'pu') renderPU();
}

// ---------- shell ----------
function renderLobby() {
  document.querySelectorAll('#lobby-tabs [data-tab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === lobby.tab);
    b.setAttribute('aria-selected', b.dataset.tab === lobby.tab);
  });
  for (const t of Object.keys(LOBBY_TABS)) document.querySelector(`#lobby-${t}`).hidden = t !== lobby.tab;
  if (lobby.tab === 'races') renderLobbyRaces();
  else if (lobby.tab === 'pu') { renderPU(); loadPU(); }
  else renderCostCap();
}

(function wireLobby() {
  const box = document.querySelector('#lobby');
  box.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t && t.closest('#lobby-tabs')) { lobby.tab = t.dataset.tab; history.replaceState(null, '', location.pathname + LOBBY_TABS[lobby.tab]); renderLobby(); return; }
    const yb = e.target.closest('[data-year]');
    if (yb) { lobby.year = yb.dataset.year; renderLobbyRaces(); return; }
    const rp = e.target.closest('[data-replay]');
    if (rp) { if (rp.dataset.replay) openReplay(rp.dataset.replay); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'live') { openLive(); return; }
    if (act === 'cal') {
      const w = allWeekends().find((x) => String(x.meeting_key) === e.target.closest('[data-mk]').dataset.mk);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([icsFor(w)], { type: 'text/calendar' })),
        download: `${w.name.replace(/\s+/g, '-')}-${w.year}.ics`,
      });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });
  document.querySelector('#home-btn').addEventListener('click', (e) => { e.preventDefault(); toLobby('races'); });
  // countdowns tick every second; the whole races tab refreshes when the live status changes
  let lastLive = null;
  setInterval(() => {
    if (!inLobby()) return;
    box.querySelectorAll('[data-countdown]').forEach((b) => {
      const ms = Date.parse(b.dataset.countdown) - Date.now();
      b.textContent = b.dataset.fmt === 'board' ? boardCount(ms) : ms > 0 ? countdown(ms) : 'starting';
    });
    const nowLive = !!window.liveInfo?.live;
    if (lobby.tab === 'races' && nowLive !== lastLive) { lastLive = nowLive; renderLobbyRaces(); }
  }, 1000);
})();
