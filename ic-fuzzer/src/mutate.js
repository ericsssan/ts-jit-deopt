'use strict';

/**
 * Derives shape mutation strategies from a seed object.
 *
 * Each strategy represents a structurally distinct way to construct an object
 * with the same logical content. The key axis is hidden class: V8 creates a
 * different hidden class when properties are initialized in a different order,
 * when a property is absent, when an extra property is present, or when the
 * object is built incrementally vs. via a literal.
 *
 * Returns an array of { name, desc, code, fnName } where:
 *   - code: a JS function declaration string (inlined into the generated driver)
 *   - fnName: the identifier used in code, for building the makers array
 */

const MAX_PERMS = 6; // cap on permutation count (3! = 6, 4! = 24 → cap at 6)

// Produce a JS expression for the value of a seed property, parameterised by i.
// Numbers vary with i; strings/booleans/null are fixed to preserve the type.
function valExpr(v) {
  switch (typeof v) {
    case 'number':  return 'i';
    case 'string':  return JSON.stringify(v);
    case 'boolean': return String(v);
    default:        return 'null';
  }
}

// Strategy name → valid JS identifier
function toFnName(name) {
  return '_make_' + name.replace(/[^a-zA-Z0-9]/g, '_');
}

// Object literal: { "k1": expr1, "k2": expr2 }
// V8 gives this its own "fast" hidden class transition root.
function literalCode(fnName, keys, seed) {
  const entries = keys.map(k => `${JSON.stringify(k)}: ${valExpr(seed[k])}`).join(', ');
  return `function ${fnName}(i) { return { ${entries} }; }`;
}

// Incremental construction: const o = {}; o["k1"] = expr1; ...
// Different transition root than a literal even for the same property order.
function incrementalCode(fnName, keys, seed) {
  const assigns = keys.map(k => `o[${JSON.stringify(k)}] = ${valExpr(seed[k])};`).join(' ');
  return `function ${fnName}(i) { const o = {}; ${assigns} return o; }`;
}

// null-prototype object: Object.create(null) + incremental assignment.
function nullProtoCode(fnName, keys, seed) {
  const assigns = keys.map(k => `o[${JSON.stringify(k)}] = ${valExpr(seed[k])};`).join(' ');
  return `function ${fnName}(i) { const o = Object.create(null); ${assigns} return o; }`;
}

function permutations(arr, max) {
  const results = [];
  function perm(cur, rem) {
    if (rem.length === 0) { results.push(cur); return; }
    if (results.length >= max) return;
    for (let j = 0; j < rem.length; j++) {
      perm([...cur, rem[j]], [...rem.slice(0, j), ...rem.slice(j + 1)]);
      if (results.length >= max) return;
    }
  }
  perm([], arr);
  return results;
}

function derive(seed) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new TypeError('seed must be a plain object');
  }

  const keys = Object.keys(seed);
  if (keys.length === 0) throw new TypeError('seed must have at least one property');

  const strategies = [];
  const perms = permutations(keys, MAX_PERMS);

  // Literal order permutations
  for (const perm of perms) {
    const name = `literal:${perm.join('-')}`;
    const fnName = toFnName(name);
    strategies.push({ name, desc: `{ ${perm.join(', ')} }  literal`, code: literalCode(fnName, perm, seed), fnName });
  }

  // Incremental construction (same orderings)
  for (const perm of perms) {
    const name = `incr:${perm.join('-')}`;
    const fnName = toFnName(name);
    strategies.push({ name, desc: `e.${perm.join('; e.')}  incremental`, code: incrementalCode(fnName, perm, seed), fnName });
  }

  // Extra unknown field variants (field added after canonical keys)
  for (const extra of ['_meta', '_tag', '_source']) {
    const extSeed = { ...seed, [extra]: null };
    const extKeys = [...keys, extra];
    const name = `extra:${extra}`;
    const fnName = toFnName(name);
    strategies.push({ name, desc: `{ ${keys.join(', ')}, ${extra}: null }  extra field`, code: literalCode(fnName, extKeys, extSeed), fnName });
  }

  // Optional field omission (each property absent once)
  for (const omit of keys) {
    const remaining = keys.filter(k => k !== omit);
    if (remaining.length === 0) continue;
    const omitSeed = Object.fromEntries(remaining.map(k => [k, seed[k]]));
    const name = `omit:${omit}`;
    const fnName = toFnName(name);
    strategies.push({ name, desc: `{ ${remaining.join(', ')} }  missing ${omit}`, code: literalCode(fnName, remaining, omitSeed), fnName });
  }

  // Null prototype
  {
    const name = 'null-proto';
    const fnName = toFnName(name);
    strategies.push({ name, desc: `Object.create(null) + { ${keys.join(', ')} }`, code: nullProtoCode(fnName, keys, seed), fnName });
  }

  return strategies;
}

// Derive from a corpus of objects, deduplicating by strategy name.
function fromCorpus(objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new TypeError('corpus must be a non-empty array of objects');
  }
  const seen = new Set();
  const strategies = [];
  for (const obj of objects) {
    for (const s of derive(obj)) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        strategies.push(s);
      }
    }
  }
  return strategies;
}

module.exports = { derive, fromCorpus };
