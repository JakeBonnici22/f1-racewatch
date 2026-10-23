// Timing board columns: a registry of every column the board can show, plus
// ways to arrange them - drag a header to move it, hover a header and click
// its x to hide it, or click + at the end of the header row to add columns
// and reorder them in a list. Saved with the layout.
'use strict';

const fmtSec = (x) => (x ? x.toFixed(3) : '');
const sectorCls = (r, cx, k) => {
  const v = r.lastLap?.[k];
  if (!v) return '';
  return v === cx.ob[k] ? 'best' : v === r.pb[k] ? 'pb' : '';
};
const sector = (k) => ({
  label: k.toUpperCase(), title: `Sector ${k[1]} on the last lap. Purple: fastest of anyone so far. Green: driver's best.`, num: true,
  cell: (r, cx) => `<span class="${sectorCls(r, cx, k)}">${fmtSec(r.lastLap?.[k])}</span>`,
});

const BOARD_COLS = {
  delta: { label: '+/−', title: 'Places gained or lost since the start', num: true, cell: (r, cx) => cx.delta },
  gap: { label: 'Gap', title: 'Gap to the leader', num: true,
    cell: (r, cx) => (cx.isLeader ? `<span class="muted">Lap ${r.curLap}</span>` : fmtGap(r.gap)) },
  int: { label: 'Int', title: 'Gap to the car ahead', num: true, cell: (r, cx) => (cx.isLeader ? '' : fmtGap(r.int)) },
  tyre: { label: 'Tyre', title: 'Compound and laps on it', num: false,
    cell: (r, cx) => (cx.ty ? `<span class="tyre" title="${r.tyre.sure ? r.tyre.c.toLowerCase() + ', ' + r.tyre.age + ' laps old' : 'Pitted: new compound not in the feed yet'}"><i class="${r.tyre.sure ? '' : 'unsure'}" style="--c:${cx.ty[1]}">${r.tyre.sure ? cx.ty[0] : '?'}</i>${r.tyre.age}</span>` : '') },
  stops: { label: 'Stops', title: 'Pit stops made', num: true, cell: (r) => r.pitsDone || '' },
  last: { label: 'Last lap', title: 'Last completed lap. Purple: fastest of anyone so far. Green: driver\'s best.', num: true,
    cell: (r, cx) => `<span class="${cx.lastCls}">${fmtLap(r.last)}</span>` },
  best: { label: 'Best lap', title: 'Driver\'s fastest lap so far', num: true,
    cell: (r, cx) => (r.best < Infinity ? `<span class="${r.best === cx.overallBest ? 'best' : ''}">${fmtLap(r.best)}</span>` : '') },
  pace: { label: 'Pace', title: 'Median of the last 5 green-flag laps', num: true,
    cell: (r, cx) => {
      const d = state.data;
      if (!d.clean || typeof paceAt !== 'function') return '';
      const p = paceAt(d, r.n, cx.t);
      return p ? fmtLap(p.pace) : '';
    } },
  s1: sector('s1'), s2: sector('s2'), s3: sector('s3'),
  trap: { label: 'Speed', title: 'Speed trap on the last lap, km/h. Purple: fastest of anyone so far.', num: true,
    cell: (r, cx) => (r.lastLap?.trap ? `<span class="${r.lastLap.trap === cx.ob.trap ? 'best' : ''}">${r.lastLap.trap}</span>` : '') },
  grid: { label: 'Grid', title: 'Starting position', num: true, cell: (r) => r.grid ?? '' },
};
const DEFAULT_COLS = ['delta', 'gap', 'int', 'tyre', 'stops', 'last'];

function boardColumns() {
  const cols = (typeof layout !== 'undefined' && Array.isArray(layout.cols)) ? layout.cols : DEFAULT_COLS;
  return cols.filter((k) => BOARD_COLS[k]);
}
function setColumns(cols) {
  layout.cols = cols;
  layout.w1 = null; // new columns: fit the board to them again
  if (typeof applyView === 'function') applyView(); // saves the layout
  state.headKey = null; state.lastPanelUpdate = 0;
  if (!document.querySelector('#cols-menu').hidden) buildColsMenu();
}

