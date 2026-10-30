// Race calls: rule-based detectors that turn the live state into one-line
// calls ("ANT catches RUS on lap 24"). Every detector only reads data up to
// the moment it fires, so the same engine works on a live feed. Predictions
// carry an outcome that is settled later from what actually happened; the
// panel shows that outcome only once the clock has reached it.
'use strict';

const CALL = {
  DRS_UNDER: 1.0, DRS_CLEAR: 1.2,       // s; hysteresis band for DRS fights
  CATCH_MIN_DELTA: 0.2,                 // s/lap faster to call a catch
  CATCH_MAX_LAPS: 3,                    // only call catches this close (backtest: 3 beats 5)
  CATCH_TARGET: 1.5,                    // s; "caught" = this close to the car ahead. 1.5 + 3 laps: 74% right vs 62% (82 races)
  CATCH_MAX_DELTA: 2.0,                 // s/lap; anything bigger is mixed conditions, not pace
  PASS_MAX_GAP: 1.5,                    // a real pass starts from close behind
  STINT_SHARE: 0.7,                     // undercut only once tyres are 70% of a typical stint old
  UNDERCUT_MIN_TYRE_AGE: 8,             // laps; fresh tyres can't undercut fresh tyres
  UNDERCUT_MARGIN: 0.4,                 // s; new tyres must beat the gap by this much (backtest: 9/14 right vs 9/20)
  OVERTAKE_HOLD_MS: 10_000,             // a pass must hold this long
  COOLDOWN_LAPS: { drs: 4, catch: 5, undercut: 10, pass: 3 },
};
const IMP = { undercut: 3, free: 3, red: 3, pen: 2.5, catch: 2, pass: 2, rain: 2, pit: 1.5, sc: 2, green: 1.2, inv: 1.2, drs: 1, nfa: 0.8 };
const posWeight = (p) => (p <= 3 ? 1 : p <= 6 ? 0.8 : p <= 10 ? 0.6 : 0.4);

