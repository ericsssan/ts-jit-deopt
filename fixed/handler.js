'use strict';

// Identical to broken/handler.js. The fix is NOT in this function -- it's at
// the boundary (see drive.js calling .map(toEvent)). Here `event` is always an
// Event, so these loads are monomorphic and the call site inlines.

function handleEvent(event) {
  return event.id * 31 + event.type.length + event.value;
}

function run(events) {
  let acc = 0;
  for (let i = 0; i < events.length; i++) acc += handleEvent(events[i]); // monomorphic args
  return acc;
}

module.exports = { run, handleEvent };
