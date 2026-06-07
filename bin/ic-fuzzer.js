#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const { derive, fromCorpus }                          = require('../src/mutate');
const { validateExport }                              = require('../src/probe');
const { fuzz }                                        = require('../src/fuzzer');
const { createProgress, printInteresting, printShrinking, printResult, buildJsonResult } = require('../src/reporter');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    file:       null,
    exportName: null,
    seed:       null,
    corpus:     null,
    target:     'megamorphic',
    rng:        undefined,  // renamed from --seed-rng
    numRuns:    200,
    out:        path.resolve('ic-fuzzer-corpus.json'),
    verbose:    false,
    dryRun:     false,
    json:       false,
    watchFile:  null,
  };

  for (const a of args) {
    if      (a === '--help' || a === '-h')  { usage(); process.exit(0); }
    else if (a.startsWith('--seed='))       { try { opts.seed = JSON.parse(a.slice(7)); } catch { die('--seed must be valid JSON (e.g. --seed=\'{"id":1}\')'); } }
    else if (a.startsWith('--corpus='))     { opts.corpus = path.resolve(a.slice(9)); }
    else if (a.startsWith('--target='))     { opts.target = a.slice(9); }
    else if (a.startsWith('--rng='))        { opts.rng = Number(a.slice(6)); }
    else if (a.startsWith('--runs='))       { opts.numRuns = Number(a.slice(7)); }
    else if (a.startsWith('--out='))        { opts.out = path.resolve(a.slice(6)); }
    else if (a.startsWith('--watch='))      { opts.watchFile = path.resolve(a.slice(8)); }
    else if (a === '--verbose' || a === '-v') { opts.verbose = true; }
    else if (a === '--dry-run')             { opts.dryRun = true; }
    else if (a === '--json')               { opts.json = true; }
    else if (!a.startsWith('-')) {
      if (!opts.file)       opts.file = path.resolve(a);
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
  ic-fuzzer <file> <export> --seed=<json>       [options]
  ic-fuzzer <file> <export> --corpus=<file.json> [options]

arguments:
  file      path to the JS module exporting the function
  export    name of the exported function to fuzz

options:
  --seed=<json>        seed object to auto-derive shape mutations from
  --corpus=<file>      JSON array of real objects to use as the mutation base
  --target=<severity>  megamorphic (default) or polymorphic
  --rng=<n>            reproduce a specific run (from a previous --rng= output)
  --runs=<n>           fast-check iteration cap (default: 200)
  --out=<file>         corpus output path (default: ic-fuzzer-corpus.json)
  --watch=<file>       report ICs from this file instead of <file> (use for thin wrappers)
  --dry-run            list derived strategies without running
  --verbose            print driver errors (e.g. from omit strategies that crash)
  --json               emit a single JSON result object instead of human-readable output

exit codes:
  0   megamorphism found (counterexample in corpus file)
  1   no megamorphism found
  2   error (bad arguments, file not found, etc.)

examples:
  ic-fuzzer ./handler.js handleEvent --seed='{"type":"click","id":1,"value":2}'
  ic-fuzzer ./handler.js handleEvent --corpus=./prod-samples.json
  ic-fuzzer ./handler.js handleEvent --seed='...' --target=polymorphic
  ic-fuzzer ./handler.js handleEvent --seed='...' --rng=482910
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const opts = parseArgs(process.argv);

  if (!opts.file || !opts.exportName) { usage(); process.exit(2); }
  if (!opts.seed && !opts.corpus)     die('one of --seed or --corpus is required');
  if (opts.target !== 'megamorphic' && opts.target !== 'polymorphic') die('--target must be megamorphic or polymorphic');
  if (!fs.existsSync(opts.file))      die(`file not found: ${opts.file}`);

  const targetSev = opts.target === 'polymorphic' ? 2 : 3;

  // Validate that the export exists before spending time on fuzzing.
  const exportErr = await validateExport(opts.file, opts.exportName);
  if (exportErr) die(exportErr);

  // Derive strategies.
  let strategies;
  if (opts.corpus) {
    if (!fs.existsSync(opts.corpus)) die(`corpus file not found: ${opts.corpus}`);
    const raw = JSON.parse(fs.readFileSync(opts.corpus, 'utf8'));
    strategies = fromCorpus(Array.isArray(raw) ? raw : [raw]);
  } else {
    strategies = derive(opts.seed);
  }

  const rel = p => path.relative(process.cwd(), p);

  if (!opts.json) {
    console.log(`[ic-fuzzer] ${opts.exportName}  in  ${rel(opts.file)}`);
    console.log(
      `[ic-fuzzer] target: ${opts.target}  |  strategies: ${strategies.length}` +
      (opts.rng !== undefined ? `  |  rng: ${opts.rng}` : '') + '\n',
    );
  }

  // --dry-run: list strategies and exit.
  if (opts.dryRun) {
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const sampleStr = s.sample != null ? `  →  ${JSON.stringify(s.sample)}` : '';
      console.log(`  ${String(i + 1).padStart(3)}. ${s.name.padEnd(28)}  ${s.desc}${sampleStr}`);
    }
    process.exit(0);
  }

  // Build the full reproduce command for the result footer.
  const inputFlag    = opts.corpus ? `--corpus=${rel(opts.corpus)}` : `--seed=${JSON.stringify(opts.seed)}`;
  const reproduceCmd = (rng) => `ic-fuzzer ${rel(opts.file)} ${opts.exportName} ${inputFlag} --rng=${rng}`;

  let result;
  if (opts.json) {
    result = await fuzz({
      fnFile: opts.file, fnName: opts.exportName, strategies, targetSev,
      watchFile: opts.watchFile, seed: opts.rng, numRuns: opts.numRuns,
      onRun({ error }) {
        if (error && opts.verbose) process.stderr.write(`[ic-fuzzer] driver: ${error}\n`);
      },
    });
    process.stdout.write(JSON.stringify(
      buildJsonResult({ ...result, target: opts.target, reproduceCmd: result.found ? reproduceCmd(result.rngSeed) : null }),
      null, 2,
    ) + '\n');
  } else {
    const progress = createProgress();
    let shownShrinking = false;

    result = await fuzz({
      fnFile: opts.file, fnName: opts.exportName, strategies, targetSev,
      watchFile: opts.watchFile, seed: opts.rng, numRuns: opts.numRuns,
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
      targetName:   opts.target,
      outPath:      opts.out,
      reproduceCmd: result.found ? reproduceCmd(result.rngSeed) : null,
    });
  }

  // Exit 0 = found (success for a discovery tool), 1 = not found, 2 = error (set above).
  process.exit(result.found ? 0 : 1);
})();
