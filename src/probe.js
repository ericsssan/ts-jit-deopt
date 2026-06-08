'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync }      = require('child_process');
const { pathToFileURL }  = require('url');
const { parseV8Log }     = require('v8-deopt-parser');

const SEV_LABEL = { 0: 'no ICs', 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };

const IC_FLAGS = ['--log-ic', '--log-deopt', '--log-maps', '--log-code', '--log-source-code'];

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
// Driver builders — strategy mode (maker functions)
// ---------------------------------------------------------------------------

function buildCJSDriver(fnFile, fnName, strategies, count = 20_000, iters = 40) {
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
for (let _iter = 0; _iter < ${iters}; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('checksum=' + _acc + '\\n');
`;
}

function buildESMDriver(fnFile, fnName, strategies, count = 20_000, iters = 40) {
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
const _COUNT  = ${count};
const _events = new Array(_COUNT);
for (let _i = 0; _i < _COUNT; _i++) _events[_i] = _makers[_i % _makers.length](_i);
let _acc = 0;
for (let _iter = 0; _iter < ${iters}; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('checksum=' + _acc + '\\n');
`;
}

// Returns { code, filename } — filename is 'driver.mjs' for ESM, 'driver.js' for CJS.
function buildDriver(fnFile, fnName, strategies, count, iters) {
  return isESMFile(fnFile)
    ? { code: buildESMDriver(fnFile, fnName, strategies, count, iters), filename: 'driver.mjs' }
    : { code: buildCJSDriver(fnFile, fnName, strategies, count, iters), filename: 'driver.js'  };
}

// ---------------------------------------------------------------------------
// Driver builders — collector mode (real objects from external module)
// ---------------------------------------------------------------------------

function buildCollectorCJSDriver(fnFile, fnName, collectorFile, groupNames, count = 20_000, iters = 40) {
  return `'use strict';
const _fn = require(${JSON.stringify(fnFile)})[${JSON.stringify(fnName)}];
if (typeof _fn !== 'function') {
  process.stderr.write('ic-fuzzer: export "' + ${JSON.stringify(fnName)} + '" is not a function\\n');
  process.exit(2);
}
const _coll = require(${JSON.stringify(collectorFile)});
const _collectFn = typeof _coll.collect === 'function' ? _coll.collect : _coll.default?.collect;
(async () => {
  const _allGroups = await _collectFn();
  const _names  = ${JSON.stringify(groupNames)};
  const _groups = _names.map(n => Array.isArray(_allGroups[n]) ? _allGroups[n] : []).filter(g => g.length > 0);
  if (!_groups.length) {
    process.stderr.write('ic-fuzzer: collector returned no objects for selected groups\\n');
    process.exit(1);
  }
  const _COUNT  = ${count};
  const _events = new Array(_COUNT);
  for (let _i = 0; _i < _COUNT; _i++) {
    const _g = _groups[_i % _groups.length];
    _events[_i] = _g[_i % _g.length];
  }
  let _acc = 0;
  for (let _iter = 0; _iter < ${iters}; _iter++) {
    for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
  }
  process.stdout.write('checksum=' + _acc + '\\n');
})();
`;
}

function buildCollectorESMDriver(fnFile, fnName, collectorFile, groupNames, count = 20_000, iters = 40) {
  const fnUrl   = pathToFileURL(fnFile).href;
  const collUrl = pathToFileURL(collectorFile).href;
  return `const _modFn  = await import(${JSON.stringify(fnUrl)});
const _fn     = _modFn[${JSON.stringify(fnName)}] ?? _modFn.default?.[${JSON.stringify(fnName)}];
if (typeof _fn !== 'function') {
  process.stderr.write('ic-fuzzer: export "' + ${JSON.stringify(fnName)} + '" is not a function\\n');
  process.exit(2);
}
const _modColl   = await import(${JSON.stringify(collUrl)});
const _collectFn = _modColl.collect ?? _modColl.default?.collect;
const _allGroups = await _collectFn();
const _names  = ${JSON.stringify(groupNames)};
const _groups = _names.map(n => Array.isArray(_allGroups[n]) ? _allGroups[n] : []).filter(g => g.length > 0);
if (!_groups.length) {
  process.stderr.write('ic-fuzzer: collector returned no objects for selected groups\\n');
  process.exit(1);
}
const _COUNT  = ${count};
const _events = new Array(_COUNT);
for (let _i = 0; _i < _COUNT; _i++) {
  const _g = _groups[_i % _groups.length];
  _events[_i] = _g[_i % _g.length];
}
let _acc = 0;
for (let _iter = 0; _iter < ${iters}; _iter++) {
  for (let _i = 0; _i < _COUNT; _i++) _acc += _fn(_events[_i]);
}
process.stdout.write('checksum=' + _acc + '\\n');
`;
}

// Use ESM driver when either the target or collector is an ES module.
function buildCollectorDriver(fnFile, fnName, collectorFile, groupNames, count, iters) {
  const useESM = isESMFile(fnFile) || isESMFile(collectorFile);
  return useESM
    ? { code: buildCollectorESMDriver(fnFile, fnName, collectorFile, groupNames, count, iters), filename: 'driver.mjs' }
    : { code: buildCollectorCJSDriver(fnFile, fnName, collectorFile, groupNames, count, iters), filename: 'driver.js'  };
}

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

/**
 * @param {string}      fnFile
 * @param {string}      fnName
 * @param {object[]}    strategies
 * @param {string}      [watchFile]      file to filter ICs by path (default: fnFile)
 * @param {number}      [count]
 * @param {number}      [iters]
 * @param {string}      [fnFilter]       filter ICs by ic.functionName instead of file path
 * @param {string}      [collectorFile]  collector module path (enables collector driver mode)
 * @param {boolean}     [noTurbofan]     add --no-opt to keep function interpreted (Ignition ICs visible)
 *
 * @returns {{
 *   severity:         number,
 *   ics:              object[],
 *   deopts:           object[],
 *   error:            string|null,
 *   hasICs:           boolean,
 *   crashed:          boolean,
 *   turbofanCompiled: boolean,
 * }}
 */
async function probe(fnFile, fnName, strategies, watchFile, count, iters, fnFilter, collectorFile, noTurbofan) {
  if (!strategies.length) return { severity: 0, ics: [], deopts: [], error: null, hasICs: false, crashed: false, turbofanCompiled: false };

  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fuzzer-'));
  const logfile = path.join(dir, 'v8.log');

  try {
    let code, filename;
    if (collectorFile) {
      const groupNames = strategies.map(s => s.name);
      ({ code, filename } = buildCollectorDriver(fnFile, fnName, collectorFile, groupNames, count, iters));
    } else {
      ({ code, filename } = buildDriver(fnFile, fnName, strategies, count, iters));
    }
    const driverPath = path.join(dir, filename);
    fs.writeFileSync(driverPath, code);

    const nodeArgs = [...IC_FLAGS, ...(noTurbofan ? ['--no-opt'] : []), `--logfile=${logfile}`, '--no-logfile-per-isolate', driverPath];
    const result = spawnSync(process.execPath, nodeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

    if (result.status !== 0) {
      return {
        severity: 0, ics: [], deopts: [], hasICs: false, crashed: true, turbofanCompiled: false,
        error: (result.stderr || '').toString().trim(),
      };
    }

    let logContent;
    try { logContent = fs.readFileSync(logfile, 'utf8'); } catch {
      return { severity: 0, ics: [], deopts: [], error: 'log file not written', hasICs: false, crashed: false, turbofanCompiled: false };
    }

    const origErr = console.error;
    console.error = () => {};
    let data;
    try { data = await parseV8Log(logContent); } finally { console.error = origErr; }

    // Compute target path/URL once for IC and deopt filtering.
    const _target     = watchFile || fnFile;
    const _targetPath = path.resolve(_target);
    const _targetUrl  = pathToFileURL(_targetPath).href;
    const _matchesFile = (entry) => entry.file === _targetPath || entry.file === _targetUrl;

    const _matchesWatch = watchFile
      ? (entry) => {
          const wp = path.resolve(watchFile);
          const wu = pathToFileURL(wp).href;
          return entry.file === wp || entry.file === wu;
        }
      : () => true;

    function filterEntries(list) {
      if (fnFilter) {
        return list.filter(e => e.functionName === fnFilter && _matchesWatch(e));
      }
      return list.filter(e => _matchesFile(e));
    }

    const ics   = filterEntries(data.ics   || []);
    const deopts = filterEntries(data.deopts || []);

    // Turbofan-compiled functions emit IC updates with newState === 'no_feedback' (X).
    // These have severity -1 (UNKNOWN_SEVERITY) and don't represent observable IC state.
    const turbofanCompiled = ics.some(ic => (ic.updates || []).some(u => u.newState === 'no_feedback'));
    // hasICs = at least one IC site with meaningful severity (1 = mono, 2 = poly, 3 = mega).
    const hasICs   = ics.some(ic => ic.severity >= 1);
    const severity = hasICs ? Math.max(...ics.filter(ic => ic.severity >= 1).map(ic => ic.severity)) : 0;

    return { severity, ics, deopts, error: null, hasICs, crashed: false, turbofanCompiled };

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