// ---------- header: draggable column titles ----------
// Size the board panel to the columns that are switched on: it grows when
// you add columns (up to half the screen), then scrolls sideways with Pos and
// Driver pinned so you never lose track of whose row it is.
function fitBoardWidth() {
  const tbl = document.querySelector('#timing-table');
  if (!tbl || !tbl.offsetParent) return;
  tbl.style.width = 'max-content';
  const need = Math.ceil(tbl.getBoundingClientRect().width) + 24;
  tbl.style.width = '';
  if (!layout.w1) { // a width you dragged yourself wins over auto-fit
    const w = Math.max(340, Math.min(need, Math.round(innerWidth * 0.5)));
    document.body.style.setProperty('--c1', w + 'px');
  }
  // reading scrollWidth forces layout, so this sees the new width at once
  const sc = tbl.closest('.board-scroll'), pos = tbl.querySelector('td.pos');
  if (pos) sc.style.setProperty('--pos-w', pos.offsetWidth + 'px');
  sc.classList.toggle('scrolls', sc.scrollWidth > sc.clientWidth + 1);
}
addEventListener('resize', () => { state.fitKey = null; });

function ensureBoardHeader() {
  const cols = boardColumns();
  const key = cols.join(',');
  if (state.headKey === key) return;
  state.headKey = key;
  const PLUS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  document.querySelector('#board-head').innerHTML = `<tr><th class="num">Pos</th><th>Driver</th>${cols.map((k) =>
    `<th class="${BOARD_COLS[k].num ? 'num ' : ''}c-${k}" draggable="true" data-k="${k}" title="${BOARD_COLS[k].title}. Drag to move.">${BOARD_COLS[k].label}<button type="button" class="th-x" data-hide="${k}" aria-label="Hide ${BOARD_COLS[k].label}" title="Hide this column">×</button></th>`).join('')}<th class="th-add"><button type="button" class="add-col" aria-haspopup="true" aria-expanded="${!document.querySelector('#cols-menu').hidden}" aria-label="Add, remove or reorder columns" title="Add, remove or reorder columns">${PLUS}</button></th></tr>`;
}

let dragKey = null;
const head = document.querySelector('#board-head');
const clearDrop = () => head.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
head.addEventListener('dragstart', (e) => {
  const th = e.target.closest('th[data-k]');
  if (!th || e.target.closest('.th-x')) return;
  dragKey = th.dataset.k;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragKey);
  th.classList.add('dragging');
});
head.addEventListener('dragover', (e) => {
  const th = e.target.closest('th[data-k]');
  if (!th || !dragKey) return;
  e.preventDefault();
  clearDrop();
  const r = th.getBoundingClientRect();
  th.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
});
head.addEventListener('dragleave', (e) => { if (!head.contains(e.relatedTarget)) clearDrop(); });
head.addEventListener('drop', (e) => {
  const th = e.target.closest('th[data-k]');
  e.preventDefault();
  if (!th || !dragKey || th.dataset.k === dragKey) { clearDrop(); return; }
  const after = th.classList.contains('drop-after');
  const cols = boardColumns().filter((k) => k !== dragKey);
  cols.splice(cols.indexOf(th.dataset.k) + (after ? 1 : 0), 0, dragKey);
  clearDrop(); dragKey = null;
  setColumns(cols);
});
head.addEventListener('dragend', () => { dragKey = null; clearDrop(); head.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); });

