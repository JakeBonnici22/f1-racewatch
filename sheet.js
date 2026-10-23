// The "Title & records" sheet: opens over the dashboard, refreshes every
// couple of seconds while open so it follows the live race (or the replay).
'use strict';
(function () {
  const sheet = document.querySelector('#title-sheet');
  let pane = 'title', timer = null;
  const render = () => {
    if (sheet.hidden) return;
    if (pane === 'title') renderTitle(); else renderRecords();
  };
  const open = () => {
    sheet.hidden = false;
    render();
    clearInterval(timer);
    timer = setInterval(render, 2000);
    document.querySelector('#title-close').focus();
  };
  const close = () => { sheet.hidden = true; clearInterval(timer); };
  document.querySelector('#title-btn').addEventListener('click', open);
  document.querySelector('#title-close').addEventListener('click', close);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return close();
    const b = e.target.closest('[data-pane]');
    if (!b) return;
    pane = b.dataset.pane;
    for (const x of sheet.querySelectorAll('[data-pane]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }
    document.querySelector('#title-pane').hidden = pane !== 'title';
    document.querySelector('#records-pane').hidden = pane !== 'records';
    render();
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
})();
