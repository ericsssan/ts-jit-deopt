'use strict';

// This is the SAME hot path as fixed/handler.js -- byte for byte. The only
// difference between "broken" and "fixed" is WHAT it receives:
//   - here (broken): heterogeneous object shapes  -> MEGAMORPHIC loads
//   - fixed: a single normalized shape (Event)     -> MONOMORPHIC loads
// So any speedup is attributable purely to unifying the shape, nothing else.

function handleEvent(event) {
  return event.id * 31 + event.type.length + event.value;
}

function run(events) {
  let acc = 0;
  for (let i = 0; i < events.length; i++) acc += handleEvent(events[i]); // megamorphic args
  return acc;
}

module.exports = { run, handleEvent };
