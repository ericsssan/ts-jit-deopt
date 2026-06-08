#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { derive, fromCorpus }                          = require('../src/mutate');
const { validateExport, isESMFile }                   = require('../src/probe');
const { fuzz }                                        = require('../src/fuzzer');
const { bench }                                       = require('../src/bench');
const { createProgress, printInteresting, printShrinking, printResult, printBench, buildJsonResult, distinctMapCount } = require('../src/reporter');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const ASSERT_MAX_MAP = { monomorphic: 1, polymorphic: 2 };

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    file:          null,
    exportName:    null,
    seed:          null,
    corpus:        null,
    collectorFile: null,   // --collector=<file>
    target:        'megamorphic',
    rng:           undefined,
    numRuns:       200,
    count:         undefined,
    iters:         undefined,
    out:           path.resolve('ic-fuzzer-corpus.json'),
    verbose:       false,
    dryRun:        false,
    json:          false,
    watchFile:     null,
    fnFilter:      null,   // --function=<name>
    assertMax:     null,   // --assert-max=monomorphic|polymorphic
    benchMode:     false,  // --bench
    reportMaps:    false,  // --report-maps
    traceReads:    false,  // --trace-reads
    maxMaps:       null,   // --max-maps=N
  };

  for (const a of args) {
    if      (a === '--help' || a === '-h')    { usage(); process.exit(0); }
    else if (a.startsWith('--seed='))         { try { opts.seed = JSON.parse(a.slice(7)); } catch { die('--seed must be valid JSON (e.g. --seed=\'{"id":1}\')'); } }
    else if (a.startsWith('--corpus='))       { opts.corpus = path.resolve(a.slice(9)); }
    else if (a.startsWith('--collector='))    { opts.collectorFile = path.resolve(a.slice(12)); }
    else if (a.startsWith('--target='))       { opts.target = a.slice(9); }
    else if (a.startsWith('--rng='))          { opts.rng = Number(a.slice(6)); }
    else if (a.startsWith('--runs='))         { opts.numRuns = Number(a.slice(7)); }
    else if (a.startsWith('--count='))        { opts.count = Number(a.slice(8)); }
    else if (a.startsWith('--iters='))        { opts.iters = Number(a.slice(8)); }
    else if (a.startsWith('--out='))          { opts.out = path.resolve(a.slice(6)); }
    else if (a.startsWith('--watch='))        { opts.watchFile = path.resolve(a.slice(8)); }
    else if (a.startsWith('--function='))     { opts.fnFilter = a.slice(11); }
    else if (a.startsWith('--assert-max='))   { opts.assertMax = a.slice(13); }
    else if (a.startsWith('--max-maps='))     { opts.maxMaps = Number(a.slice(11)); }
    else if (a === '--bench')                 { opts.benchMode = true; }
    else if (a === '--report-maps')           { opts.reportMaps = true; }
    else if (a === '--trace-reads')           { opts.traceReads = true; }
    else if (a === '--verbose' || a === '-v') { opts.verbose = true; }
    else if (a === '--dry-run')               { opts.dryRun = true; }
    else if (a === '--json')                  { opts.json = true; }
    else if (!a.startsWith('-')) {
      if (!opts.file)            opts.file = path.resolve(a);
      else if (!opts.exportName) opts.exportName = a;
    }
  }

  return opts;
}

function die(msg) { process.stderr.write(`ic-fuzzer: ${msg}\n`); process.exit(2); }

