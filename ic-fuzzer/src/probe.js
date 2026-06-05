'use strict';

/**
 * Generates a self-contained driver file for a given function + strategy set,
 * runs it under --log-ic, and returns the worst IC severity observed on the
 * target function's call sites.
 *
 * Each call writes a temp directory, runs a subprocess, reads the log, and
 * cleans up — no shared state between calls.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync }  = require('child_process');
const { parseV8Log } = require('v8-deopt-parser');

const SEV_LABEL = { 0: 'no ICs', 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };

// V8 flag names changed across Node versions.
// --log-ic landed in Node 12 / V8 8.x alongside the unified logging system.
// All supported Node versions (>=20) use --log-ic.
const IC_FLAGS = [
  '--log-ic',
  '--log-maps',
  '--log-code',
  '--log-source-code',
];

/**
 * Build a complete, self-contained driver script as a string.
 *
 * The driver:
 *   1. Imports the user's function by absolute path.
 *   2. Has each strategy's maker function inlined as JS source.
 *   3. Builds a mixed event array and drives the function for enough
 *      iterations that V8 tiers up and ICs reach their final state.
 */
function buildDriver(fnFile, fnName, strategies) {
  const makerCode = strategies.map(s => s.code).join('\n');
  const makerArr  = `[${strategies.map(s => s.fnName).join(', ')}]`;

  return `'use strict';
// ic-fuzzer generated driver — do not edit
const _fn = require(${JSON.stringify(fnFile)})[${JSON.stringify(fnName)}];
if (typeof _fn !== 'function') {
  process.stderr.write('ic-fuzzer: ' + ${JSON.stringify(fnName)} + ' is not a function in ' + ${JSON.stringify(fnFile)} + '\\n');
  process.exit(2);
}

${makerCode}

const _makers = ${makerArr};
const _COUNT  = 20_000;
const _events = new Array(_COUNT);
for (let _i = 0; _i < _COUNT; _i++) _events[_i] = _makers[_i % _makers.length](_i);

// 40 passes over 20k events = 800k calls — enough for Maglev/TurboFan to tier
// up and for inline caches to reach their stable state.
let _acc = 0;
for (let _iter = 0; _iter < 40; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('checksum=' + _acc + '\\n');
`;
}

/**
 * Run a probe: generate driver → subprocess under --log-ic → parse IC log.
 *
 * @param {string}   fnFile      absolute path to the module exporting the function
 * @param {string}   fnName      exported name of the function to watch
 * @param {object[]} strategies  array of { name, code, fnName } from mutate.js
 * @returns {{ severity: number, ics: object[], error: string|null }}
 */
async function probe(fnFile, fnName, strategies) {
  if (!strategies.length) return { severity: 0, ics: [], error: null };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fuzzer-'));
  const driverPath = path.join(dir, 'driver.js');
  const logfile    = path.join(dir, 'v8.log');

  try {
    fs.writeFileSync(driverPath, buildDriver(fnFile, fnName, strategies));

    const result = spawnSync(
      process.execPath,
      [...IC_FLAGS, `--logfile=${logfile}`, '--no-logfile-per-isolate', driverPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    if (result.status !== 0) {
      return { severity: 0, ics: [], error: (result.stderr || '').toString().trim() };
    }

    let logContent;
    try { logContent = fs.readFileSync(logfile, 'utf8'); } catch {
      return { severity: 0, ics: [], error: 'log file not written' };
    }

    // v8-deopt-parser emits non-fatal warnings for code-state markers added in
    // newer V8 versions. Suppress them so fuzzer output stays clean.
    const origErr = console.error;
    console.error = () => {};
    let data;
    try { data = await parseV8Log(logContent); } finally { console.error = origErr; }

    // Watch the target file; ignore node_modules and any other library paths.
    const watchBase = path.basename(fnFile);
    const ics = (data.ics || []).filter(
      ic => ic.file && ic.file.includes(watchBase) && !ic.file.includes('node_modules'),
    );

    const severity = ics.length ? Math.max(...ics.map(ic => ic.severity)) : 0;
    return { severity, ics, error: null };

  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { probe, SEV_LABEL };
