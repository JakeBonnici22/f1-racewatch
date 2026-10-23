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
const lbWhen = (iso) => `${RACE_FMT.day.format(new Date(iso))} · ${RACE_FMT.time.format(new Date(iso))}`;

function heroLive(li) {
  const s = li.session, w = allWeekends().find((x) => x.meeting_key === s.meeting_key);
  const now = Date.now(), started = now >= Date.parse(s.date_start), ended = now > Date.parse(s.date_end);
  const kicker = li.mode === 'sim' ? 'Simulated live' : ended ? 'Just finished · still live' : started ? 'Live now' : 'Starting soon · live tracking open';
  return `<section class="hero is-live">
    <div class="hero-main">
      <span class="hero-kicker"><span class="dot"></span>${kicker}</span>
      <h2>${esc(w?.name || s.location)}</h2>
      <p class="hero-ses">${esc(s.session_name)} · ${esc(w?.circuit || s.location)}</p>
      <p class="hero-when">${started ? `Started ${RACE_FMT.time.format(new Date(s.date_start))}` : `Starts ${lbWhen(s.date_start)}`} · ends ${RACE_FMT.time.format(new Date(s.date_end))} your time</p>
    </div>
    <div class="hero-act">
      <button type="button" class="primary big" data-act="live">Watch live</button>
      <small>Everything else on this page is a replay.</small>
    </div>
  </section>`;
}

function heroNext(n) {
  if (!n) return `<section class="hero"><div class="hero-main"><span class="hero-kicker">Next live session</span><h2>Season over</h2><p class="hero-ses">Replays of every race are below.</p></div></section>`;
  const { w, s } = n;
  return `<section class="hero">
    <div class="hero-main">
      <span class="hero-kicker">Next live session</span>
      <h2>${esc(w.name)}</h2>
      <p class="hero-ses">${esc(s.name)} · ${esc(w.circuit || w.location)}</p>
      <p class="hero-when">${lbWhen(s.start)} your time</p>
    </div>
    <div class="hero-act">
      <b class="hero-count" data-countdown="${s.start}">${countdown(Date.parse(s.start) - Date.now())}</b>
      <small>Watch live opens here 30 minutes before the start.</small>
      <button type="button" data-act="cal" data-mk="${w.meeting_key}">Add the weekend to my calendar</button>
    </div>
  </section>`;
}

// the weekend that's on now (or next): each session as live / replay / upcoming
function weekendStrip(w, li) {
  if (!w) return '';
  const now = Date.now();
  const items = w.sessions.map((s) => {
    const isLive = li?.live && String(li.session?.session_key) === String(s.key);
    const st = isLive ? 'live' : sessionState(s, now);
    let act;
    if (st === 'live') act = isLive ? '<button type="button" class="tag tag-live" data-act="live"><span class="dot"></span>Watch live</button>' : '<span class="tag tag-live"><span class="dot"></span>Live</span>';
    else if (st === 'done') act = hasReplay(s.key) ? `<button type="button" class="tag tag-replay" data-replay="${s.key}">▶ Replay</button>` : '<span class="tag">No replay</span>';
    else if (st === 'cancelled') act = '<span class="tag">Cancelled</span>';
    else act = `<span class="tag tag-up" data-countdown="${s.start}">${countdown(Date.parse(s.start) - now)}</span>`;
    return `<li class="wk-ses ${st}"><span class="wk-name">${esc(sesLabel(s))}</span><span class="wk-when">${lbWhen(s.start)}</span>${act}</li>`;
  }).join('');
  return `<section class="wk"><h3 class="lb-h3">${esc(w.name)} weekend</h3><ol class="wk-list">${items}</ol></section>`;
}

function replayCard(w) {
  const saved = w.sessions.filter((s) => hasReplay(s.key));
  const race = w.sessions.find((s) => s.name === 'Race');
  const pod = w.podium ? `<ol class="podium">${w.podium.map((c, i) => `<li><span>P${i + 1}</span>${esc(c)}</li>`).join('')}</ol>` : '';
  const main = saved.find((s) => s.name === 'Race');
  const extra = saved.filter((s) => s !== main);
  return `<article class="rp-card ${main ? '' : 'no-race'}">
    <header>
      <span class="rc-round">${w.round ? 'R' + w.round : '–'}</span>
      <span class="rc-main"><b>${esc(w.name)}</b><small>${esc(w.location)} · ${RACE_FMT.date.format(new Date(race?.start || w.start))}</small></span>
      <span class="tag tag-replay-static">Replay</span>
    </header>
    ${pod}
    <div class="rp-btns">
      ${main ? `<button type="button" class="rp-main" data-replay="${main.key}">▶ Watch the race</button>` : '<span class="muted small">Race not downloaded yet</span>'}
      ${extra.map((s) => `<button type="button" data-replay="${s.key}">${esc(sesLabel(s))}</button>`).join('')}
    </div>
  </article>`;
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
    ${li ? heroLive(li) : heroNext(n)}
    ${weekendStrip(wkNow, li)}
    <section class="rp">
      <div class="rp-head">
        <h3 class="lb-h3">Replays <span class="lb-sub-inline">finished sessions, played back as they happened</span></h3>
        <div class="side-tabs lb-years" role="tablist">${years.map((k) => `<button type="button" role="tab" data-year="${k}" class="${k === y ? 'on' : ''}" aria-selected="${k === y}">${k}</button>`).join('')}</div>
      </div>
      <div class="rp-grid">${done.map(replayCard).join('') || '<p class="muted">No finished races this season yet.</p>'}</div>
    </section>`;
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
      <h2>Power units · ${P.season}</h2>
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
    if (rp) { openReplay(rp.dataset.replay); return; }
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
      b.textContent = ms > 0 ? countdown(ms) : 'starting';
    });
    const nowLive = !!window.liveInfo?.live;
    if (lobby.tab === 'races' && nowLive !== lastLive) { lastLive = nowLive; renderLobbyRaces(); }
  }, 1000);
})();
