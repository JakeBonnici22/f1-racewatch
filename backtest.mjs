// Backtest the race-call detectors over every cached race.
// Runs the exact browser code (app.js, analysis.js, calls.js) in a Node VM with
// the DOM stubbed out, so the numbers are what the dashboard really produces.
//
//   node backtest.mjs                         all cached races, default settings
//   node backtest.mjs --set CATCH_TARGET=1.5  override a CALL threshold
//   node backtest.mjs --year 2025             one season
//
// Writes results/backtest_calls.csv (one row per prediction call) and prints a
// hit-rate table per detector.
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, here } from './harness.mjs';

const args = process.argv.slice(2);
const sets = [];
let year = null, usePriors = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') sets.push(args[++i]);
  if (args[i] === '--year') year = Number(args[++i]);
  if (args[i] === '--no-priors') usePriors = false;
}
const { ctx, run } = loadEngine();
for (const s of sets) {
  const [k, v] = s.split('=');
  run(`CALL[${JSON.stringify(k)}] = ${Number(v)}`);
}
const priorsPath = path.join(here, 'data/priors.json');
ctx.__priors = usePriors && fs.existsSync(priorsPath) ? JSON.parse(fs.readFileSync(priorsPath, 'utf8')) : {};

const idx = JSON.parse(fs.readFileSync(path.join(here, 'data/index.json'), 'utf8'))
  .filter((s) => year == null || s.year === year);
const rows = [];
const perRace = [];
const t0 = Date.now();
for (const s of idx) {
  const file = path.join(here, 'data', String(s.session_key), 'session.json');
  if (!fs.existsSync(file)) continue;
  ctx.__raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let res;
  try {
    res = run(`(() => {
      const d = prepare(__raw, {});
      d.priors = priorsFor(__priors, __raw.session.circuit_key, __raw.session.date_start); // earlier races only
      state.data = d;
      prepAnalysis(d);
      const calls = buildCalls(d);
      return { calls: calls.map((c) => ({ kind: c.kind, lap: c.lap, minor: c.minor, score: c.score,
        pred: c.pred ? { kind: c.pred.kind, status: c.pred.status, note: c.pred.note } : null,
        text: c.text.replace(/<[^>]+>/g, '') })), laps: d.totalLaps };
    })()`);
  } catch (e) {
    console.log(`  skip ${s.label}: ${e.message}`);
    continue;
  }
  perRace.push({ label: s.label, laps: res.laps, calls: res.calls.length, prominent: res.calls.filter((c) => !c.minor).length });
  for (const c of res.calls) if (c.pred) rows.push({ race: s.label, year: s.year, ...c });
}

// ---------- report ----------
const table = {};
for (const r of rows) {
  const k = r.pred.kind;
  table[k] ??= { hit: 0, miss: 0, void: 0, open: 0 };
  table[k][r.pred.status || 'open']++;
}
console.log(`\n${perRace.length} races in ${((Date.now() - t0) / 1000).toFixed(1)}s` + (sets.length ? `  (overrides: ${sets.join(', ')})` : '') + (usePriors ? '' : '  (no track history)'));
const calls = perRace.reduce((a, r) => a + r.calls, 0), prom = perRace.reduce((a, r) => a + r.prominent, 0);
const laps = perRace.reduce((a, r) => a + r.laps, 0);
console.log(`calls: ${calls} total, ${prom} prominent (${(prom / laps).toFixed(2)} per lap)\n`);
console.log('prediction   right  wrong  hit rate   not scored');
for (const [k, v] of Object.entries(table)) {
  const scored = v.hit + v.miss;
  console.log(`${k.padEnd(12)} ${String(v.hit).padStart(5)}  ${String(v.miss).padStart(5)}  ${scored ? ((100 * v.hit) / scored).toFixed(0).padStart(6) + '%' : '     -'}   ${String(v.void + v.open).padStart(10)}`);
}

fs.mkdirSync(path.join(here, 'results'), { recursive: true });
const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(here, 'results/backtest_calls.csv'),
  'race,year,lap,kind,status,note,text\n' + rows.map((r) => [r.race, r.year, r.lap, r.pred.kind, r.pred.status, r.pred.note, r.text].map(esc).join(',')).join('\n'));
