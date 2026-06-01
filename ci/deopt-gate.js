'use strict';

/**
 * CI deopt-gate
 * -------------
 * Runs a driver under V8 inline-cache logging, parses the log with
 * v8-deopt-parser, and FAILS (exit 1) if any inline cache on a WATCHED hot
 * path reaches a forbidden severity (megamorphic by default). This is the
 * "deopt regression test" from Stage 6 of the article: the dynamic analog of
 * a linter, because JIT-friendliness is a runtime property.
 *
 * Why watch by FILE, not by property name:
 *   The boundary normalizer (fixed/event.js `toEvent`) legitimately reads
 *   .id/.type/.value off heterogeneous input, so it is ITSELF megamorphic --
 *   and that's fine, it's confined and runs once per event. We only gate the
 *   hot path (handler.js), so the boundary's megamorphism is ignored.
 *
 * Usage:
 *   node ci/deopt-gate.js [driver.js] [driverArgs...]
 *
 * Config via env:
 *   GATE_WATCH    comma-sep substrings a file path MUST include   (default: "/handler.js")
 *   GATE_IGNORE   comma-sep substrings to EXCLUDE                 (default: "node_modules,/event.js")
 *   GATE_MAX_SEV  fail at/above this severity, 1..3               (default: 3 = megamorphic;
 *                 use 2 to also fail on polymorphic)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseV8Log } = require('v8-deopt-parser');

const SEV_NAME = { 1: 'monomorphic', 2: 'polymorphic', 3: 'megamorphic' };

const driver = process.argv[2] || path.join(__dirname, 'gate-driver.js');
const driverArgs = process.argv.slice(3);
const WATCH = (process.env.GATE_WATCH || '/handler.js').split(',').map((s) => s.trim()).filter(Boolean);
const IGNORE = (process.env.GATE_IGNORE || 'node_modules,/event.js').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_SEV = Number(process.env.GATE_MAX_SEV || 3);

// Flags that make V8 log IC transitions + the maps/code/source needed to map
// them back to file:line. (On Node >= ~20 these are --log-* ; older V8 used
// --trace-ic etc. Adjust here if your Node version differs.)
const flags = [
  '--log-ic',
  '--log-maps',
  '--log-code',
  '--log-source-code',
];

const logfile = path.join(os.tmpdir(), `deopt-gate-${process.pid}.v8.log`);

console.log(`[deopt-gate] tracing: node ${flags.join(' ')} ${path.relative(process.cwd(), driver)} ${driverArgs.join(' ')}`.trim());
const res = spawnSync(
  process.execPath,
  [...flags, `--logfile=${logfile}`, '--no-logfile-per-isolate', driver, ...driverArgs],
  { stdio: 'inherit' },
);
if (res.status !== 0) {
  console.error('[deopt-gate] driver process failed; cannot gate.');
  process.exit(2);
}

(async () => {
  const content = fs.readFileSync(logfile, 'utf8');

  // v8-deopt-parser emits non-fatal warnings for code-state markers that newer
  // V8 versions add (e.g. "+", "*'"). They don't affect IC severity, so silence
  // them to keep CI output clean.
  const origError = console.error;
  console.error = () => {};
  let data;
  try {
    data = await parseV8Log(content);
  } finally {
    console.error = origError;
  }
  try { fs.unlinkSync(logfile); } catch { /* best effort */ }

  const isWatched = (file) =>
    WATCH.some((w) => file.includes(w)) && !IGNORE.some((g) => file.includes(g));

  const ics = (data.ics || []).filter((ic) => ic.file && isWatched(ic.file));
  ics.sort((a, b) => b.severity - a.severity);
  const violations = ics.filter((ic) => ic.severity >= MAX_SEV);

  const rel = (f) => path.relative(process.cwd(), f);
  console.log(
    `\n[deopt-gate] ${ics.length} watched IC site(s)  ` +
    `[watch=${JSON.stringify(WATCH)} ignore=${JSON.stringify(IGNORE)} fail>=${SEV_NAME[MAX_SEV]}]`,
  );
  for (const ic of ics) {
    const last = ic.updates[ic.updates.length - 1] || {};
    const mark = ic.severity >= MAX_SEV ? 'FAIL' : ' ok ';
    console.log(
      `  [${mark}] ${(SEV_NAME[ic.severity] || ic.severity).padEnd(12)} ` +
      `.${(last.key || '?').padEnd(8)} ${ic.functionName}  (${rel(ic.file)}:${ic.line}:${ic.column})`,
    );
  }

  if (violations.length) {
    console.error(
      `\n[deopt-gate] FAIL — ${violations.length} hot-path IC site(s) at >= ${SEV_NAME[MAX_SEV]}. ` +
      `Normalize the input shape at the boundary so the hot path stays monomorphic.`,
    );
    process.exit(1);
  }
  console.log(`\n[deopt-gate] PASS — no watched IC site at >= ${SEV_NAME[MAX_SEV]}.`);
})().catch((e) => {
  console.error('[deopt-gate] error:', e && e.message ? e.message : e);
  process.exit(2);
});
