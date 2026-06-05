#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const { derive, fromCorpus } = require('../src/mutate');
const { fuzz }               = require('../src/fuzzer');
const { printRun, printShrinking, printResult } = require('../src/reporter');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    file:       null,
    exportName: null,
    seed:       null,   // --seed='{"k":"v"}' — JSON object
    corpus:     null,   // --corpus=./file.json
    target:     'megamorphic',
    seedRng:    undefined,
    numRuns:    200,
    out:        path.resolve('ic-fuzzer-corpus.json'),
    verbose:    false,
  };

  for (const a of args) {
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('--seed='))     { try { opts.seed = JSON.parse(a.slice(7)); } catch { die('--seed must be valid JSON'); } }
    else if (a.startsWith('--corpus='))   { opts.corpus = path.resolve(a.slice(9)); }
    else if (a.startsWith('--target='))   { opts.target = a.slice(9); }
    else if (a.startsWith('--seed-rng=')) { opts.seedRng = Number(a.slice(11)); }
    else if (a.startsWith('--runs='))     { opts.numRuns = Number(a.slice(7)); }
    else if (a.startsWith('--out='))      { opts.out = path.resolve(a.slice(6)); }
    else if (a === '--verbose' || a === '-v') { opts.verbose = true; }
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
  ic-fuzzer <file> <export> --seed=<json>  [options]
  ic-fuzzer <file> <export> --corpus=<file.json>  [options]

arguments:
  file      path to the JS module that exports the function
  export    exported name of the function to fuzz

options:
  --seed=<json>        seed object to auto-derive shape mutations from
  --corpus=<file>      JSON array of objects to use as the mutation base
  --target=<severity>  megamorphic (default) or polymorphic
  --seed-rng=<n>       reproduce a specific run by RNG seed
  --runs=<n>           fast-check iteration cap (default: 200)
  --out=<file>         output path for corpus (default: ic-fuzzer-corpus.json)
  --verbose            print driver errors (e.g. from omit strategies that crash the function)

examples:
  ic-fuzzer ./handler.js handleEvent --seed='{"type":"click","id":1,"value":2}'
  ic-fuzzer ./handler.js handleEvent --corpus=./prod-samples.json
  ic-fuzzer ./handler.js handleEvent --seed='...' --target=polymorphic
  ic-fuzzer ./handler.js handleEvent --seed='...' --seed-rng=482910
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const opts = parseArgs(process.argv);

  if (!opts.file || !opts.exportName) { usage(); process.exit(2); }
  if (!opts.seed && !opts.corpus)     die('one of --seed or --corpus is required');
  if (opts.target !== 'megamorphic' && opts.target !== 'polymorphic') {
    die('--target must be megamorphic or polymorphic');
  }
  if (!fs.existsSync(opts.file)) die(`file not found: ${opts.file}`);

  const targetSev = opts.target === 'polymorphic' ? 2 : 3;

  // Derive strategies from seed or corpus
  let strategies;
  if (opts.corpus) {
    if (!fs.existsSync(opts.corpus)) die(`corpus file not found: ${opts.corpus}`);
    const raw = JSON.parse(fs.readFileSync(opts.corpus, 'utf8'));
    strategies = fromCorpus(Array.isArray(raw) ? raw : [raw]);
  } else {
    strategies = derive(opts.seed);
  }

  const rel = p => path.relative(process.cwd(), p);

  console.log(`[ic-fuzzer] ${opts.exportName}  in  ${rel(opts.file)}`);
  console.log(
    `[ic-fuzzer] target: ${opts.target}  |  strategies: ${strategies.length}` +
    (opts.seedRng !== undefined ? `  |  rng-seed: ${opts.seedRng}` : '') + '\n',
  );

  let shownShrinking = false;

  const result = await fuzz({
    fnFile:     opts.file,
    fnName:     opts.exportName,
    strategies,
    targetSev,
    seed:       opts.seedRng,
    numRuns:    opts.numRuns,
    onRun({ subset, severity, phase, error }) {
      if (error && opts.verbose) {
        process.stderr.write(`[ic-fuzzer] driver error: ${error}\n`);
      }
      if (phase === 'shrink' && !shownShrinking) {
        shownShrinking = true;
        printShrinking();
      }
      printRun({ subset, severity, phase });
    },
  });

  printResult({
    ...result,
    targetName: opts.target,
    outPath:    opts.out,
  });

  process.exit(result.found ? 1 : 0);
})();