function usage() {
  console.log(`
ic-fuzzer — discover the minimal object shapes that push a V8 inline cache to megamorphic

usage:
  ic-fuzzer <file> <export> --seed=<json>        [options]
  ic-fuzzer <file> <export> --corpus=<file.json> [options]
  ic-fuzzer <file> <export> --collector=<file>   [options]

arguments:
  file      path to the JS module exporting the function
  export    name of the exported function to fuzz

options:
  --seed=<json>            seed object to auto-derive shape mutations from
  --corpus=<file>          JSON array of real objects to use as the mutation base
  --collector=<file>       module exporting collect() → { groupName: [obj, ...] }
  --target=<severity>      megamorphic (default) or polymorphic
  --rng=<n>                reproduce a specific run (from a previous --rng= output)
  --runs=<n>               fast-check iteration cap (default: 200)
  --count=<n>              events per driver iteration (default: 20000)
  --iters=<n>              number of hot iterations (default: 40)
  --out=<file>             corpus output path (default: ic-fuzzer-corpus.json)
  --watch=<file>           report ICs from this file instead of <file>
  --function=<name>        filter ICs by function name (avoids macOS /tmp symlink issues)
  --assert-max=<severity>  gate mode: exit 0 if clean, exit 1 if any IC exceeds severity
                           severity: monomorphic | polymorphic
  --max-maps=N             gate mode: exit 1 if any IC site has more than N distinct hidden classes
  --bench                  timing mode: compare mono-shape vs mixed-shape performance
  --report-maps            show distinct hidden-class count per IC site
  --trace-reads            dry-run: show which properties the function reads from the seed
  --dry-run                list derived strategies without running
  --verbose                print driver errors (e.g. from omit strategies that crash)
  --json                   emit a single JSON result object instead of human-readable output

exit codes (default mode):
  0   megamorphism found (counterexample in corpus file)
  1   no megamorphism found
  2   error (bad arguments, file not found, etc.)

exit codes (--assert-max / --max-maps mode):
  0   clean — within the specified limit
  1   violation — limit exceeded
  2   error

examples:
  ic-fuzzer ./handler.js handleEvent --seed='{"type":"click","id":1,"value":2}'
  ic-fuzzer ./handler.js handleEvent --corpus=./prod-samples.json
  ic-fuzzer ./handler.js handleEvent --collector=./collect.js
  ic-fuzzer ./handler.js handleEvent --seed='...' --target=polymorphic
  ic-fuzzer ./handler.js handleEvent --seed='...' --rng=482910
  ic-fuzzer ./handler.js handleEvent --seed='...' --assert-max=monomorphic
  ic-fuzzer ./handler.js handleEvent --seed='...' --max-maps=4
  ic-fuzzer ./handler.js handleEvent --seed='...' --report-maps
  ic-fuzzer ./handler.js handleEvent --seed='...' --trace-reads
  ic-fuzzer ./handler.js handleEvent --seed='...' --function=handleEvent
  ic-fuzzer ./handler.js handleEvent --seed='...' --bench
`);
}

// ---------------------------------------------------------------------------
// --trace-reads: Proxy-based dry-run
// ---------------------------------------------------------------------------

