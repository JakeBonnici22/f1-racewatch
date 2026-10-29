// Race picker: official race names, an archive of past seasons, and the next
// live session with a countdown. Reads data/calendar.json (build_calendar.py)
// and data/index.json (which races are downloaded, and which have the map).
'use strict';

const races = { cal: null, idx: [], current: null, open: null, year: null };
const RACE_FMT = {
  day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
  date: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
  time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }),
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function allWeekends() {
  if (!races.cal) return [];
  return Object.entries(races.cal.years).flatMap(([y, rows]) => rows.map((r) => ({ ...r, year: Number(y) })));
}
const weekendFor = (key) => allWeekends().find((w) => String(w.race_key) === String(key));
const idxFor = (key) => races.idx.find((s) => String(s.session_key) === String(key));

// the next session that hasn't finished (practice, quali, sprint or race)
function nextSession(now = Date.now()) {
  let best = null;
  for (const w of allWeekends()) {
    if (w.cancelled) continue;
    for (const s of w.sessions) {
      if (s.cancelled || Date.parse(s.end) < now) continue;
      if (!best || Date.parse(s.start) < Date.parse(best.s.start)) best = { w, s };
    }
  }
  return best;
}
function nextRace(now = Date.now()) {
  return allWeekends().filter((w) => !w.cancelled && w.race_key)
    .map((w) => ({ w, s: w.sessions.find((s) => s.name === 'Race') }))
    .filter((x) => x.s && Date.parse(x.s.end) >= now)
    .sort((a, b) => Date.parse(a.s.start) - Date.parse(b.s.start))[0] || null;
}

function countdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d >= 2) return `in ${d} days`;
  if (d === 1) return `in 1 day ${h}h`;
  if (h) return `in ${h}h ${String(mm).padStart(2, '0')}m`;
  const s = Math.floor(ms / 1000) % 60;
  return `in ${mm}m ${String(s).padStart(2, '0')}s`;
}
const sessionState = (s, now = Date.now()) => s.cancelled ? 'cancelled'
  : now >= Date.parse(s.end) ? 'done' : now >= Date.parse(s.start) ? 'live' : 'upcoming';
const short = (name) => name.replace(' Grand Prix', ' GP');

// ---------- top bar ----------
function renderRaceButton() {
  let w = weekendFor(races.current);
  const ix = idxFor(races.current);
  // a live practice / qualifying / sprint session: name the weekend and the session
  const li = window.liveInfo?.session;
  let sub = '';
  if (!w && li && String(li.session_key) === String(races.current)) {
    w = allWeekends().find((x) => x.meeting_key === li.meeting_key);
    sub = li.session_name;
  }
  const btn = document.querySelector('#race-btn');
  btn.innerHTML = w
    ? `<span class="rb-round">${w.round ? 'R' + w.round : ''}</span>
       <span class="rb-text"><b>${esc(w.name)}</b><small>${sub ? `${esc(sub)}, ` : ''}${esc(w.location)}, ${RACE_FMT.date.format(new Date(w.sessions.find((s) => s.name === (sub || 'Race'))?.start || w.start))}</small></span>
       <span class="rb-chev" aria-hidden="true">▾</span>`
    : `<span class="rb-text"><b>${esc(ix?.label || 'Choose a race')}</b></span><span class="rb-chev" aria-hidden="true">▾</span>`;
  btn.title = w?.official ? `${w.official}\nClick for the race archive and upcoming sessions` : 'Race archive and upcoming sessions';
}

function renderNextPill() {
  const pill = document.querySelector('#next-pill');
  const li = window.liveInfo;
  if (li?.live && li.session) { // the server is following a session right now
    const w = allWeekends().find((x) => x.meeting_key === li.session.meeting_key);
    const on = typeof live !== 'undefined' && live.on;
    pill.hidden = false;
    pill.classList.add('live');
    pill.dataset.action = on ? '' : 'tune-in';
    pill.innerHTML = `<span class="dot"></span>${li.mode === 'sim' ? 'Simulated live' : 'Live now'}: ${esc(short(w?.name || li.session.location))} ${esc(li.session.session_name)}${on ? '' : ' <b>Tune in</b>'}`;
    return;
  }
  delete pill.dataset.action;
  const n = nextSession();
  if (!n) { pill.hidden = true; return; }
  const st = sessionState(n.s);
  pill.hidden = false;
  pill.classList.toggle('live', st === 'live');
  pill.innerHTML = st === 'live'
    ? `<span class="dot"></span>Live now: ${esc(short(n.w.name))} ${esc(n.s.name)}`
    : `<span class="np-lbl">Next</span>${esc(short(n.w.name))} ${esc(n.s.name)} <b>${countdown(Date.parse(n.s.start) - Date.now())}</b>`;
}

