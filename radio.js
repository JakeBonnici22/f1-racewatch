// Team radio: the clips F1 publishes, listed as they're broadcast (no spoilers
// when rewinding), each with a play button. OpenF1 gives the timestamps and
// the audio links; from 2026 far fewer clips are published than before.
'use strict';

const radio = { key: null, rows: [], loading: false, seen: Infinity, shownKey: '', at: 0, playing: null };
const radioAudio = new Audio();
radioAudio.preload = 'none';

async function radioLoad() {
  const d = state.data;
  if (!d) return;
  const sk = d.raw.session.session_key;
  // live: the clips arrive with the rest of the live data
  if (d.live && Array.isArray(d.raw.team_radio)) { radio.key = sk; radio.rows = d.raw.team_radio; return; }
  if (radio.key === sk || radio.loading) return;
  radio.loading = true;
  try {
    const r = await fetch(`/teamradio?session=${sk}`);
    radio.rows = r.ok ? await r.json() : [];
  } catch { radio.rows = []; }
  radio.key = sk; radio.loading = false; radio.seen = Infinity; radio.shownKey = '';
}

function renderRadio(force) {
  const box = document.querySelector('#radio');
  const d = state.data;
  if (!box || !d || box.hidden) return;
  radioLoad();
  const rel = (iso) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`) - d.t0;
  const list = (Array.isArray(radio.rows) ? radio.rows : []).map((r, i) => ({ ...r, i, t: rel(r.date) })).filter((r) => r.t <= state.t);
  const key = `${radio.key}|${list.length}|${radio.playing}|${state.selected}`;
  if (key === radio.shownKey && !force) return;
  radio.shownKey = key;
  const leaderTs = d.leaderLaps.map((l) => l.t);
  const lapAt = (t) => d.leaderLaps[lastIdx(leaderTs, t)]?.n;
  const fresh = radio.seen;
  if (!list.length) {
    box.innerHTML = `<li><span></span><span class="muted">${radio.loading ? 'Loading team radio…' : radio.rows.length ? 'No radio broadcast yet at this point of the session.' : 'No team radio published for this session.'}</span></li>`;
    return;
  }
  box.innerHTML = list.slice().reverse().slice(0, 80).map((r) => {
    const drv = d.drivers.get(r.driver_number);
    const on = radio.playing === r.recording_url;
    const mine = state.selected === r.driver_number;
    return `<li class="${r.i >= fresh ? 'fresh' : ''} ${mine ? 'mine' : ''}">
      <span class="when">${lapAt(r.t) ? `L${lapAt(r.t)}` : ''}</span>
      <span class="rd"><button type="button" class="rd-play ${on ? 'on' : ''}" data-url="${esc(r.recording_url)}" aria-label="${on ? 'Stop' : 'Play'} ${drv?.code ?? ''} radio">${on ? '■' : '▶'}</button>
      <b style="color:${drv?.colour ?? 'inherit'}">${drv?.code ?? r.driver_number}</b> <span class="muted">${drv?.team ?? ''}</span></span></li>`;
  }).join('');
  radio.seen = Math.max(...list.map((r) => r.i)) + 1;
}

(function wireRadio() {
  const box = document.querySelector('#radio');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.rd-play');
    if (!b) return;
    const url = b.dataset.url;
    if (radio.playing === url) { radioAudio.pause(); radio.playing = null; }
    else { radioAudio.src = url; radioAudio.play().catch(() => {}); radio.playing = url; }
    renderRadio(true);
  });
  radioAudio.addEventListener('ended', () => { radio.playing = null; renderRadio(true); });
})();

function maybeRenderRadio() {
  const now = performance.now();
  if (now - radio.at < 1000) return;
  radio.at = now;
  renderRadio(false);
}
