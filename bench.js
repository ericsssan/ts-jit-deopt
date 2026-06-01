'use strict';

// Stage 4: measure the win. The broken hot loop is megamorphic + un-inlinable;
// the fixed hot loop is monomorphic + inlined. The one-time boundary cost of
// toEvent() is paid before the timed loop (matching "normalize at ingestion").
//
//   node bench.js

const { makeEvents } = require('./event-source');
const { run: brokenRun } = require('./broken/handler');
const { run: fixedRun } = require('./fixed/handler');
const { toEvent } = require('./fixed/event');

const N = 2_000_000;
const raw = makeEvents(N);
const normalized = raw.map(toEvent); // one-time boundary cost

function bench(label, fn) {
  for (let i = 0; i < 5; i++) fn(); // warm up so V8 tiers up
  const t0 = process.hrtime.bigint();
  let r = 0;
  for (let i = 0; i < 20; i++) r += fn();
  const t1 = process.hrtime.bigint();
  console.log(`${label.padEnd(8)} ${(Number(t1 - t0) / 1e6).toFixed(1)}ms  (checksum ${r})`);
}

console.log(`events: ${N.toLocaleString()}, hot iterations: 20\n`);
bench('broken', () => brokenRun(raw));        // megamorphic every iteration
bench('fixed', () => fixedRun(normalized));   // monomorphic hot loop
