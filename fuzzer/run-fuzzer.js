'use strict';

/**
 * Shape fuzzer — discovers which structural mutations push the hot path from
 * monomorphic → polymorphic → megamorphic, and reports the minimal triggering set.
 *
 * How it works:
 *   1. Start with one strategy (one object shape).
 *   2. Each round, add the next strategy from the catalog.
 *   3. Spawn fuzz-driver.js under --log-ic with the active strategy set.
 *   4. Parse the IC log and check the worst severity on the hot path.
 *   5. Stop when the target severity is reached; report which shapes caused it.
 *
 * Usage:
 *   node fuzzer/run-fuzzer.js [--target polymorphic|megamorphic]
 *
 * Output:
 *   fuzzer/corpus.json — the minimal shape set that triggered the target severity.
 *   Seed this into gate-driver.js (or feed captured prod payloads instead).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseV8Log } = require('v8-deopt-parser');
const { STRATEGIES } = require('./shape-gen');

// --- config ------------------------------------------------------------------

const targetArg = process.argv.find((a) => a.startsWith('--target='));
const TARGET_NAME = targetArg ? targetArg.split('=')[1] : 'megamorphic';
const TARGET_SEV = TARGET_NAME === 'polymorphic' ? 2 : 3;
const SEV_LABEL = { 0: 'no ICs', 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };

const WATCH  = '/handler.js';          // file paths that must match
const IGNORE = ['node_modules', '/event.js']; // file paths to exclude

const DRIVER = path.join(__dirname, 'fuzz-driver.js');
const CORPUS_OUT = path.join(__dirname, 'corpus.json');

// --- IC-log runner -----------------------------------------------------------

async function probe(strategyNames) {
  const logfile = path.join(os.tmpdir(), `shape-fuzzer-${process.pid}-${strategyNames.length}.v8.log`);

  const result = spawnSync(
    process.execPath,
    [
      '--log-ic', '--log-maps', '--log-code', '--log-source-code',
      `--logfile=${logfile}`, '--no-logfile-per-isolate',
      DRIVER, ...strategyNames,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  if (result.status !== 0) {
    process.stderr.write(`[shape-fuzzer] driver failed:\n${result.stderr}\n`);
    return { severity: 0, ics: [] };
  }

  const content = fs.readFileSync(logfile, 'utf8');

  // v8-deopt-parser emits non-fatal warnings for newer V8 code-state markers;
  // suppress them so fuzzer output stays readable.
  const origErr = console.error;
  console.error = () => {};
  let data;
  try { data = await parseV8Log(content); } finally { console.error = origErr; }
  try { fs.unlinkSync(logfile); } catch { /* best effort */ }

  const ics = (data.ics || []).filter(
    (ic) => ic.file && ic.file.includes(WATCH) && !IGNORE.some((g) => ic.file.includes(g)),
  );

  const maxSev = ics.length ? Math.max(...ics.map((ic) => ic.severity)) : 0;
  return { severity: maxSev, ics };
}

// --- main loop ---------------------------------------------------------------

(async () => {
  console.log(`[shape-fuzzer] target: ${TARGET_NAME}  (${STRATEGIES.length} strategies in catalog)\n`);

  const active = [];

  for (const strategy of STRATEGIES) {
    active.push(strategy);
    const names = active.map((s) => s.name);

    process.stdout.write(
      `  round ${String(active.length).padStart(2)}  [${names.join(', ')}] ... `,
    );

    const { severity, ics } = await probe(names);
    const label = SEV_LABEL[severity] || `sev=${severity}`;
    const marker = severity >= TARGET_SEV ? ' ← STOP' : '';
    console.log(`${label}${marker}`);

    if (severity >= TARGET_SEV) {
      console.log(`\n[shape-fuzzer] ${TARGET_NAME} reached with ${active.length} shape(s):\n`);
      for (let i = 0; i < active.length; i++) {
        const sample = active[i].make(i);
        console.log(
          `  ${String(i + 1).padStart(2)}. ${active[i].name.padEnd(24)}  ${JSON.stringify(sample)}`,
        );
        console.log(`      ${active[i].desc}`);
      }

      console.log('\n[shape-fuzzer] IC sites at target severity:');
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
      console.log(`\n[shape-fuzzer] corpus written → ${path.relative(process.cwd(), CORPUS_OUT)}`);
      process.exit(0);
    }
  }

  console.log(`\n[shape-fuzzer] exhausted all ${STRATEGIES.length} strategies without reaching ${TARGET_NAME}.`);
  console.log('[shape-fuzzer] add more mutations to fuzzer/shape-gen.js and re-run.');
  process.exit(1);
})();
