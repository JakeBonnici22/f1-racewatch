// Cost cap: what is actually public. Teams' spending is never published; the
// FIA only says, months after each year, whether every team stayed under.
// Hand-maintained from FIA announcements - update when the next review lands.
'use strict';

const COSTCAP = {
  asOf: '2026-10-24',
  cap: [
    { label: 'Team cost cap 2026', value: '$215M', note: 'Was $135M plus inflation in 2023–25. Most of the jump is accounting: depreciation now counts inside the cap (the separate $36M capital-spend allowance is gone) and staff who work on F1 count in full. Up to $2M unspent can roll into the next year.' },
    { label: 'Engine maker cap 2026', value: '$190M', note: 'Was $95M plus inflation in 2023–25. Brands with uncompetitive engines can get extra development allowance (ADUO).' },
  ],
  excluded: ['Driver salaries', 'The three best-paid staff (usually team principal and technical director)', 'Marketing, legal, HR and finance', 'Race travel', 'Heritage cars', 'Health & safety and catering (new for 2026)'],
  // 2026 team names, with the name the team raced under in earlier years
  years: [2021, 2022, 2023, 2024, 2025],
  teams: [
    { team: 'McLaren', colour: 'FF8000', r: {} },
    { team: 'Mercedes', colour: '27F4D2', r: {} },
    { team: 'Red Bull Racing', colour: '3671C6', r: { 2021: { kind: 'over', text: 'Minor overspend (under 5%)', penalty: '$7M fine + 10% less aero testing' } } },
    { team: 'Ferrari', colour: 'E8002D', r: {} },
    { team: 'Williams', colour: '64C4FF', r: { 2021: { kind: 'proc', text: 'Procedural breach (filed late)', penalty: '$25,000 fine' } } },
    { team: 'Racing Bulls', was: 'AlphaTauri / RB', colour: '6692FF', r: {} },
    { team: 'Aston Martin', colour: '229971', r: { 2021: { kind: 'proc', text: 'Procedural breach (wrongly excluded costs)', penalty: '$450,000 fine' }, 2024: { kind: 'proc', text: 'Procedural breach, "very minor"', penalty: 'No fine' } } },
    { team: 'Haas', colour: 'B6BABD', r: {} },
    { team: 'Audi', was: 'Alfa Romeo / Sauber', colour: 'F50537', r: {} },
    { team: 'Alpine', colour: 'FF87BC', r: {} },
    { team: 'Cadillac', colour: '909090', since: 2026, r: {} },
  ],
  engines: [
    { team: 'Honda (HRC)', r: { 2023: { kind: 'proc', text: 'Procedural breach', penalty: '$600,000 fine' } } },
    { team: 'Alpine (engine division)', r: { 2023: { kind: 'proc', text: 'Procedural breach', penalty: '$400,000 fine' } } },
  ],
  pending: 2025, // reporting year whose review hasn't been published yet
  sources: [
    ['F1: what is the cost cap and why has it gone up (Apr 2026)', 'https://www.formula1.com/en/latest/article/explained-what-is-the-f1-cost-cap-and-why-has-it-gone-up.2tYtDIe5SbE5utjThctBT3'],
    ['F1: FIA confirm findings from 2024 cost cap review (Oct 2025)', 'https://www.formula1.com/en/latest/article/fia-confirm-findings-from-2024-cost-cap-review.3uQ02KWRQWR6fR9mgYOyro'],
    ['F1: FIA announces 2021 cost cap breaches', 'https://www.formula1.com/en/latest/article/fia-announces-2021-cost-cap-breaches-by-two-f1-teams.2N8xy1FHhoOlwsOO3Mx0A2'],
    ['The Race: Alpine and Honda fined over 2023 engine cost cap', 'https://www.the-race.com/formula-1/alpine-honda-get-hefty-fines-as-f1-cost-cap-breaches-detailed/'],
  ],
};

function capCell(team, y) {
  if (team.since && y < team.since) return '<td class="cc-na" title="Not on the grid yet">–</td>';
  if (y === COSTCAP.pending) return '<td class="cc-wait" title="The FIA hasn\'t published this year\'s review yet">Pending</td>';
  const x = team.r[y];
  if (!x) return '<td class="cc-ok" title="Compliant: spent under the cap">✓</td>';
  return `<td class="cc-${x.kind}" title="${esc(x.text)}: ${esc(x.penalty)}"><b>${x.kind === 'over' ? 'Overspent' : 'Procedural'}</b><small>${esc(x.penalty)}</small></td>`;
}

function renderCostCap() {
  const C = COSTCAP;
  const head = `<tr><th>Team</th>${C.years.map((y) => `<th>${y}</th>`).join('')}</tr>`;
  const row = (t) => `<tr><th scope="row"><i class="cc-sw" style="--c:#${t.colour || '5d6776'}"></i>${esc(t.team)}${t.was ? `<small>was ${esc(t.was)}</small>` : ''}</th>${C.years.map((y) => capCell(t, y)).join('')}</tr>`;
  document.querySelector('#lobby-cap').innerHTML = `
    <section class="lb-intro">
      <h2>Cost cap</h2>
      <p>How close each team is to the cap <b>isn't public</b>. Teams report a year's spending to the FIA after the season, and the FIA only announces whether each one stayed under, about ten months later (the 2024 review came out on 28 October 2025). The ${C.pending} review hasn't been published yet, so nobody outside the teams knows how close anyone is this year.</p>
    </section>
    <div class="cc-figures">${C.cap.map((c) => `<div class="cc-fig"><span>${esc(c.label)}</span><b>${esc(c.value)}</b><p>${esc(c.note)}</p></div>`).join('')}
      <div class="cc-fig"><span>Not counted</span><ul>${C.excluded.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>
    <h3 class="lb-h3">Every team's record so far</h3>
    <p class="lb-sub">✓ stayed under the cap. A <b>procedural</b> breach is paperwork (late or wrong reporting), not overspending. An <b>overspend</b> under 5% is "minor"; 5% or more is "material", which can cost points. None has been material yet.</p>
    <div class="cc-scroll"><table class="cc-table">${head}${C.teams.map(row).join('')}
      <tr class="cc-sep"><th colspan="${C.years.length + 1}">Engine makers (cap since 2023; others all compliant)</th></tr>
      ${C.engines.map((t) => `<tr><th scope="row">${esc(t.team)}</th>${C.years.map((y) => (y < 2023 ? '<td class="cc-na">–</td>' : capCell(t, y))).join('')}</tr>`).join('')}
    </table></div>
    <p class="lb-foot">As of ${esc(C.asOf)}. Sources: ${C.sources.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ')}</p>`;
}
