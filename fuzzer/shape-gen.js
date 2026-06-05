'use strict';

/**
 * Shape mutation strategies.
 *
 * Each strategy produces objects with the same logical content
 * (type:string, id:number, value:number) but potentially a different
 * V8 hidden class. The fuzzer adds strategies one round at a time and
 * observes whether the IC on the hot path degrades.
 *
 * What creates a distinct hidden class:
 *   - different set of own properties
 *   - different initialization ORDER (transition chains diverge)
 *   - incremental construction vs object literal (different transition root)
 *
 * Value types don't affect hidden class — they affect type feedback separately.
 */
const STRATEGIES = [
  {
    name: 'literal-canonical',
    desc: '{ type, id, value }  — baseline literal order',
    make: (i) => ({ type: 'click', id: i, value: i * 2 }),
  },
  {
    name: 'literal-id-first',
    desc: '{ id, type, value }  — different property order → different transition chain',
    make: (i) => ({ id: i, type: 'click', value: i * 2 }),
  },
  {
    name: 'literal-value-first',
    desc: '{ value, type, id }  — yet another order',
    make: (i) => ({ value: i * 2, type: 'click', id: i }),
  },
  {
    name: 'incremental-t-i-v',
    desc: 'e.type; e.id; e.value  — incremental in canonical order (different root than literal)',
    make: (i) => {
      const o = {};
      o.type = 'click';
      o.id = i;
      o.value = i * 2;
      return o;
    },
  },
  {
    name: 'incremental-i-t-v',
    desc: 'e.id; e.type; e.value  — incremental in different order',
    make: (i) => {
      const o = {};
      o.id = i;
      o.type = 'click';
      o.value = i * 2;
      return o;
    },
  },
  {
    name: 'extra-meta',
    desc: '{ type, id, value, meta }  — extra field widens the shape',
    make: (i) => ({ type: 'click', id: i, value: i * 2, meta: 1 }),
  },
  {
    name: 'extra-tag',
    desc: '{ value, type, id, tag }  — different order AND extra field',
    make: (i) => ({ value: i * 2, type: 'click', id: i, tag: 7 }),
  },
  {
    name: 'extra-source',
    desc: '{ type, id, value, source }  — third extra-field variant',
    make: (i) => ({ type: 'click', id: i, value: i * 2, source: 'web' }),
  },
];

module.exports = { STRATEGIES };
