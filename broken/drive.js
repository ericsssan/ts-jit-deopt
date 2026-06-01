'use strict';

// Stage 3: drive the BROKEN hot path under the tracer.
//   node --trace-deopt --log-ic broken/drive.js   (deopts to stdout; ICs to isolate-*.log)

const { makeEvents } = require('../event-source');
const { run } = require('./handler');

const events = makeEvents(2_000_000); // big enough to tier up
let total = 0;
for (let iter = 0; iter < 20; iter++) total += run(events); // warm up + exercise hot path
console.log('checksum:', total);
