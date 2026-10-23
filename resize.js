// Drag the gaps between panels to resize them. Widths are saved with the
// rest of the layout; double-click a handle to go back to automatic sizing.
'use strict';

(function () {
  const grid = document.querySelector('.grid');
  const $p = (s) => document.querySelector(s);
  const H = {
    w1: Object.assign(document.createElement('div'), { className: 'resizer v', title: 'Drag to resize the timing board. Double-click to fit it to the columns.' }),
    w3: Object.assign(document.createElement('div'), { className: 'resizer v', title: 'Drag to resize the race calls column. Double-click to reset.' }),
    h2: Object.assign(document.createElement('div'), { className: 'resizer h', title: 'Drag to share the space between the map and the analysis. Double-click to reset.' }),
  };
  for (const [k, el] of Object.entries(H)) { el.dataset.k = k; el.setAttribute('role', 'separator'); grid.appendChild(el); }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function limits(k) {
    const g = grid.getBoundingClientRect();
    if (k === 'w1') return [330, g.width - (layout.side ? (layout.w3 || 320) : 0) - 380];
    if (k === 'w3') return [240, Math.min(640, g.width - (layout.board ? (layout.w1 || 380) : 0) - 380)];
    return [110, g.height - 230];
  }

  // apply saved sizes as CSS variables on <body>; .grid falls back to its defaults
  window.applySizes = function () {
    const s = document.body.style;
    if (layout.w1) s.setProperty('--c1', layout.w1 + 'px');
    if (layout.w3) s.setProperty('--c3', layout.w3 + 'px'); else s.removeProperty('--c3');
    if (layout.h2) s.setProperty('--r2', layout.h2 + 'px'); else s.removeProperty('--r2');
    document.body.classList.toggle('sized-analysis', !!layout.h2);
    if (!layout.w1) { state.fitKey = null; } // let the board auto-fit again
    place();
  };

  function place() {
    const g = grid.getBoundingClientRect();
    const show = (el, on) => { el.hidden = !on; return on; };
    const board = $p('.board'), map = $p('.map-wrap'), side = $p('.side'), an = $p('.analysis');
    const vis = (el) => el && el.offsetParent && getComputedStyle(el).display !== 'none';
    const narrow = matchMedia('(max-width: 1100px)').matches;
    if (show(H.w1, !narrow && vis(board))) {
      const r = board.getBoundingClientRect();
      Object.assign(H.w1.style, { left: r.right - g.left + 'px', top: r.top - g.top + 'px', height: r.height + 'px' });
    }
    if (show(H.w3, !narrow && vis(side))) {
      const r = side.getBoundingClientRect();
      Object.assign(H.w3.style, { left: r.left - g.left - 12 + 'px', top: r.top - g.top + 'px', height: r.height + 'px' });
    }
    if (show(H.h2, !narrow && vis(an) && vis(map))) {
      const r = map.getBoundingClientRect();
      Object.assign(H.h2.style, { left: r.left - g.left + 'px', top: r.bottom - g.top + 'px', width: r.width + 'px' });
    }
  }
  new ResizeObserver(place).observe(grid);
  ['.board', '.map-wrap', '.side', '.analysis'].forEach((s) => $p(s) && new ResizeObserver(place).observe($p(s)));

  let drag = null;
  grid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.resizer');
    if (!el) return;
    e.preventDefault();
    const k = el.dataset.k;
    const start = k === 'w1' ? $p('.board').offsetWidth : k === 'w3' ? $p('.side').offsetWidth : $p('.analysis').offsetHeight;
    drag = { k, el, x: e.clientX, y: e.clientY, start };
    el.setPointerCapture(e.pointerId);
    el.classList.add('active'); document.body.classList.add('resizing', k === 'h2' ? 'resizing-h' : 'resizing-v');
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = drag.k === 'w1' ? e.clientX - drag.x : drag.k === 'w3' ? drag.x - e.clientX : drag.y - e.clientY;
    const [lo, hi] = limits(drag.k);
    layout[drag.k] = Math.round(clamp(drag.start + d, lo, Math.max(lo, hi)));
    applySizes();
    if (drag.k === 'w1') document.querySelector('.board-scroll').classList.toggle('scrolls', true);
  });
  const end = () => {
    if (!drag) return;
    drag.el.classList.remove('active');
    document.body.classList.remove('resizing', 'resizing-h', 'resizing-v');
    drag = null;
    applyView(); // saves, refits the map
    if (typeof fitBoardWidth === 'function') fitBoardWidth();
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
  grid.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.resizer');
    if (!el) return;
    layout[el.dataset.k] = null;
    applySizes(); applyView();
  });
  // arrow keys on a focused handle nudge it by 20px
  for (const el of Object.values(H)) {
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      const k = el.dataset.k, sign = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!sign) return;
      e.preventDefault();
      const cur = k === 'w1' ? $p('.board').offsetWidth : k === 'w3' ? $p('.side').offsetWidth : $p('.analysis').offsetHeight;
      const dir = k === 'w1' ? sign : -sign;
      const [lo, hi] = limits(k);
      layout[k] = Math.round(clamp(cur + 20 * dir, lo, Math.max(lo, hi)));
      applySizes(); applyView();
    });
  }
  applySizes();
})();
