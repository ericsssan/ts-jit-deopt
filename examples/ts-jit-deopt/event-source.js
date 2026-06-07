'use strict';

/**
 * Heterogeneous event source. Every event has the SAME fields with the SAME
 * value types (type:string, id:number, value:number) -- the ONLY thing that
 * varies is the hidden class (object shape). That deliberately isolates the
 * cost of *shape megamorphism* from unrelated issues like type instability,
 * so the speedup in this demo is 100% attributable to unifying the shape.
 *
 * (In a real service the variety comes from different producers / JSON
 * deserialization order / optional fields -- reproduced here on purpose.)
 */
function makeEvents(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    switch (i % 5) {
      case 0: // canonical order
        events.push({ type: 'click', id: i, value: i * 2 });
        break;
      case 1: // extra `meta` field -> a DIFFERENT hidden class
        events.push({ type: 'view', id: i, value: i * 2, meta: 1 });
        break;
      case 2: // different property ORDER -> different hidden class
        events.push({ id: i, value: i * 2, type: 'hover' });
        break;
      case 3: { // built incrementally -> different transition path -> different shape
        const e = {};
        e.id = i;
        e.type = 'scroll';
        e.value = i * 2;
        events.push(e);
        break;
      }
      case 4: // yet another order + a different extra field
        events.push({ value: i * 2, type: 'key', id: i, tag: 7 });
        break;
    }
  }
  return events;
}

module.exports = { makeEvents };
