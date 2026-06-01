'use strict';

// Stage 3 (after fix): drive the FIXED hot path under the tracer.
//   node --trace-deopt --log-ic fixed/drive.js   (deopts to stdout; ICs to isolate-*.log)

const { makeEvents } = require('../event-source');
const { toEvent } = require('./event');
const { run } = require('./handler');

const events = makeEvents(2_000_000).map(toEvent); // normalize at the boundary, once
let total = 0;
for (let iter = 0; iter < 20; iter++) total += run(events); // hot path is now monomorphic
console.log('checksum:', total);