// ---------- Columns editor ----------
function buildColsMenu() {
  const shown = boardColumns();
  const hidden = Object.keys(BOARD_COLS).filter((k) => !shown.includes(k));
  const item = (k, on, i) => `<li data-k="${k}" ${on ? 'draggable="true"' : ''} class="${on ? 'on' : ''}">
      <span class="grip" aria-hidden="true">${on ? '⠿' : ''}</span>
      <label><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''}> <b>${BOARD_COLS[k].label}</b><span>${BOARD_COLS[k].title.split('. ')[0]}</span></label>
      ${on ? `<button data-move="-1" data-k="${k}" aria-label="Move ${BOARD_COLS[k].label} left" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button data-move="1" data-k="${k}" aria-label="Move ${BOARD_COLS[k].label} right" ${i === shown.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
    </li>`;
  document.querySelector('#cols-menu').innerHTML = `
    <p class="cols-hint">Tick to show a column, drag ⠿ to reorder. On the board you can also drag a column title to move it, or hover it and click × to hide it.</p>
    <ol class="cols-list">${shown.map((k, i) => item(k, true, i)).join('')}</ol>
    ${hidden.length ? `<p class="cols-sub">More columns</p><ol class="cols-list">${hidden.map((k) => item(k, false)).join('')}</ol>` : ''}
    <label class="cols-team"><input type="checkbox" data-team ${layout['col-team'] ? 'checked' : ''}> Show team names next to drivers</label>
    <button type="button" id="cols-reset">Reset columns</button>`;
}

const colsMenu = document.querySelector('#cols-menu');
const setExpanded = (on) => document.querySelector('.add-col')?.setAttribute('aria-expanded', String(on));
function toggleColsMenu(force) {
  const open = force ?? colsMenu.hidden;
  colsMenu.hidden = !open;
  setExpanded(open);
  if (!open) return;
  buildColsMenu();
  // drop the menu just under the header row, right-aligned with the board
  const board = document.querySelector('.board').getBoundingClientRect();
  const headRow = document.querySelector('#board-head').getBoundingClientRect();
  colsMenu.style.top = `${headRow.bottom - board.top + 4}px`;
}
document.querySelector('#board-head').addEventListener('click', (e) => {
  const add = e.target.closest('.add-col');
  if (add) { e.stopPropagation(); toggleColsMenu(); return; }
  const x = e.target.closest('[data-hide]');
  if (x) { e.stopPropagation(); setColumns(boardColumns().filter((k) => k !== x.dataset.hide)); }
});
document.addEventListener('click', (e) => {
  if (!colsMenu.hidden && !e.target.closest('#cols-menu') && !e.target.closest('.add-col')) toggleColsMenu(false);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !colsMenu.hidden) toggleColsMenu(false); });
colsMenu.addEventListener('change', (e) => {
  if (e.target.matches('[data-team]')) { layout['col-team'] = e.target.checked; applyView(); return; }
  const k = e.target.dataset.k;
  if (!k) return;
  const cols = boardColumns().filter((x) => x !== k);
  if (e.target.checked) cols.push(k);
  setColumns(cols);
});
colsMenu.addEventListener('click', (e) => {
  if (e.target.id === 'cols-reset') { setColumns([...DEFAULT_COLS]); return; }
  const b = e.target.closest('button[data-move]');
  if (!b) return;
  const cols = boardColumns(), i = cols.indexOf(b.dataset.k), j = i + Number(b.dataset.move);
  if (j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  setColumns(cols);
  colsMenu.querySelector(`button[data-k="${b.dataset.k}"][data-move="${b.dataset.move}"]`)?.focus();
});
// drag to reorder inside the editor
let listDrag = null;
colsMenu.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[draggable]');
  if (!li) return;
  listDrag = li.dataset.k; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', listDrag);
  li.classList.add('dragging');
});
colsMenu.addEventListener('dragover', (e) => {
  const li = e.target.closest('li[draggable]');
  if (!li || !listDrag) return;
  e.preventDefault();
  colsMenu.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
colsMenu.addEventListener('drop', (e) => {
  const li = e.target.closest('li[draggable]');
  e.preventDefault();
  if (!li || !listDrag || li.dataset.k === listDrag) return;
  const after = li.classList.contains('drop-after');
  const cols = boardColumns().filter((k) => k !== listDrag);
  cols.splice(cols.indexOf(li.dataset.k) + (after ? 1 : 0), 0, listDrag);
  listDrag = null;
  setColumns(cols);
});
colsMenu.addEventListener('dragend', () => { listDrag = null; });
