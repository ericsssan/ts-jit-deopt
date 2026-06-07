'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync }     = require('child_process');
const { pathToFileURL } = require('url');
const { isESMFile }     = require('./probe');

function buildBenchCJSDriver(fnFile, fnName, strategies, count = 20_000, iters = 40) {
  const makerCode = strategies.map(s => s.code).join('\n');
  const makerArr  = `[${strategies.map(s => s.fnName).join(', ')}]`;
  return `'use strict';
const _fn = require(${JSON.stringify(fnFile)})[${JSON.stringify(fnName)}];
if (typeof _fn !== 'function') {
  process.stderr.write('ic-fuzzer: export "' + ${JSON.stringify(fnName)} + '" is not a function\\n');
  process.exit(2);
}
${makerCode}
const _makers = ${makerArr};
const _COUNT  = ${count};
const _events = new Array(_COUNT);
for (let _i = 0; _i < _COUNT; _i++) _events[_i] = _makers[_i % _makers.length](_i);
let _acc = 0;
for (let _w = 0; _w < 5; _w++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
const _t0 = performance.now();
for (let _iter = 0; _iter < ${iters}; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('elapsed=' + (performance.now() - _t0).toFixed(3) + '\\n');
`;
}

function buildBenchESMDriver(fnFile, fnName, strategies, count = 20_000, iters = 40) {
  const makerCode = strategies.map(s => s.code).join('\n');
  const makerArr  = `[${strategies.map(s => s.fnName).join(', ')}]`;
  return `const _mod = await import(${JSON.stringify(pathToFileURL(fnFile).href)});
const _fn  = _mod[${JSON.stringify(fnName)}] ?? _mod.default?.[${JSON.stringify(fnName)}];
if (typeof _fn !== 'function') {
  process.stderr.write('ic-fuzzer: export "' + ${JSON.stringify(fnName)} + '" is not a function\\n');
  process.exit(2);
}
${makerCode}
const _makers = ${makerArr};
const _COUNT  = ${count};
const _events = new Array(_COUNT);
for (let _i = 0; _i < _COUNT; _i++) _events[_i] = _makers[_i % _makers.length](_i);
let _acc = 0;
for (let _w = 0; _w < 5; _w++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
const _t0 = performance.now();
for (let _iter = 0; _iter < ${iters}; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('elapsed=' + (performance.now() - _t0).toFixed(3) + '\\n');
`;
}

function runBenchDriver(fnFile, fnName, strategies, count, iters) {
  if (!strategies.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fuzzer-'));
  try {
    const isESM     = isESMFile(fnFile);
    const code      = isESM
      ? buildBenchESMDriver(fnFile, fnName, strategies, count, iters)
      : buildBenchCJSDriver(fnFile, fnName, strategies, count, iters);
    const filename  = isESM ? 'driver.mjs' : 'driver.js';
    const driverPath = path.join(dir, filename);
    fs.writeFileSync(driverPath, code);

    const result = spawnSync(process.execPath, [driverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) return null;
    const m = result.stdout.toString().match(/^elapsed=(\d+(?:\.\d+)?)/m);
    return m ? Number(m[1]) : null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Time the target function under two IC regimes:
 *   mono  — one canonical shape  → V8 can optimise freely
 *   mixed — all strategies mixed → V8 sees many shapes, falls back to generic code
 *
 * 5 warm-up iterations are run before timing so V8 has tiered up in both cases.
 *
 * @returns {{ monoMs: number|null, mixedMs: number|null, ratio: number|null }}
 */
function bench(fnFile, fnName, strategies, count, iters) {
  const monoMs  = runBenchDriver(fnFile, fnName, [strategies[0]], count, iters);
  const mixedMs = runBenchDriver(fnFile, fnName, strategies,        count, iters);
  const ratio   = monoMs && mixedMs && monoMs > 0 ? mixedMs / monoMs : null;
  return { monoMs, mixedMs, ratio };
}

module.exports = { bench };
