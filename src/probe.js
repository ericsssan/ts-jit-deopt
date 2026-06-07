'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync }      = require('child_process');
const { pathToFileURL }  = require('url');
const { parseV8Log }     = require('v8-deopt-parser');

const SEV_LABEL = { 0: 'no ICs', 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };

const IC_FLAGS = ['--log-ic', '--log-maps', '--log-code', '--log-source-code'];

// ---------------------------------------------------------------------------
// ESM detection
// ---------------------------------------------------------------------------

/**
 * Returns true if `filePath` should be treated as an ES module.
 *   .mjs → always ESM
 *   .cjs → always CJS
 *   .js  → check the nearest package.json for "type":"module"
 */
function isESMFile(filePath) {
  const ext = path.extname(filePath);
  if (ext === '.mjs') return true;
  if (ext === '.cjs') return false;

  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')).type === 'module';
      } catch { return false; }
    }
    if (dir === root) return false;
    dir = path.dirname(dir);
  }
}

// ---------------------------------------------------------------------------
// Driver builders
// ---------------------------------------------------------------------------

function buildCJSDriver(fnFile, fnName, strategies) {
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

function buildESMDriver(fnFile, fnName, strategies) {
  const makerCode = strategies.map(s => s.code).join('\n');
  const makerArr  = `[${strategies.map(s => s.fnName).join(', ')}]`;
  // Top-level await (.mjs). pathToFileURL handles Windows paths correctly.
  // Falls back to mod.default?.[fnName] for packages using `export default { fn }`.
  return `const _mod = await import(${JSON.stringify(pathToFileURL(fnFile).href)});
const _fn  = _mod[${JSON.stringify(fnName)}] ?? _mod.default?.[${JSON.stringify(fnName)}];
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

// Returns { code, filename } — filename is 'driver.mjs' for ESM, 'driver.js' for CJS.
function buildDriver(fnFile, fnName, strategies) {
  return isESMFile(fnFile)
    ? { code: buildESMDriver(fnFile, fnName, strategies), filename: 'driver.mjs' }
    : { code: buildCJSDriver(fnFile, fnName, strategies), filename: 'driver.js'  };
}

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   severity: number,
 *   ics:      object[],
 *   error:    string|null,
 *   hasICs:   boolean,
 *   crashed:  boolean,
 * }}
 */
async function probe(fnFile, fnName, strategies, watchFile) {
  if (!strategies.length) return { severity: 0, ics: [], error: null, hasICs: false, crashed: false };

  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fuzzer-'));
  const logfile = path.join(dir, 'v8.log');

  try {
    const { code, filename } = buildDriver(fnFile, fnName, strategies);
    const driverPath = path.join(dir, filename);
    fs.writeFileSync(driverPath, code);

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

    const target = watchFile || fnFile;
    const parts  = target.replace(/\\/g, '/').split('/');
    const watchSuffix = parts.slice(-2).join('/');
    const ics = (data.ics || []).filter(ic => ic.file && ic.file.includes(watchSuffix));

    const severity = ics.length ? Math.max(...ics.map(ic => ic.severity)) : 0;
    return { severity, ics, error: null, hasICs: ics.length > 0, crashed: false };

  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// validateExport()
// ---------------------------------------------------------------------------

/**
 * Validate that a file exports the named function before starting the fuzz run.
 * Returns an error string on failure, or null on success.
 * Async because ESM files must be loaded with import().
 *
 * @returns {Promise<string|null>}
 */
async function validateExport(fnFile, fnName) {
  if (isESMFile(fnFile)) {
    let mod;
    try { mod = await import(pathToFileURL(fnFile).href); } catch (e) { return e.message; }
    const fn = mod[fnName] ?? mod.default?.[fnName];
    if (typeof fn !== 'function') {
      const got = fn === undefined ? 'not exported' : `typeof ${typeof fn}`;
      return `"${fnName}" is not a function in ${fnFile} (${got})`;
    }
    return null;
  }

  let mod;
  try { mod = require(fnFile); } catch (e) { return e.message; }
  if (typeof mod[fnName] !== 'function') {
    const got = mod[fnName] === undefined ? 'not exported' : `typeof ${typeof mod[fnName]}`;
    return `"${fnName}" is not a function in ${fnFile} (${got})`;
  }
  return null;
}

module.exports = { probe, validateExport, isESMFile, SEV_LABEL };