// ---------- archive ----------
function icsFor(w) {
  const z = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ev = w.sessions.filter((s) => !s.cancelled).map((s) => [
    'BEGIN:VEVENT', `UID:racewatch-${s.key}@local`, `DTSTAMP:${z(new Date().toISOString())}`,
    `DTSTART:${z(s.start)}`, `DTEND:${z(s.end)}`,
    `SUMMARY:${w.name} – ${s.name}`, `LOCATION:${w.circuit || w.location}`,
    `DESCRIPTION:${w.official || ''}`,
    ...(s.name === 'Race' ? ['BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${w.name} starts in 30 minutes`, 'END:VALARM'] : []),
    'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Race Watch//EN', ...ev, 'END:VCALENDAR'].join('\r\n');
}

function nextCard() {
  const nr = nextRace();
  if (!nr) return '';
  const { w, s: race } = nr, now = Date.now();
  const live = w.sessions.find((s) => sessionState(s, now) === 'live');
  const ses = w.sessions.map((s) => {
    const st = sessionState(s, now);
    return `<li class="ses ${st} ${s.name === 'Race' ? 'is-race' : ''}">
      <span class="ses-name">${esc(s.name)}</span>
      <span class="ses-when">${RACE_FMT.day.format(new Date(s.start))}, ${RACE_FMT.time.format(new Date(s.start))}</span>
      <span class="ses-st">${st === 'live' ? '<span class="dot"></span>Live' : st === 'done' ? 'Done' : st === 'cancelled' ? 'Cancelled' : countdown(Date.parse(s.start) - now)}</span></li>`;
  }).join('');
  const raceLive = sessionState(race, now) === 'live';
  return `<section class="next-card ${live ? 'is-live' : ''}">
    <div class="nc-head">
      <div>
        <span class="nc-kicker">${raceLive ? '<span class="dot"></span>Race live now' : live ? `<span class="dot"></span>${esc(live.name)} live now` : 'Next race'}, round ${w.round}</span>
        <h3>${esc(w.name)}</h3>
        <p class="official">${esc(w.official)}</p>
        <p class="nc-where">${esc(w.circuit || w.location)}, ${esc(w.country)}</p>
      </div>
      <div class="nc-count">
        <span>Lights out</span>
        <b data-countdown="${race.start}">${raceLive ? 'Racing now' : countdown(Date.parse(race.start) - now)}</b>
        <small>${RACE_FMT.day.format(new Date(race.start))}, ${RACE_FMT.time.format(new Date(race.start))} your time</small>
      </div>
    </div>
    <ol class="ses-list">${ses}</ol>
    <div class="nc-actions">
      <button type="button" class="primary" id="tune-in" ${live || window.liveInfo?.live ? '' : 'disabled'}>${live || window.liveInfo?.live ? 'Tune in' : 'Tune in opens 30 min before the session'}</button>
      <button type="button" id="add-cal" data-mk="${w.meeting_key}">Add weekend to calendar</button>
    </div>
    <p class="nc-note" id="tune-note" hidden></p>
  </section>`;
}

function raceCard(w) {
  const now = Date.now();
  const race = w.sessions.find((s) => s.name === 'Race');
  const ix = idxFor(w.race_key);
  const isCur = String(w.race_key) === String(races.current);
  let state, action;
  if (w.cancelled) { state = 'cancelled'; action = '<span class="rc-st">Cancelled</span>'; }
  else if (!race || Date.parse(race.end) > now) {
    state = race && sessionState(race, now) === 'live' ? 'live' : 'upcoming';
    action = `<span class="rc-st">${state === 'live' ? '<span class="dot"></span>Live now' : race ? countdown(Date.parse(race.start) - now) : 'Upcoming'}</span>`;
  } else if (isCur) { state = 'current'; action = '<span class="rc-st">Watching</span>'; }
  else if (ix && ix.map !== false) { state = 'ready'; action = '<span class="rc-st go">Watch replay</span>'; }
  else if (ix) { state = 'nomap'; action = '<span class="rc-st">Map not downloaded yet</span>'; }
  else { state = 'missing'; action = '<span class="rc-st">Not downloaded yet</span>'; }
  const when = race ? RACE_FMT.date.format(new Date(race.start)) : RACE_FMT.date.format(new Date(w.start));
  const pod = w.podium ? `<ol class="podium">${w.podium.map((c, i) => `<li><span>P${i + 1}</span>${esc(c)}</li>`).join('')}</ol>` : '';
  const tag = state === 'ready' ? 'button' : 'div';
  return `<${tag} class="race-card ${state}" ${state === 'ready' ? `data-key="${w.race_key}" type="button"` : ''} title="${esc(w.official || w.name)}">
    <span class="rc-round">${w.round ? 'R' + w.round : '–'}</span>
    <span class="rc-main"><b>${esc(w.name)}</b><small>${esc(w.location)}, ${when}</small></span>
    ${pod}${action}
  </${tag}>`;
}

function renderArchive() {
  const box = document.querySelector('#archive-body');
  const years = Object.keys(races.cal?.years || {}).sort().reverse();
  const y = races.year || years[0];
  const rows = races.cal ? races.cal.years[y] : [];
  const done = rows.filter((w) => w.podium).length;
  document.querySelector('#archive-years').innerHTML = years.map((k) =>
    `<button type="button" role="tab" data-year="${k}" class="${k === y ? 'on' : ''}" aria-selected="${k === y}">${k}</button>`).join('');
  box.innerHTML = `${nextCard()}
    <div class="arch-head"><h3>${y} season</h3><span>${done} of ${rows.filter((w) => !w.cancelled).length} races run. Pick one to watch the replay.</span></div>
    <div class="race-grid">${rows.map(raceCard).join('')}</div>`;
}

async function openArchive() {
  const dlg = document.querySelector('#archive');
  // pick up races that finished downloading since the page loaded
  try { races.idx = await fetch('data/index.json', { cache: 'no-store' }).then((r) => r.json()); } catch { /* keep old */ }
  if (!races.year) races.year = String(weekendFor(races.current)?.year || '');
  renderArchive();
  dlg.hidden = false;
  document.querySelector('#race-btn').setAttribute('aria-expanded', 'true');
  document.querySelector('#archive-close').focus();
}
function closeArchive() {
  document.querySelector('#archive').hidden = true;
  document.querySelector('#race-btn').setAttribute('aria-expanded', 'false');
}

async function initRaces(idx, currentKey, onPick) {
  races.idx = idx; races.current = currentKey; races.open = onPick;
  try { races.cal = await fetch('data/calendar.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); } catch { races.cal = null; }
  renderRaceButton(); renderNextPill();
  setInterval(() => {
    renderNextPill();
    const dlg = document.querySelector('#archive');
    if (!dlg.hidden) dlg.querySelectorAll('[data-countdown]').forEach((b) => {
      const ms = Date.parse(b.dataset.countdown) - Date.now();
      b.textContent = ms > 0 ? countdown(ms) : 'Racing now';
    });
  }, 1000);

  document.querySelector('#race-btn').addEventListener('click', openArchive);
  document.querySelector('#next-pill').addEventListener('click', (e) => {
    if (e.currentTarget.dataset.action === 'tune-in' && typeof enterLive === 'function') { enterLive().then(renderNextPill); return; }
    races.year = String(new Date().getFullYear()); openArchive();
  });
  document.querySelector('#archive-close').addEventListener('click', closeArchive);
  document.querySelector('#archive').addEventListener('click', (e) => {
    if (e.target.id === 'archive') return closeArchive(); // backdrop
    const yb = e.target.closest('[data-year]');
    if (yb) { races.year = yb.dataset.year; renderArchive(); return; }
    const card = e.target.closest('.race-card[data-key]');
    if (card) { races.current = card.dataset.key; renderRaceButton(); closeArchive(); races.open(card.dataset.key); return; }
    if (e.target.id === 'add-cal') {
      const w = allWeekends().find((x) => String(x.meeting_key) === e.target.dataset.mk);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([icsFor(w)], { type: 'text/calendar' })),
        download: `${w.name.replace(/\s+/g, '-')}-${w.year}.ics`,
      });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    if (e.target.id === 'tune-in') {
      if (window.liveInfo?.live && typeof enterLive === 'function') { closeArchive(); enterLive().then(renderNextPill); return; }
      const note = document.querySelector('#tune-note');
      note.hidden = false;
      note.textContent = 'The live server isn’t running. Start it with: .venv/bin/python live_server.py (see README) and reload this page.';
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('#archive').hidden) closeArchive();
  });
}