async function runTraceReads(fnFile, fnName, seed, json) {
  const proxy = (obj, prefix = '') => {
    const accessed = [];
    const p = new Proxy(obj, {
      get(target, key) {
        if (typeof key === 'string') {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          accessed.push(fullKey);
          const val = target[key];
          if (val !== null && typeof val === 'object') return proxy(val, fullKey);
          return val;
        }
        return Reflect.get(target, key);
      },
    });
    return { proxy: p, accessed };
  };

  const { proxy: p, accessed } = proxy(seed);

  let fn;
  if (isESMFile(fnFile)) {
    const mod = await import(pathToFileURL(fnFile).href);
    fn = mod[fnName] ?? mod.default?.[fnName];
  } else {
    fn = require(fnFile)[fnName];
  }

  if (typeof fn !== 'function') die(`"${fnName}" is not a function in ${fnFile}`);

  try { fn(p); } catch { /* ignore — we only care about property accesses */ }

  const seedKeys   = Object.keys(seed);
  const readKeys   = [...new Set(accessed)];
  const unread     = seedKeys.filter(k => !readKeys.some(r => r === k || r.startsWith(k + '.')));

  if (json) {
    process.stdout.write(JSON.stringify({ fn: fnName, file: fnFile, reads: readKeys, unread }, null, 2) + '\n');
  } else {
    console.log(`[ic-fuzzer] trace-reads: ${fnName}  in  ${path.relative(process.cwd(), fnFile)}\n`);
    if (readKeys.length) {
      console.log(`  reads (${readKeys.length}):`);
      for (const k of readKeys) console.log(`    .${k}`);
    } else {
      console.log('  reads: (none)');
    }
    if (unread.length) {
      console.log(`\n  seed keys not read (${unread.length}):`);
      for (const k of unread) console.log(`    .${k}  (in seed but never accessed)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const opts = parseArgs(process.argv);

  if (!opts.file || !opts.exportName) { usage(); process.exit(2); }

  // --trace-reads is standalone (doesn't need seed/corpus, but seed is helpful)
  if (opts.traceReads) {
    if (!opts.seed) die('--trace-reads requires --seed=<json>');
    if (!fs.existsSync(opts.file)) die(`file not found: ${opts.file}`);
    await runTraceReads(opts.file, opts.exportName, opts.seed, opts.json);
    process.exit(0);
  }

  // One of --seed, --corpus, or --collector is required
  if (!opts.seed && !opts.corpus && !opts.collectorFile) die('one of --seed, --corpus, or --collector is required');
  if (opts.target !== 'megamorphic' && opts.target !== 'polymorphic') die('--target must be megamorphic or polymorphic');
  if (opts.assertMax && !(opts.assertMax in ASSERT_MAX_MAP)) die('--assert-max must be monomorphic or polymorphic');
  if (opts.maxMaps !== null && (isNaN(opts.maxMaps) || opts.maxMaps < 0)) die('--max-maps must be a non-negative integer');
  if (!fs.existsSync(opts.file)) die(`file not found: ${opts.file}`);
  if (opts.collectorFile && !fs.existsSync(opts.collectorFile)) die(`collector file not found: ${opts.collectorFile}`);

  // Validate that the export exists before spending time on fuzzing.
  const exportErr = await validateExport(opts.file, opts.exportName);
  if (exportErr) die(exportErr);

  // Derive strategies.
  let strategies;
  if (opts.collectorFile) {
    // Load the collector module to discover group names (strategies = group name stubs).
    let allGroups;
    if (isESMFile(opts.collectorFile)) {
      const mod = await import(pathToFileURL(opts.collectorFile).href);
      const collectFn = mod.collect ?? mod.default?.collect;
      if (typeof collectFn !== 'function') die(`collector module must export a "collect" function`);
      allGroups = await collectFn();
    } else {
      const mod = require(opts.collectorFile);
      const collectFn = typeof mod.collect === 'function' ? mod.collect : mod.default?.collect;
      if (typeof collectFn !== 'function') die(`collector module must export a "collect" function`);
      allGroups = await collectFn();
    }
    const groupNames = Object.keys(allGroups || {});
    if (!groupNames.length) die('collector returned no groups');
    // Create minimal strategy stubs so fast-check can subarray them.
    // The actual objects come from the driver; stubs carry only the name.
    strategies = groupNames.map(name => ({ name, fnName: name, code: '', desc: `group: ${name}`, sample: null }));
  } else if (opts.corpus) {
    if (!fs.existsSync(opts.corpus)) die(`corpus file not found: ${opts.corpus}`);
    const raw = JSON.parse(fs.readFileSync(opts.corpus, 'utf8'));
    strategies = fromCorpus(Array.isArray(raw) ? raw : [raw]);
  } else {
    strategies = derive(opts.seed);
  }

  const rel = p => path.relative(process.cwd(), p);

  if (!opts.json) {
    console.log(`[ic-fuzzer] ${opts.exportName}  in  ${rel(opts.file)}`);
  }

  // --dry-run: list strategies and exit.
  if (opts.dryRun) {
    if (!opts.json) {
      console.log(`[ic-fuzzer] strategies: ${strategies.length}\n`);
    }
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const sampleStr = s.sample != null ? `  →  ${JSON.stringify(s.sample)}` : '';
      console.log(`  ${String(i + 1).padStart(3)}. ${s.name.padEnd(28)}  ${s.desc}${sampleStr}`);
    }
    process.exit(0);
  }

  // --bench: timing comparison only, no IC search.
  if (opts.benchMode) {
    if (!opts.json) {
      console.log(`[ic-fuzzer] bench: strategies=${strategies.length}  count=${opts.count ?? 20000}  iters=${opts.iters ?? 40}\n`);
    }
    const benchResult = bench(opts.file, opts.exportName, strategies, opts.count, opts.iters);
    if (opts.json) {
      const fmt = ms => ms !== null ? Number(ms.toFixed(1)) : null;
      process.stdout.write(JSON.stringify({
        monoMs:  fmt(benchResult.monoMs),
        mixedMs: fmt(benchResult.mixedMs),
        ratio:   benchResult.ratio !== null ? Number(benchResult.ratio.toFixed(2)) : null,
      }, null, 2) + '\n');
    } else {
      printBench(benchResult);
    }
    process.exit(0);
  }

  // --assert-max: gate mode — inverted exit codes (0 = clean, 1 = violation).
  const assertMaxSev = opts.assertMax ? ASSERT_MAX_MAP[opts.assertMax] : null;
  const targetSev    = assertMaxSev !== null ? assertMaxSev + 1
    : opts.target === 'polymorphic' ? 2 : 3;
  const targetName   = opts.assertMax
    ? ['', 'monomorphic', 'polymorphic'][assertMaxSev + 1]
    : opts.target;

  if (!opts.json) {
    const modeLabel = opts.assertMax ? `assert-max: ${opts.assertMax}`
      : opts.maxMaps !== null       ? `max-maps: ${opts.maxMaps}`
      : `target: ${opts.target}`;
    console.log(
      `[ic-fuzzer] ${modeLabel}  |  strategies: ${strategies.length}` +
      (opts.rng !== undefined ? `  |  rng: ${opts.rng}` : '') + '\n',
    );
  }

  // Build the full reproduce command for the result footer.
  const inputFlag = opts.collectorFile ? `--collector=${rel(opts.collectorFile)}`
    : opts.corpus                      ? `--corpus=${rel(opts.corpus)}`
    : `--seed=${JSON.stringify(opts.seed)}`;
  const reproduceCmd = (rng) => `ic-fuzzer ${rel(opts.file)} ${opts.exportName} ${inputFlag} --rng=${rng}`;

  let result;
  if (opts.json) {
    result = await fuzz({
      fnFile: opts.file, fnName: opts.exportName, strategies, targetSev,
      watchFile: opts.watchFile, seed: opts.rng, numRuns: opts.numRuns,
      count: opts.count, iters: opts.iters,
      fnFilter: opts.fnFilter, collectorFile: opts.collectorFile,
      onRun({ error }) {
        if (error && opts.verbose) process.stderr.write(`[ic-fuzzer] driver: ${error}\n`);
      },
    });
    process.stdout.write(JSON.stringify(
      buildJsonResult({ ...result, target: targetName, reproduceCmd: result.found ? reproduceCmd(result.rngSeed) : null }),
      null, 2,
    ) + '\n');
  } else {
    const progress = createProgress();
    let shownShrinking = false;

    result = await fuzz({
      fnFile: opts.file, fnName: opts.exportName, strategies, targetSev,
      watchFile: opts.watchFile, seed: opts.rng, numRuns: opts.numRuns,
      count: opts.count, iters: opts.iters,
      fnFilter: opts.fnFilter, collectorFile: opts.collectorFile,
      onRun({ subset, severity, phase, error }) {
        if (error && opts.verbose) process.stderr.write(`[ic-fuzzer] driver: ${error}\n`);

        if (phase === 'shrink' && !shownShrinking) {
          progress.flush();
          shownShrinking = true;
          printShrinking();
        }

        progress.tick({ severity, phase });
        if (severity >= targetSev && phase === 'search') printInteresting({ severity, subset });
      },
    });

    progress.flush();

    printResult({
      ...result,
      targetName:   targetName,
      outPath:      opts.out,
      reproduceCmd: result.found ? reproduceCmd(result.rngSeed) : null,
      reportMaps:   opts.reportMaps,
    });

    if (assertMaxSev !== null) {
      if (result.found) {
        console.log(`\n[ic-fuzzer] FAIL — ${opts.exportName} has ICs above ${opts.assertMax} (exit 1)`);
      } else {
        console.log(`[ic-fuzzer] PASS — ${opts.exportName} stays within ${opts.assertMax} (exit 0)`);
      }
    }

    // --max-maps gate: check distinct hidden-class count across all IC sites.
    if (opts.maxMaps !== null && result.found) {
      const maxFound = Math.max(...(result.ics || []).map(distinctMapCount));
      if (maxFound > opts.maxMaps) {
        console.log(`\n[ic-fuzzer] FAIL — max distinct maps ${maxFound} exceeds --max-maps=${opts.maxMaps} (exit 1)`);
      } else {
        console.log(`[ic-fuzzer] PASS — max distinct maps ${maxFound} is within --max-maps=${opts.maxMaps} (exit 0)`);
      }
    } else if (opts.maxMaps !== null && !result.found) {
      console.log(`[ic-fuzzer] PASS — no ${targetName} found (exit 0)`);
    }
  }

  // Determine exit code.
  if (assertMaxSev !== null) {
    process.exit(result.found ? 1 : 0);
  } else if (opts.maxMaps !== null) {
    // Violation if found AND any IC site exceeds the limit.
    const maxFound = result.found ? Math.max(...(result.ics || []).map(distinctMapCount)) : 0;
    process.exit(result.found && maxFound > opts.maxMaps ? 1 : 0);
  } else {
    // Discovery mode: exit 0 = found, exit 1 = not found.
    process.exit(result.found ? 0 : 1);
  }
})();
