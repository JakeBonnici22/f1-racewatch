// Share this moment, visitor feedback, the lobby's moving mini map, and a toast.
'use strict';

function toast(msg, ms = 2600) {
  const el = document.querySelector('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- share: a link that opens at this lap, following the same drivers ----------
function shareUrl() {
  const base = location.origin + location.pathname;
  if (typeof live !== 'undefined' && live.on) return `${base}?live=1`;
  const key = state.data?.raw?.session?.session_key;
  if (!key) return base;
  const q = new URLSearchParams({ session: key });
  const lap = lapNow();
  if (lap > 1) q.set('lap', lap);
  if (state.selected != null) q.set('follow', state.selected);
  if (state.compare != null) q.set('vs', state.compare);
  return `${base}?${q}`;
}
async function shareMoment() {
  const url = shareUrl();
  const what = document.querySelector('#race-btn b')?.textContent || 'Race Watch';
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: `Race Watch: ${what}`, url }); return; } catch { /* cancelled: fall back to copying */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    const lap = lapNow();
    toast(typeof live !== 'undefined' && live.on ? 'Link copied: it opens the live session' : `Link copied: it opens at lap ${lap || 1}${state.selected != null ? ', following the same driver' : ''}`);
  } catch {
    toast(url, 8000);
  }
}

// ---------- feedback ----------
function openFeedback() {
  const dlg = document.querySelector('#fb-sheet');
  dlg.hidden = false;
  document.querySelector('#fb-note').textContent = '';
  setTimeout(() => document.querySelector('#fb-text').focus(), 30);
}
function closeFeedback() { document.querySelector('#fb-sheet').hidden = true; }
async function sendFeedback() {
  const box = document.querySelector('#fb-text'), note = document.querySelector('#fb-note'), btn = document.querySelector('#fb-send');
  const text = box.value.trim();
  if (text.length < 3) { note.textContent = 'Write a little more first.'; return; }
  btn.disabled = true; note.textContent = 'Sending…';
  try {
    const r = await fetch('/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, page: location.pathname + location.search + location.hash }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `error ${r.status}`);
    box.value = '';
    closeFeedback();
    toast('Thanks! Feedback sent.');
  } catch (e) {
    note.textContent = `Couldn't send it: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- lobby mini map: one lap of the latest race on a loop ----------
const preview = { data: null, raf: 0, t0: 0, view: null };
async function startPreview() {
  const cv = document.querySelector('#pv-map');
  if (!cv) return;
  if (!preview.data) {
    try {
      const r = await fetch('data/preview.json');
      if (!r.ok) return;
      const p = await r.json();
      for (const c of p.cars) { // undo the deltas
        let x = 0, y = 0;
        c.pts = [];
        for (let i = 0; i < c.xy.length; i += 2) { x += c.xy[i]; y += c.xy[i + 1]; c.pts.push([x, y]); }
      }
      p.trackPts = [];
      for (let i = 0; i < p.track.length; i += 2) p.trackPts.push([p.track[i], p.track[i + 1]]);
      preview.data = p;
    } catch { return; }
  }
  const p = preview.data;
  const lbl = document.querySelector('#pv-label');
  if (lbl) lbl.textContent = `${p.name}, lap ${p.lap}`;
  const btn = document.querySelector('#pv-watch');
  if (btn) btn.dataset.replay = p.session_key;
  cancelAnimationFrame(preview.raf);
  preview.t0 = performance.now(); preview.view = null;
  const frame = (now) => {
    if (!document.body.contains(cv) || !inLobby()) return;
    drawPreview(cv, (now - preview.t0) / p.step);
    preview.raf = requestAnimationFrame(frame);
  };
  preview.raf = requestAnimationFrame(frame);
}

function drawPreview(cv, f) {
  const p = preview.data, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); preview.view = null; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!preview.view) { // the rotation that fills the box best, y flipped like the main map
    let best = null;
    for (let deg = 0; deg < 180; deg += 5) {
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of p.trackPts) {
        const rx = x * c - y * s, ry = x * s + y * c;
        x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
      }
      const scale = Math.min((w - 36) / (x1 - x0), (h - 36) / (y1 - y0));
      if (!best || scale > best.scale) best = { c, s, scale, x0, x1, y0, y1 };
    }
    preview.view = { ...best, ox: (w - (best.x1 - best.x0) * best.scale) / 2 - best.x0 * best.scale, oy: (h - (best.y1 - best.y0) * best.scale) / 2 + best.y1 * best.scale };
  }
  const v = preview.view;
  const P = (x, y) => [v.ox + (x * v.c - y * v.s) * v.scale, v.oy - (x * v.s + y * v.c) * v.scale];
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = '#3b4146'; ctx.lineWidth = 9;
  ctx.beginPath();
  p.trackPts.forEach(([x, y], i) => { const [sx, sy] = P(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
  ctx.stroke();
  const n = p.cars[0]?.pts.length || 1, i = f % n, i0 = Math.floor(i), k = i - i0;
  for (let ci = p.cars.length - 1; ci >= 0; ci--) {
    const c = p.cars[ci], a = c.pts[i0], b = c.pts[(i0 + 1) % c.pts.length] || a;
    if (!a) continue;
    const [sx, sy] = P(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k);
    ctx.fillStyle = `#${c.colour}`;
    ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.fill();
    if (ci < 3) { // name the top three; flip the label to the left near the right edge
      ctx.fillStyle = '#eeede6'; ctx.font = '600 11px Archivo, system-ui, sans-serif';
      const tw = ctx.measureText(c.code).width;
      ctx.fillText(c.code, sx + 7 + tw > w - 2 ? sx - 7 - tw : sx + 7, sy - 6);
    }
  }
}

(function wireExtras() {
  document.querySelector('#share-btn')?.addEventListener('click', shareMoment);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="feedback"]')) { openFeedback(); return; }
    if (e.target.id === 'fb-sheet' || e.target.closest('#fb-close')) closeFeedback();
  });
  document.querySelector('#fb-send').addEventListener('click', sendFeedback);
  document.querySelector('#fb-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendFeedback();
    if (e.key === 'Escape') closeFeedback();
  });
})();
