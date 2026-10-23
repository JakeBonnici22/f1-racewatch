// Builds data/priors.json: for every cached race, the pit losses (green and
// under SC/VSC) and fresh-tyre gains it measured, grouped by circuit. The page
// and the backtest only use races held before the session they're looking at.
//
//   node build_priors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, cachedRaces, readSession, here } from './harness.mjs';

const { ctx, run } = loadEngine();
const out = {};
for (const s of cachedRaces()) {
  ctx.__raw = readSession(s);
  try {
    const r = run(`(() => {
      const d = prepare(__raw, {});
      state.data = d;
      prepAnalysis(d);
      buildCalls(d); // fills d.freshSamples
      const round = (x) => Math.round(x * 10) / 10;
      return {
        circuit: __raw.session.circuit_key, name: __raw.session.circuit_short_name,
        date: __raw.session.date_start, label: ${JSON.stringify(s.label)},
        green: d.pitSamples.filter((x) => x.kind === 'green').map((x) => round(x.loss)),
        neutral: d.pitSamples.filter((x) => x.kind === 'neutral').map((x) => round(x.loss)),
        fresh: (d.freshSamples || []).map((x) => round(x.gain)),
      };
    })()`);
    (out[r.circuit] ??= []).push({ date: r.date, label: r.label, green: r.green, neutral: r.neutral, fresh: r.fresh });
  } catch (e) {
    console.log(`skip ${s.label}: ${e.message}`);
  }
}
for (const k of Object.keys(out)) out[k].sort((a, b) => a.date.localeCompare(b.date));
fs.writeFileSync(path.join(here, 'data/priors.json'), JSON.stringify(out));

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
for (const [k, races] of Object.entries(out)) {
  const g = races.flatMap((r) => r.green), n = races.flatMap((r) => r.neutral);
  console.log(`${races[0].label.split(' ')[0].padEnd(14)} ${races.length} races  green ${String(med(g) ?? '-').padStart(5)}s (${g.length} stops)  SC/VSC ${String(med(n) ?? '-').padStart(5)}s (${n.length})`);
}
