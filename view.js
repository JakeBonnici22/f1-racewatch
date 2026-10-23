// View settings: which panels and timing columns are shown, row density, and
// the expanded-map mode. Saved per browser so the layout sticks between races.
'use strict';

const VIEW_DEFAULTS = {
  board: true, analysis: true, side: true,
  'col-team': false, cols: ['delta', 'gap', 'int', 'tyre', 'stops', 'last'],
  compact: false, mapFull: false,
  w1: null, w3: null, h2: null,
};
const VIEW_LABELS = {
  panels: [['board', 'Timing board'], ['analysis', 'Analysis under the map'], ['side', 'Race calls column']],
  cols: [['col-team', 'Team names']],
};
let layout = { ...VIEW_DEFAULTS };
try { layout = { ...VIEW_DEFAULTS, ...JSON.parse(localStorage.getItem('racewatch.view') || '{}') }; } catch { /* storage blocked: defaults */ }

function applyView() {
  const b = document.body;
  b.classList.toggle('no-board', !layout.board);
  b.classList.toggle('no-analysis', !layout.analysis || layout.mapFull);
  b.classList.toggle('no-side', !layout.side);
  b.classList.toggle('compact', layout.compact);
  for (const [k] of VIEW_LABELS.cols) b.classList.toggle(`hide-${k}`, !layout[k]);
  document.querySelector('#map-expand').textContent = layout.mapFull ? 'Show analysis' : 'Expand map';
  document.querySelector('#map-expand').setAttribute('aria-pressed', String(layout.mapFull));
  try { localStorage.setItem('racewatch.view', JSON.stringify(layout)); } catch { /* not saved */ }
  if (typeof fitView === 'function') requestAnimationFrame(() => fitView());
}

function buildViewMenu() {
  const box = (k, label) => `<label><input type="checkbox" data-k="${k}" ${layout[k] ? 'checked' : ''}> ${label}</label>`;
  document.querySelector('#view-menu').innerHTML = `
    <fieldset><legend>Panels</legend>${VIEW_LABELS.panels.map(([k, l]) => box(k, l)).join('')}</fieldset>
    <fieldset><legend>Timing board</legend>${VIEW_LABELS.cols.map(([k, l]) => box(k, l)).join('')}<span class="hint">Use the Columns button on the board to add, remove and reorder columns.</span></fieldset>
    <fieldset><legend>Rows</legend>${box('compact', 'Compact rows')}</fieldset>
    <button type="button" id="view-reset">Reset layout</button>`;
}

document.querySelector('#view-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.querySelector('#view-menu');
  menu.hidden = !menu.hidden;
  document.querySelector('#view-btn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  const menu = document.querySelector('#view-menu');
  if (!menu.hidden && !e.target.closest('#view-menu')) { menu.hidden = true; document.querySelector('#view-btn').setAttribute('aria-expanded', 'false'); }
});
document.querySelector('#view-menu').addEventListener('change', (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  layout[k] = e.target.checked;
  applyView();
});
document.querySelector('#view-menu').addEventListener('click', (e) => {
  if (e.target.id !== 'view-reset') return;
  layout = { ...VIEW_DEFAULTS, cols: [...VIEW_DEFAULTS.cols] };
  buildViewMenu(); applyView(); if (typeof applySizes === 'function') applySizes();
  state.headKey = null; state.lastPanelUpdate = 0;
});
document.querySelector('#map-expand').addEventListener('click', () => { layout.mapFull = !layout.mapFull; applyView(); });
document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, select, textarea')) return;
  if (e.key === 'm' || e.key === 'M') { layout.mapFull = !layout.mapFull; applyView(); }
});

buildViewMenu();
applyView();
