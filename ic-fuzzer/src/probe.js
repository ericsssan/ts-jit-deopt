'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync }  = require('child_process');
const { parseV8Log } = require('v8-deopt-parser');

const SEV_LABEL = { 0: 'no ICs', 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };

const IC_FLAGS = ['--log-ic', '--log-maps', '--log-code', '--log-source-code'];

function buildDriver(fnFile, fnName, strategies) {
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
const _COUNT  = 20_000;
const _events = new Array(_COUNT);
for (let _i = 0; _i < _COUNT; _i++) _events[_i] = _makers[_i % _makers.length](_i);
let _acc = 0;
for (let _iter = 0; _iter < 40; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('checksum=' + _acc + '\\n');
`;
}

/**
 * @returns {{
 *   severity: number,   // 0–3: no-ICs / mono / poly / mega
 *   ics:      object[], // IC entries from the watched file
 *   error:    string|null,
 *   hasICs:   boolean,  // whether the watched file had any IC entries at all
 *   crashed:  boolean,  // whether the driver process exited non-zero
 * }}
 */
async function probe(fnFile, fnName, strategies, watchFile) {
  if (!strategies.length) return { severity: 0, ics: [], error: null, hasICs: false, crashed: false };

  const dir        = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fuzzer-'));
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
      return {
        severity: 0, ics: [], hasICs: false, crashed: true,
        error: (result.stderr || '').toString().trim(),
      };
    }

    let logContent;
    try { logContent = fs.readFileSync(logfile, 'utf8'); } catch {
      return { severity: 0, ics: [], error: 'log file not written', hasICs: false, crashed: false };
    }

    const origErr = console.error;
    console.error = () => {};
    let data;
    try { data = await parseV8Log(logContent); } finally { console.error = origErr; }

    // Use last 2 path segments for matching (e.g. "eslint-utils/index.js") to avoid
    // false positives with common names like index.js while still working for node_modules targets.
    const target = watchFile || fnFile;
    const parts = target.replace(/\\/g, '/').split('/');
    const watchSuffix = parts.slice(-2).join('/');
    const ics = (data.ics || []).filter(
      ic => ic.file && ic.file.includes(watchSuffix),
    );

    const severity = ics.length ? Math.max(...ics.map(ic => ic.severity)) : 0;
    return { severity, ics, error: null, hasICs: ics.length > 0, crashed: false };

  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Validate that a file exports the named function before starting the fuzz run.
function validateExport(fnFile, fnName) {
  let mod;
  try { mod = require(fnFile); } catch (e) { return e.message; }
  if (typeof mod[fnName] !== 'function') {
    const got = mod[fnName] === undefined ? 'not exported' : `typeof ${typeof mod[fnName]}`;
    return `"${fnName}" is not a function in ${fnFile} (${got})`;
  }
  return null; // ok
}

module.exports = { probe, validateExport, SEV_LABEL };