function buildCalls(d) {
  if (!d.pitSamples) prepAnalysis(d);
  const calls = [];
  const C = (n) => { const x = d.drivers.get(n); return x ? `<b style="color:${x.colour}">${x.code}</b>` : `#${n}`; };
  const code = (n) => d.drivers.get(n)?.code ?? String(n);
  const posAt = (n, t) => at(d.position.get(n), t)?.pos ?? 99;
  const lapOf = (n, t) => (d.laps.get(n) ? at(d.laps.get(n), t)?.n ?? 0 : 0);
  const leaderTs = d.leaderLaps.map((l) => l.t);
  const leaderLap = (t) => d.leaderLaps[lastIdx(leaderTs, t)]?.n ?? 0;
  const statusOf = (t) => at(d.status, t)?.s || 'PRE';
  const pitsOf = (n) => d.pits.rows.filter((p) => p.num === n);
  const pittedBetween = (n, t0, t1) => pitsOf(n).some((p) => p.t >= t0 - 5000 && p.t <= t1);
  const add = (c) => {
    c.lap = leaderLap(c.t);
    c.score = c.imp * posWeight(Math.min(...c.drivers.map((n) => posAt(n, c.t))));
    c.id = calls.length;
    calls.push(c);
  };
  // just the order, gaps and who's still running - the full board (sectors,
  // tyres, best laps) for every lap end made a late-race rebuild take ~70 ms
  const finished = d.status.rows.some((x) => x.s === 'FINISH');
  const lightBoard = (t) => {
    const rows = [];
    for (const [n, drv] of d.drivers) {
      const pos = at(d.position.get(n), t)?.pos ?? d.grid.get(n) ?? 99;
      const gap = at(d.intervals.get(n), t)?.gap;
      let out;
      if (d.location.size) {
        const L = d.location.get(n), tOut = finished ? Math.min(t, d.finish + 60_000) : t;
        out = tOut > d.lightsOut && (!L || !carXY(L, tOut));
      } else {
        const s = d.laps.get(n);
        const lastStart = s ? at(s, t)?.t ?? -Infinity : -Infinity;
        const lastEnd = s ? s.endTs[lastIdx(s.endTs, t)] ?? -Infinity : -Infinity;
        out = t > d.lightsOut + 240_000 && t - Math.max(lastStart, lastEnd) > 240_000;
      }
      rows.push({ n, drv, pos, gap, out });
    }
    const g = (r) => (typeof r.gap === 'number' ? r.gap : Infinity);
    return rows.sort((a, b) => (a.out - b.out) || (a.pos - b.pos) || (g(a) - g(b)) || (a.n - b.n));
  };
  const boardCache = new Map();
  const fieldAtT = (t) => {
    if (!boardCache.has(t)) boardCache.set(t, fieldAt(d, t, lightBoard(t)));
    return boardCache.get(t);
  };

  // fresh-tyre gain: how much quicker a car runs right after a stop than just
  // before it, from this race's completed stops (only those visible at t)
  // Measured relative to the field's lap time on the same lap, so a drying
  // track or fuel burn-off doesn't get counted as tyre gain.
  const byLap = new Map();
  for (const [, c] of d.clean) for (const l of c.rows) { if (!byLap.has(l.n)) byLap.set(l.n, []); byLap.get(l.n).push(l.dur); }
  const fieldLap = new Map([...byLap].map(([k, xs]) => [k, median(xs)]));
  const rel = (l) => l.dur - (fieldLap.get(l.n) ?? l.dur);
  const greenStop = new Set(d.pitSamples.filter((s) => s.kind === 'green').map((s) => `${s.num}:${s.lap}`));
  const freshSamples = [];
  for (const p of d.pits.rows) {
    const c = d.clean.get(p.num);
    if (!c || !greenStop.has(`${p.num}:${p.lap}`)) continue;
    const before = c.rows.filter((l) => l.n < p.lap && l.n >= p.lap - 5).slice(-3);
    const after = c.rows.filter((l) => l.n > p.lap + 1 && l.n <= p.lap + 5).slice(0, 2);
    if (before.length < 2 || after.length < 2) continue;
    freshSamples.push({ avail: after.at(-1).end, gain: median(before.map(rel)) - median(after.map(rel)) });
  }
  d.freshSamples = freshSamples;
  const freshPrior = (d.priors?.fresh || []).filter((g) => g > 0 && g < 5);
  const freshGainAt = (t) => {
    const xs = freshSamples.filter((s) => s.avail <= t).map((s) => s.gain).filter((g) => g > 0 && g < 5);
    if (xs.length >= POOL_UNTIL || (xs.length >= 2 && freshPrior.length < 3)) return { gain: median(xs), n: xs.length };
    if (freshPrior.length >= 3) return { gain: median([...freshPrior, ...xs]), n: xs.length + freshPrior.length };
    return null;
  };

  // ---------- battles and undercuts: evaluated each time a car completes a lap
  const lapEnds = [];
  for (const [n, s] of d.laps) for (const l of s.ends) lapEnds.push({ n, l });
  lapEnds.sort((a, b) => a.l.end - b.l.end);
  const drs = new Map(), last = new Map();
  const cooled = (kind, key, lap) => {
    const k = `${kind}:${key}`, prev = last.get(k);
    if (prev != null && lap - prev < CALL.COOLDOWN_LAPS[kind]) return false;
    last.set(k, lap); return true;
  };

  for (const { n, l } of lapEnds) {
    const t = l.end + 1;
    if (t < d.lightsOut + 120_000 || statusOf(t) !== 'GREEN') { drs.clear(); continue; }
    const field = fieldAtT(t);
    const i = field.findIndex((f) => f.n === n);
    if (i <= 0 || field[i].gap == null || field[i - 1].gap == null) continue;
    const a = field[i - 1].n, gap = field[i].gap - field[i - 1].gap;
    if (gap < 0) continue;
    const key = `${n}>${a}`;
    const lapsLeft = d.totalLaps - l.n;

    // DRS fight: under 1.0 s on two laps running; clears above 1.2 s
    const st = drs.get(key) || { under: 0, active: false };
    if (gap < CALL.DRS_UNDER) st.under++;
    else if (gap > CALL.DRS_CLEAR) { st.under = 0; st.active = false; }
    if (st.under >= 2 && !st.active && cooled('drs', key, l.n)) {
      st.active = true;
      add({ t, type: 'battle', kind: 'drs', imp: IMP.drs, drivers: [n, a], board: '+' + gap.toFixed(1),
        text: `${C(n)} is in DRS range of ${C(a)}, ${gap.toFixed(2)}s behind.` });
    }
    drs.set(key, st);

    // Catch: clearly faster, and the projection lands inside the next few laps
    const b = battleAt(d, t, n, a);
    const recent = (p) => p && p.laps.length >= 3 && p.laps[0].n >= l.n - 7; // pace from the last few laps only
    const sinceStop = (x) => Math.min(...pitsOf(x).filter((p) => p.t <= t).map((p) => l.n - p.lap), 99);
    const h = b.hist || [];
    const closing = h.length >= 4 ? (h.at(-4).gap - h.at(-1).gap) / 3 : null; // observed, last 3 laps
    if (!b.nodata && b.B === n && b.delta != null && b.delta > CALL.CATCH_MIN_DELTA && b.delta < CALL.CATCH_MAX_DELTA
        && closing != null && closing > CALL.CATCH_MIN_DELTA && h.slice(-4).every((x) => x.green)
        && gap > CALL.CATCH_TARGET + 0.3 && recent(b.pA) && recent(b.pB) && sinceStop(n) >= 4 && sinceStop(a) >= 4 && l.n >= 6) {
      const rate = Math.min(b.delta, closing);
      const byLap = l.n + Math.ceil((gap - CALL.CATCH_TARGET) / rate);
      if (byLap - l.n <= CALL.CATCH_MAX_LAPS && byLap <= d.totalLaps && cooled('catch', key, l.n)) {
        add({ t, type: 'battle', kind: 'catch', imp: IMP.catch, drivers: [n, a], board: 'L' + byLap,
          text: `${C(n)} is closing on ${C(a)} by ${rate.toFixed(2)}s a lap and is ${gap.toFixed(1)}s behind. At this rate he's within ${CALL.CATCH_TARGET === 1 ? 'a second' : CALL.CATCH_TARGET.toFixed(1) + 's'} of him by lap ${byLap}.`,
          pred: { kind: 'catch', chaser: n, target: a, by: byLap } });
      }
    }

    // Undercut: close enough that the time new tyres are worth here covers the gap
    const fg = freshGainAt(t);
    // tyre age straight from stints and stops (a full boardAt per lap was the slow part)
    const tyreAge = (x) => {
      const cur = at(d.laps.get(x), t)?.n ?? 0;
      const st = (d.stints.get(x) || []).filter((z) => z.lap_start <= cur).at(-1);
      if (!st) return 0;
      const lastPit = pitsOf(x).filter((p) => p.t <= t && p.lap >= st.lap_start && p.lap < cur).at(-1);
      return lastPit ? cur - (lastPit.lap + 1) : (st.tyre_age_at_start ?? 0) + cur - st.lap_start;
    };
    const stintLens = [];
    for (const [x] of d.drivers) {
      let prev = 1;
      for (const p of pitsOf(x)) { if (p.t > t) break; if (p.lap - prev >= 5) stintLens.push(p.lap - prev); prev = p.lap; }
    }
    const winAge = Math.max(CALL.UNDERCUT_MIN_TYRE_AGE, (median(stintLens) ?? 99) * CALL.STINT_SHARE);
    if (fg && stintLens.length >= 3 && lapsLeft > 5 && gap > 0.2 && gap + CALL.UNDERCUT_MARGIN < fg.gain && field[i].r.pos <= 12
        && tyreAge(n) >= winAge && tyreAge(a) >= winAge
        && cooled('undercut', String(n), l.n)) {
      add({ t, type: 'strategy', kind: 'undercut', imp: IMP.undercut, drivers: [n, a], board: 'BOX',
        text: `Undercut is on for ${C(n)} against ${C(a)}: ${gap.toFixed(1)}s behind, and new tyres have been worth ${fg.gain.toFixed(1)}s a lap here. If ${code(n)} stops first he should come out ahead.`,
        pred: { kind: 'undercut', chaser: n, target: a, lap: l.n } });
    }
  }

  // ---------- pit outcomes: called when the out-lap is done; also checks the
  // rejoin position we would have predicted at pit entry
  for (const p of d.pits.rows) {
    const out = d.lapNo.get(p.num)?.get(p.lap + 1);
    if (!out?.end || p.t < d.lightsOut) continue;
    const t = out.end + 1;
    const before = posAt(p.num, p.t - 2000), after = posAt(p.num, t);
    const tEntry = p.t - 2000;
    const neutral = ['SC', 'VSC', 'SC_IN', 'VSC_END'].includes(statusOf(tEntry));
    const lossNow = pitLossAt(d, tEntry, neutral ? 'neutral' : 'green');
    const r = lossNow && rejoinAt(d, tEntry, p.num, fieldAtT(tEntry), lossNow.loss);
    const cost = p.loss != null ? `lost ${p.loss.toFixed(1)}s` : `${p.lane ? p.lane.toFixed(1) + 's in the lane' : 'stopped'}`;
    const others = d.pits.rows.filter((q) => q.num !== p.num && Math.abs(q.lap - p.lap) <= 1).length;
    add({ t, type: 'strategy', kind: 'pit', imp: IMP.pit, drivers: [p.num], board: 'P' + after,
      text: `${C(p.num)} pitted from P${before}: ${cost}, back out in P${after}.${r ? ` We predicted P${r.pos}.` : ''}`,
      pred: r ? { kind: 'rejoin', predicted: r.pos, actual: after, settled: t,
        voidWhy: p.lap <= 5 ? 'Not scored: opening laps' : others >= 4 ? `Not scored: ${others} other cars pitted around the same time` : null } : null });
  }

  // ---------- track status: neutralisations come with a free-stop list
  for (let k = 1; k < d.status.rows.length; k++) {
    const { t, s } = d.status.rows[k], prev = d.status.rows[k - 1].s;
    if ((s === 'SC' || s === 'VSC') && prev !== s) {
      const loss = pitLossAt(d, t, 'neutral'), green = pitLossAt(d, t, 'green');
      const field = fieldAtT(t).filter((f) => f.gap != null);
      const free = [];
      field.forEach((f, j) => { const nx = field[j + 1]; if (nx && loss && nx.gap - f.gap > loss.loss) free.push(f.n); });
      const name = s === 'SC' ? 'Safety car' : 'Virtual safety car';
      add({ t, type: 'status', kind: 'free', imp: IMP.free, board: s, drivers: free.length ? free.slice(0, 3) : [field[0]?.n].filter(Boolean),
        text: `${name}. A stop now costs about ${loss ? loss.loss.toFixed(0) : '?'}s${loss && !loss.measured ? ' (estimate)' : ''} instead of ${green ? green.loss.toFixed(0) : '?'}s. ` +
          (free.length ? `Free stop for ${free.map(C).join(', ')}: they would keep their places.` : 'Nobody has a big enough gap behind for a free stop.') });
    } else if (s === 'RED') {
      add({ t, type: 'status', kind: 'red', imp: IMP.red, board: 'RED', drivers: [fieldAtT(t)[0]?.n].filter(Boolean), text: 'Red flag. The session is stopped.' });
    } else if (s === 'GREEN' && ['SC', 'VSC', 'SC_IN', 'VSC_END', 'RED'].includes(prev)) {
      const f = fieldAtT(t);
      add({ t, type: 'status', kind: 'green', imp: IMP.green, board: 'GREEN', drivers: [f[0]?.n].filter(Boolean),
        text: `Green flag. Racing resumes with ${C(f[0]?.n)} leading${f[1] ? ` from ${C(f[1].n)}` : ''}.` });
    }
  }

  // ---------- stewards
  for (const r of d.rc.rows) {
    const m = (r.message || '').toUpperCase();
    if (r.t < d.lightsOut - 600_000 || !m.includes('CAR')) continue;
    const kind = /PENALTY/.test(m) && !/NO FURTHER|SERVED/.test(m) ? 'pen'
      : /UNDER INVESTIGATION|WILL BE INVESTIGATED/.test(m) ? 'inv'
      : /NO FURTHER/.test(m) ? 'nfa' : null;
    if (!kind) continue;
    const nums = [...m.matchAll(/CAR (\d+)/g)].map((x) => Number(x[1])).filter((x) => d.drivers.has(x));
    if (!nums.length) continue;
    add({ t: r.t, type: 'stewards', kind, imp: IMP[kind], board: { pen: 'PEN', inv: 'INV', nfa: 'NFA' }[kind], drivers: nums.slice(0, 2), text: tidyMsg(r.message) });
  }

  // ---------- overtakes on track: a one-place gain that holds 10 s, with
  // neither car in or near the pit lane
  const inPitWindow = (n, t) => pitsOf(n).some((p) => t >= p.t - 5000 && t <= p.t + (p.lane || 30) * 1000 + 20_000);
  for (const [n, s] of d.position) {
    for (let k = 1; k < s.rows.length; k++) {
      const { t, pos } = s.rows[k];
      if (s.rows[k - 1].pos !== pos + 1 || leaderLap(t) < 3) continue;
      if (statusOf(t) !== 'GREEN') continue;
      const loser = [...d.position.keys()].find((x) => x !== n && posAt(x, t - 500) === pos && posAt(x, t + 2000) === pos + 1);
      if (loser == null) continue;
      const tc = t + CALL.OVERTAKE_HOLD_MS;
      if (posAt(n, tc) !== pos || posAt(loser, tc) <= pos || inPitWindow(n, t) || inPitWindow(loser, t)) continue;
      const g0 = gapAt(d, n, t - 15_000), g1 = gapAt(d, loser, t - 15_000);
      if (g0 == null || g1 == null || Math.abs(g0 - g1) > CALL.PASS_MAX_GAP + 1) continue; // was close behind shortly before
      if (!cooled('pass', `${n}>${loser}`, leaderLap(t))) continue;
      add({ t: tc, type: 'battle', kind: 'pass', imp: IMP.pass, board: 'P' + pos, drivers: [n, loser], text: `${C(n)} passes ${C(loser)} for P${pos}.` });
    }
  }

  // ---------- rain
  let wet = false;
  for (const w of d.weather.rows) {
    if (!!w.rainfall !== wet) {
      wet = !!w.rainfall;
      if (w.t > d.lightsOut - 600_000) add({ t: w.t, type: 'status', kind: 'rain', imp: IMP.rain, board: wet ? 'RAIN' : 'DRY', drivers: [], text: wet ? 'Rain reported at the track.' : 'Rain has stopped.' });
    }
  }

  // one undercut call per lap: the one highest up the order
  const bestUndercut = new Map();
  for (const c of calls) if (c.kind === 'undercut') {
    const cur = bestUndercut.get(c.lap);
    if (!cur || c.score > cur.score) bestUndercut.set(c.lap, c);
  }
  for (let k = calls.length - 1; k >= 0; k--) {
    const c = calls[k];
    if (c.kind === 'undercut' && bestUndercut.get(c.lap) !== c) calls.splice(k, 1);
  }

  // ---------- settle predictions from what happened next
  for (const c of calls) {
    const p = c.pred;
    if (!p) continue;
    if (p.kind === 'rejoin') {
      p.resolvedAt = p.settled;
      if (p.voidWhy) { p.status = 'void'; p.note = p.voidWhy; continue; }
      p.status = Math.abs(p.predicted - p.actual) <= 1 ? 'hit' : 'miss';
      p.note = p.status === 'hit' ? `Rejoin call right (within one place)` : `Rejoin call off by ${Math.abs(p.predicted - p.actual)} places`;
    } else if (p.kind === 'catch') {
      const ends = d.laps.get(p.chaser)?.ends || [];
      for (const l of ends) {
        if (l.end <= c.t) continue;
        const t = l.end + 1;
        if (pittedBetween(p.chaser, c.t, t) || pittedBetween(p.target, c.t, t)) { Object.assign(p, { status: 'void', resolvedAt: t, note: 'Called off: a pit stop changed it' }); break; }
        if (statusOf(t) !== 'GREEN') { Object.assign(p, { status: 'void', resolvedAt: t, note: 'Called off: safety car' }); break; }
        const ga = gapAt(d, p.target, t), gb = gapAt(d, p.chaser, t);
        if (ga != null && gb != null && gb - ga <= CALL.CATCH_TARGET) { Object.assign(p, { status: 'hit', resolvedAt: t, note: `Came true on lap ${l.n}` }); break; }
        if (l.n >= p.by + 1) { Object.assign(p, { status: 'miss', resolvedAt: t, note: `Gap still ${(gb - ga).toFixed(1)}s on lap ${l.n}` }); break; }
      }
    } else if (p.kind === 'undercut') {
      // only judged if the chaser actually stopped first within 3 laps and the
      // target stopped within 3 laps after; then: who is ahead afterwards?
      const pc = pitsOf(p.chaser).find((x) => x.t > c.t && x.lap <= p.lap + 3);
      const pt = pc && pitsOf(p.target).find((x) => x.t > pc.t && x.lap <= pc.lap + 3);
      const done = pt && d.lapNo.get(p.target)?.get(pt.lap + 1)?.end;
      if (done) {
        const t = done + 1;
        const ahead = posAt(p.chaser, t) < posAt(p.target, t);
        Object.assign(p, { status: ahead ? 'hit' : 'miss', resolvedAt: t, note: ahead ? `${code(p.chaser)} stopped first and came out ahead` : `${code(p.chaser)} stopped first but stayed behind` });
      } else {
        const settle = (pc ? d.lapNo.get(p.chaser)?.get(pc.lap + 4)?.end : null) ?? d.lapNo.get(p.chaser)?.get(p.lap + 4)?.end;
        Object.assign(p, { status: 'void', resolvedAt: settle ?? c.t, note: pc ? `${code(p.target)} didn't respond` : `${code(p.chaser)} didn't stop` });
      }
    }
  }

  // ---------- flood control: within any 30 s, keep the three strongest calls
  // prominent; the rest are shown small
  calls.sort((a, b) => a.t - b.t);
  calls.forEach((c, i) => { c.id = i; }); // ids follow time order (used for "new" highlighting)
  for (const c of calls) {
    const near = calls.filter((x) => Math.abs(x.t - c.t) <= 20_000);
    const rank = near.filter((x) => x.score > c.score || (x.score === c.score && x.t < c.t)).length;
    c.minor = rank >= 2 || c.score < 1.0;
  }
  return calls;
}

