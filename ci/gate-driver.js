'use strict';

// Lightweight driver for the CI deopt-gate. Replays a representative corpus
// through the hot path so V8 tiers up and the inline caches reach their final
// state. In a real repo this would replay CAPTURED PRODUCTION PAYLOADS
// (see Stage 2 of the article) instead of synthesized events.
//
//   node ci/gate-driver.js [broken|fixed] [eventCount]
//
// Default is "fixed" (the path that should PASS the gate). Pass "broken" to
// demonstrate the gate catching a megamorphic regression.

const variant = process.argv[2] === 'broken' ? 'broken' : 'fixed';
const count = Number(process.argv[3]) || 50000;

const { makeEvents } = require('../event-source');
const { toEvent } = require('../fixed/event');
const { run } = require(variant === 'broken' ? '../broken/handler' : '../fixed/handler');

const raw = makeEvents(count);
const events = variant === 'broken' ? raw : raw.map(toEvent); // fixed normalizes at the boundary

let acc = 0;
for (let i = 0; i < 40; i++) acc += run(events); // warm up + exercise to force tier-up
process.stdout.write(`[gate-driver] variant=${variant} events=${count} checksum=${acc}\n`);
