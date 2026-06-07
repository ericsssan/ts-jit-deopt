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
 * Returns an array of { name, desc, code, fnName, sample } where:
 *   - code:   JS function declaration inlined into the generated driver
 *   - fnName: the identifier used in code
 *   - sample: a concrete example object (for reporting / corpus.json)
 */

const MAX_PERMS = 6;

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function valExpr(v) {
  switch (typeof v) {
    case 'number':  return 'i';
    case 'string':  return JSON.stringify(v);
    case 'boolean': return String(v);
    default:        return JSON.stringify(v);  // null, array, nested object → inline JSON
  }
}

function toFnName(name) {
  return '_make_' + name.replace(/[^a-zA-Z0-9]/g, '_');
}

function literalCode(fnName, keys, seed) {
  const entries = keys.map(k => `${JSON.stringify(k)}: ${valExpr(seed[k])}`).join(', ');
  return `function ${fnName}(i) { return { ${entries} }; }`;
}

function incrementalCode(fnName, keys, seed) {
  const assigns = keys.map(k => `o[${JSON.stringify(k)}] = ${valExpr(seed[k])};`).join(' ');
  return `function ${fnName}(i) { const o = {}; ${assigns} return o; }`;
}

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

// Evaluate a strategy's code string to produce a concrete sample object.
function evalSample(code, fnName) {
  try {
    return new Function(`${code}; return ${fnName};`)()(0);
  } catch {
    return null;
  }
}

function makeStrategy(name, desc, code) {
  const fnName = toFnName(name);
  const sample = evalSample(code(fnName), fnName);
  return { name, desc, code: code(fnName), fnName, sample };
}

// _nested = true disables the recursive nested-variant pass to prevent explosion.
function derive(seed, _nested = false) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new TypeError('seed must be a plain object');
  }
  const keys = Object.keys(seed);
  if (keys.length === 0) throw new TypeError('seed must have at least one property');

  const strategies = [];
  const perms = permutations(keys, MAX_PERMS);

  for (const perm of perms) {
    strategies.push(makeStrategy(
      `literal:${perm.join('-')}`,
      `{ ${perm.join(', ')} }  literal`,
      fn => literalCode(fn, perm, seed),
    ));
  }

  for (const perm of perms) {
    strategies.push(makeStrategy(
      `incr:${perm.join('-')}`,
      `e.${perm.join('; e.')}  incremental`,
      fn => incrementalCode(fn, perm, seed),
    ));
  }

  for (const extra of ['_meta', '_tag', '_source']) {
    const extSeed = { ...seed, [extra]: null };
    strategies.push(makeStrategy(
      `extra:${extra}`,
      `{ ${keys.join(', ')}, ${extra}: null }  extra field`,
      fn => literalCode(fn, [...keys, extra], extSeed),
    ));
  }

  for (const omit of keys) {
    const remaining = keys.filter(k => k !== omit);
    if (remaining.length === 0) continue;
    const omitSeed = Object.fromEntries(remaining.map(k => [k, seed[k]]));
    strategies.push(makeStrategy(
      `omit:${omit}`,
      `{ ${remaining.join(', ')} }  missing ${omit}`,
      fn => literalCode(fn, remaining, omitSeed),
    ));
  }

  strategies.push(makeStrategy(
    'null-proto',
    `Object.create(null) + { ${keys.join(', ')} }`,
    fn => nullProtoCode(fn, keys, seed),
  ));

  // For each top-level key whose value is a plain object, generate additional strategies
  // where that nested object is constructed with shape variance (different property orders,
  // incremental assignment, etc.). Each variant embeds a renamed nested factory function
  // alongside the outer factory so both hidden-class axes are exercised independently.
  if (!_nested) {
    for (const k of keys) {
      if (!isPlainObj(seed[k])) continue;
      const nestedStrats = derive(seed[k], true);
      for (const ns of nestedStrats) {
        strategies.push(makeStrategy(
          `nested:${k}:${ns.name}`,
          `{ ${keys.join(', ')} }  ${k} → ${ns.desc}`,
          outerFn => {
            const innerFn   = `${outerFn}__inner`;
            const innerCode = ns.code.replace(new RegExp(`\\b${ns.fnName}\\b`, 'g'), innerFn);
            const entries   = keys.map(k2 =>
              `${JSON.stringify(k2)}: ${k2 === k ? `${innerFn}(i)` : valExpr(seed[k2])}`
            ).join(', ');
            return `${innerCode}\nfunction ${outerFn}(i) { return { ${entries} }; }`;
          },
        ));
      }
    }
  }

  return strategies;
}

function fromCorpus(objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new TypeError('corpus must be a non-empty array of objects');
  }
  const seen = new Set();
  const strategies = [];
  for (const obj of objects) {
    for (const s of derive(obj)) {
      if (!seen.has(s.name)) { seen.add(s.name); strategies.push(s); }
    }
  }
  return strategies;
}

module.exports = { derive, fromCorpus };