// ---------- panel ----------
const CALL_LABEL = { battle: 'Battle', strategy: 'Strategy', status: 'Track', stewards: 'Stewards' };

function renderCalls(t) {
  const d = state.data;
  if (!d) return;
  const notRace = (typeof isQuali === 'function' && isQuali(d)) || (typeof isPractice === 'function' && isPractice(d));
  if (!d.calls) d.calls = notRace ? [] : buildCalls(d); // race calls are about races
  const sel = state.selected;
  const onlyMine = state.callsMine && sel != null;
  const shown = [];
  let hit = 0, miss = 0;
  for (const c of d.calls) {
    if (c.t > t) break;
    if (c.pred && c.pred.resolvedAt != null && c.pred.resolvedAt <= t && c.pred.status !== 'void') c.pred.status === 'hit' ? hit++ : miss++;
    if (onlyMine && !c.drivers.includes(sel) && !(state.compare != null && c.drivers.includes(state.compare))) continue;
    shown.push(c);
  }
  const visible = shown.slice(-60).reverse();
  // re-render only when the visible set, a settled outcome or the selection changed
  const settled = visible.filter((c) => c.pred && c.pred.resolvedAt <= t).length;
  const key = `${visible[0]?.id}:${visible.length}:${settled}:${sel}:${state.compare}:${onlyMine}`;
  document.querySelector('#calls-score').innerHTML = hit + miss
    ? `<b>${hit}</b> of ${hit + miss} predictions came true` : 'Predictions get scored as the race plays out';
  if (key === state.callsKey) return;
  const fresh = state.callsSeen ?? Infinity;
  state.callsKey = key;
  document.querySelector('#calls').innerHTML = visible.map((c) => {
    const mine = sel != null && c.drivers.includes(sel);
    const p = c.pred;
    let badge = '';
    if (p) {
      if (p.resolvedAt != null && p.resolvedAt <= t) {
        badge = `<span class="outcome ${p.status}">${p.status === 'hit' ? '✓ ' : p.status === 'miss' ? '✗ ' : ''}${p.note}</span>`;
      } else badge = '<span class="outcome pending">Watching</span>';
    }
    const open = p && !(p.resolvedAt != null && p.resolvedAt <= t); // a prediction still in play
    const word = (c.board || '').length > 3;
    return `<li class="call ${c.minor ? 'minor' : ''} ${mine ? 'mine' : ''} ${c.id >= fresh ? 'fresh' : ''}" data-id="${c.id}"
        style="${mine ? `--mc:${d.drivers.get(sel).colour}` : ''}">
      <span class="pitboard call-pb${open ? ' open' : ''}${word ? ' word' : ''}" aria-hidden="true">${esc(c.board || '')}</span>
      <div class="call-body">
        <div class="call-meta"><span class="call-type ${c.type}">${CALL_LABEL[c.type]}</span><span>Lap ${c.lap}</span></div>
        <div class="call-text">${c.text}</div>${badge}
      </div></li>`;
  }).join('') || `<li class="empty">${onlyMine ? 'Nothing yet involving your drivers.' : notRace ? 'Race calls run in races and sprints. Race control, pit stops and radio are in the other tabs.' : 'Calls appear here as the race unfolds.'}</li>`;
  state.callsSeen = (visible[0]?.id ?? -1) + 1;
}

document.querySelector('#calls').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const c = state.data.calls[Number(li.dataset.id)];
  if (!c?.drivers.length) return;
  state.selected = c.drivers[0];
  state.compare = c.drivers[1] ?? null;
  state.pickedAt = { n: c.drivers[0], t: performance.now() };
  state.lastPanelUpdate = 0;
});
document.querySelector('#side-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const x of document.querySelectorAll('#side-tabs button')) x.classList.toggle('on', x === b);
  for (const id of ['calls-pane', 'rc', 'pits', 'radio']) document.getElementById(id).hidden = id !== b.dataset.tab;
  if (b.dataset.tab === 'radio' && typeof renderRadio === 'function') renderRadio(true);
});
document.querySelector('#calls-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  state.callsMine = b.dataset.f === 'mine';
  for (const x of document.querySelectorAll('#calls-filter button')) x.classList.toggle('on', x === b);
  state.callsKey = null; state.lastPanelUpdate = 0;
});
