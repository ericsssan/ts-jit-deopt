'use strict';

/** Canonical shape: ONE hidden class for every event. */
class Event {
  constructor(type, id, value) {
    this.type = type;   // always string
    this.id = id;       // always number
    this.value = value; // always number
  }
}

/**
 * The ONLY place a raw event becomes an Event. Runs once per event at the
 * ingestion boundary -- the megamorphic reads are CONFINED here, out of the
 * hot path. You don't eliminate the megamorphic access; you pay it once.
 */
function toEvent(raw) {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const rid = raw.id;
  const id = rid == null ? 0 : typeof rid === 'string' ? rid.length : rid;
  const value = typeof raw.value === 'number' ? raw.value : 0;
  return new Event(type, id, value); // every instance shares ONE map
}

module.exports = { Event, toEvent };
