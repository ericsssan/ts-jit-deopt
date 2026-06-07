'use strict';

/**
 * Shape fuzzer — uses fast-check to discover the minimal set of structural
 * mutations that pushes V8's inline caches from monomorphic to megamorphic.
 *
 * fast-check generates random subsets of the strategy catalog, probes IC
 * severity after each, and shrinks any failing subset down to the minimal
 * set that still triggers the target severity.
 *
 * Usage:
 *   node fuzzer/run-fuzzer.js [--target=polymorphic|megamorphic] [--seed=<n>]
 *
 * Output:
 *   fuzzer/corpus.json — minimal shape set that triggered the target severity.
 */

const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseV8Log } = require('v8-deopt-parser');
const { STRATEGIES } = require('./shape-gen');

// --- config ------------------------------------------------------------------

const targetArg = process.argv.find((a) => a.startsWith('--target='));
const seedArg   = process.argv.find((a) => a.startsWith('--seed='));
const TARGET_NAME = targetArg ? targetArg.split('=')[1] : 'megamorphic';
const TARGET_SEV  = TARGET_NAME === 'polymorphic' ? 2 : 3;
const SEED        = seedArg ? Number(seedArg.split('=')[1]) : undefined;

const SEV_LABEL = { 0: 'no ICs', 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };
const WATCH     = '/handler.js';
const IGNORE    = ['node_modules', '/event.js'];
const DRIVER    = path.join(__dirname, 'fuzz-driver.js');
const CORPUS_OUT = path.join(__dirname, 'corpus.json');

// --- IC-log probe ------------------------------------------------------------

async function probe(strategyNames) {
  const logfile = path.join(os.tmpdir(), `shape-fuzzer-${process.pid}-${strategyNames.length}-${Date.now()}.v8.log`);

  const result = spawnSync(
    process.execPath,
    [
      '--log-ic', '--log-maps', '--log-code', '--log-source-code',
      `--logfile=${logfile}`, '--no-logfile-per-isolate',
      DRIVER, ...strategyNames,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  if (result.status !== 0) return { severity: 0, ics: [] };

  const content = fs.readFileSync(logfile, 'utf8');
  const origErr = console.error;
  console.error = () => {};
  let data;
  try { data = await parseV8Log(content); } finally { console.error = origErr; }
  try { fs.unlinkSync(logfile); } catch { /* best effort */ }

  const ics = (data.ics || []).filter(
    (ic) => ic.file && ic.file.includes(WATCH) && !IGNORE.some((g) => ic.file.includes(g)),
  );
  const severity = ics.length ? Math.max(...ics.map((ic) => ic.severity)) : 0;
  return { severity, ics };
}

// --- main --------------------------------------------------------------------

(async () => {
  const strategyNames = STRATEGIES.map((s) => s.name);
  const seedNote = SEED !== undefined ? `  seed: ${SEED}` : '';
  console.log(`[shape-fuzzer] target: ${TARGET_NAME}  strategies: ${STRATEGIES.length}${seedNote}\n`);

  // Each run gets a random non-empty subset of strategies.
  // fc.subarray preserves order and shrinks by removing elements — exactly
  // what we want: find the smallest subset that still triggers the target IC state.
  const arbitrary = fc.subarray(strategyNames, { minLength: 1 });

  let runCount = 0;
  let foundFirst = false;

  const fcParams = { numRuns: 200, ...(SEED !== undefined ? { seed: SEED } : {}) };

  const fcResult = await fc.check(
    fc.asyncProperty(arbitrary, async (subset) => {
      runCount++;

      if (!foundFirst) {
        process.stdout.write(`  run ${String(runCount).padStart(3)}  [${subset.join(', ')}] ... `);
      }

      const { severity } = await probe(subset);

      if (!foundFirst) {
        const label = SEV_LABEL[severity] || `sev=${severity}`;
        console.log(label);
        if (severity >= TARGET_SEV) {
          foundFirst = true;
          console.log('\n[shape-fuzzer] shrinking to minimal set...\n');
        }
      }

      return severity < TARGET_SEV;
    }),
    fcParams,
  );

  if (!fcResult.failed) {
    console.log(`\n[shape-fuzzer] no ${TARGET_NAME} found in ${runCount} runs.`);
    console.log('[shape-fuzzer] add more strategies to fuzzer/shape-gen.js and re-run.');
    process.exit(1);
  }

  // counterexample[0] is the first (and only) property argument — the minimal subset
  const minimalNames = fcResult.counterexample[0];
  const active = STRATEGIES.filter((s) => minimalNames.includes(s.name));

  console.log(`[shape-fuzzer] minimal set: ${active.length} shape(s)  (${fcResult.numShrinks} shrink steps)\n`);
  for (let i = 0; i < active.length; i++) {
    const sample = active[i].make(i);
    console.log(`  ${String(i + 1).padStart(2)}. ${active[i].name.padEnd(24)}  ${JSON.stringify(sample)}`);
    console.log(`      ${active[i].desc}`);
  }

  console.log('\n[shape-fuzzer] IC sites at target severity:');
  const { ics } = await probe(minimalNames);
  const rel = (f) => path.relative(process.cwd(), f);
  for (const ic of ics.filter((ic) => ic.severity >= TARGET_SEV)) {
    const last = ic.updates[ic.updates.length - 1] || {};
    console.log(
      `    [FAIL] ${(SEV_LABEL[ic.severity] || ic.severity).padEnd(12)} ` +
      `.${(last.key || '?').padEnd(8)} ${ic.functionName}  (${rel(ic.file)}:${ic.line}:${ic.column})`,
    );
  }

  const corpus = active.map((s, i) => ({ strategy: s.name, desc: s.desc, sample: s.make(i) }));
  fs.writeFileSync(CORPUS_OUT, JSON.stringify(corpus, null, 2));

  const reproduceSeed = fcResult.seed;
  console.log(`\n[shape-fuzzer] corpus → ${path.relative(process.cwd(), CORPUS_OUT)}`);
  console.log(`[shape-fuzzer] reproduce: npm run fuzz -- --seed=${reproduceSeed}`);
  process.exit(0);
})();
