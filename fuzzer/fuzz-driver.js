'use strict';

/**
 * Fuzzer driver — run under --log-ic by run-fuzzer.js.
 *
 * Generates a mixed event stream from the requested strategies, then drives
 * the hot path enough times for V8 to tier up and for inline caches to reach
 * their final state.
 *
 *   node --log-ic fuzzer/fuzz-driver.js <strategy1> [strategy2 ...]
 */

const { STRATEGIES } = require('./shape-gen');
const { handleEvent } = require('../broken/handler');

const selected = process.argv.slice(2);
if (!selected.length) {
  process.stderr.write('usage: fuzz-driver.js <strategy1> [strategy2 ...]\n');
  process.exit(1);
}

const makers = selected.map((name) => {
  const s = STRATEGIES.find((s) => s.name === name);
  if (!s) { process.stderr.write(`unknown strategy: ${name}\n`); process.exit(1); }
  return s.make;
});

const COUNT = 20_000;
const events = new Array(COUNT);
for (let i = 0; i < COUNT; i++) events[i] = makers[i % makers.length](i);

// 40 iterations over 20k events = 800k handleEvent calls.
// Enough for V8's Maglev/TurboFan to tier up and ICs to stabilize.
let acc = 0;
for (let iter = 0; iter < 40; iter++) {
  for (let i = 0; i < COUNT; i++) acc += handleEvent(events[i]);
}
process.stdout.write(`checksum=${acc}\n`);
