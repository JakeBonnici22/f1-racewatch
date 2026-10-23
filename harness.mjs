// Loads the dashboard's own code (app.js, analysis.js, calls.js) into a Node VM
// with the DOM stubbed out, so offline scripts run exactly what the page runs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const here = path.dirname(new URL(import.meta.url).pathname);

const stub = () => new Proxy(function () {}, {
  get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : stub()),
  apply: () => stub(), construct: () => stub(), set: () => true,
});

export function loadEngine() {
  const ctx = vm.createContext({
    console, Math, Date, JSON, Map, Set, Number, String, Array, Object, Promise, Symbol, Proxy,
    Float64Array, Float32Array, Infinity, NaN, isFinite, parseInt, parseFloat, RegExp, Error,
    setTimeout, performance, URLSearchParams,
    document: stub(), window: stub(), location: { search: '' },
    requestAnimationFrame: () => {}, matchMedia: () => ({ matches: true }),
    ResizeObserver: class { observe() {} }, fetch: () => new Promise(() => {}),
  });
  for (const f of ['app.js', 'analysis.js', 'calls.js']) {
    vm.runInContext(fs.readFileSync(path.join(here, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}

export function cachedRaces(year = null) {
  return JSON.parse(fs.readFileSync(path.join(here, 'data/index.json'), 'utf8'))
    .filter((s) => / Race /.test(s.label)) // races only: the live server also saves practice and qualifying
    .filter((s) => (year == null || s.year === year) && fs.existsSync(path.join(here, 'data', String(s.session_key), 'session.json')));
}

export const readSession = (s) => JSON.parse(fs.readFileSync(path.join(here, 'data', String(s.session_key), 'session.json'), 'utf8'));
