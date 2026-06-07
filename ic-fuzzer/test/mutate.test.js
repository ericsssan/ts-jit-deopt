'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { derive, fromCorpus } = require('../src/mutate');

const SEED = { type: 'click', id: 1, value: 2 };

describe('derive()', () => {
  test('returns an array of strategies', () => {
    const strategies = derive(SEED);
    assert.ok(Array.isArray(strategies));
    assert.ok(strategies.length > 0);
  });

  test('every strategy has name, desc, code, fnName, sample', () => {
    for (const s of derive(SEED)) {
      assert.equal(typeof s.name,   'string', `${s.name}: name`);
      assert.equal(typeof s.desc,   'string', `${s.name}: desc`);
      assert.equal(typeof s.code,   'string', `${s.name}: code`);
      assert.equal(typeof s.fnName, 'string', `${s.name}: fnName`);
      // sample is null only for strategies whose code throws (shouldn't happen for well-formed seeds)
      assert.notEqual(s.sample, undefined,    `${s.name}: sample field missing`);
    }
  });

  test('strategy names are unique', () => {
    const names = derive(SEED).map(s => s.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('fnName appears in code', () => {
    for (const s of derive(SEED)) {
      assert.ok(s.code.includes(s.fnName), `${s.name}: fnName not in code`);
    }
  });

  test('generated code is valid JS and produces an object', () => {
    for (const s of derive(SEED)) {
      const fn = new Function(`${s.code}; return ${s.fnName};`)();
      assert.equal(typeof fn, 'function', `${s.name}: code did not produce a function`);
      const obj = fn(0);
      assert.equal(typeof obj, 'object', `${s.name}: make(0) is not an object`);
    }
  });

  test('sample matches what the code produces', () => {
    for (const s of derive(SEED)) {
      if (s.sample === null) continue; // skip strategies that intentionally produce null
      const fn  = new Function(`${s.code}; return ${s.fnName};`)();
      const obj = fn(0);
      assert.deepEqual(s.sample, obj, `${s.name}: sample mismatch`);
    }
  });

  test('literal strategy has canonical keys', () => {
    const strategies = derive(SEED);
    const canonical = strategies.find(s => s.name === 'literal:type-id-value');
    assert.ok(canonical, 'canonical literal strategy missing');
    const fn = new Function(`${canonical.code}; return ${canonical.fnName};`)();
    const obj = fn(7);
    assert.equal(obj.type,  'click');
    assert.equal(obj.id,    7);      // number — varies with i
    assert.equal(obj.value, 7);      // number — varies with i
  });

  test('incremental strategy produces same keys as literal', () => {
    const strategies = derive(SEED);
    const literal     = strategies.find(s => s.name === 'literal:type-id-value');
    const incremental = strategies.find(s => s.name === 'incr:type-id-value');
    assert.ok(incremental, 'canonical incremental strategy missing');
    const litFn  = new Function(`${literal.code};  return ${literal.fnName};`)();
    const incrFn = new Function(`${incremental.code}; return ${incremental.fnName};`)();
    const litObj  = litFn(3);
    const incrObj = incrFn(3);
    assert.deepEqual(Object.keys(litObj).sort(), Object.keys(incrObj).sort());
    assert.deepEqual(litObj, incrObj);
  });

  test('extra-field strategy adds the extra property', () => {
    const strategies = derive(SEED);
    const extra = strategies.find(s => s.name === 'extra:_meta');
    assert.ok(extra, 'extra:_meta strategy missing');
    const fn  = new Function(`${extra.code}; return ${extra.fnName};`)();
    const obj = fn(0);
    assert.ok('_meta' in obj, 'extra field missing');
    assert.equal(obj._meta, null);
  });

  test('omit strategy is missing the omitted property', () => {
    const strategies = derive(SEED);
    const omit = strategies.find(s => s.name === 'omit:id');
    assert.ok(omit, 'omit:id strategy missing');
    const fn  = new Function(`${omit.code}; return ${omit.fnName};`)();
    const obj = fn(0);
    assert.ok(!('id' in obj), 'omitted field still present');
    assert.ok('type'  in obj);
    assert.ok('value' in obj);
  });

  test('null-proto strategy produces null-prototype object', () => {
    const strategies = derive(SEED);
    const np = strategies.find(s => s.name === 'null-proto');
    assert.ok(np, 'null-proto strategy missing');
    const fn  = new Function(`${np.code}; return ${np.fnName};`)();
    const obj = fn(0);
    assert.equal(Object.getPrototypeOf(obj), null);
  });

  test('throws on non-object seed', () => {
    assert.throws(() => derive('string'),    /seed must be a plain object/);
    assert.throws(() => derive(null),        /seed must be a plain object/);
    assert.throws(() => derive([1, 2]),      /seed must be a plain object/);
    assert.throws(() => derive({}),          /seed must have at least one property/);
  });
});

describe('fromCorpus()', () => {
  test('accepts an array of objects and returns strategies', () => {
    const corpus = [
      { type: 'click', id: 1, value: 2 },
      { id: 3, type: 'hover', value: 4 },
    ];
    const strategies = fromCorpus(corpus);
    assert.ok(strategies.length > 0);
  });

  test('deduplicates strategies from overlapping seeds', () => {
    const corpus = [SEED, SEED, SEED];
    const strategies = fromCorpus(corpus);
    const names = strategies.map(s => s.name);
    assert.equal(new Set(names).size, names.length, 'duplicate strategies found');
  });

  test('throws on empty array', () => {
    assert.throws(() => fromCorpus([]), /non-empty array/);
  });
});
