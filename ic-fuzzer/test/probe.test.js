'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const { derive }         = require('../src/mutate');
const { probe, SEV_LABEL } = require('../src/probe');

const TARGET_FILE = path.resolve(__dirname, 'fixtures/target.js');
const TARGET_FN   = 'compute';
const SEED        = { id: 1, value: 2 };

describe('probe()', () => {
  test('single shape → monomorphic', async () => {
    const strategies = derive(SEED).filter(s => s.name === 'literal:id-value');
    const { severity, error } = await probe(TARGET_FILE, TARGET_FN, strategies);
    assert.equal(error, null, `unexpected error: ${error}`);
    assert.equal(severity, 1, `expected monomorphic (1), got ${SEV_LABEL[severity] || severity}`);
  });

  test('five distinct shapes → megamorphic', async () => {
    // Take five structurally distinct strategies — guaranteed to push V8's IC
    // past the polymorphic limit (>4 shapes = megamorphic).
    const all = derive(SEED);
    const five = [
      all.find(s => s.name === 'literal:id-value'),
      all.find(s => s.name === 'literal:value-id'),
      all.find(s => s.name === 'incr:id-value'),
      all.find(s => s.name === 'incr:value-id'),
      all.find(s => s.name === 'extra:_meta'),
    ].filter(Boolean);

    assert.equal(five.length, 5, 'could not find five distinct strategies');

    const { severity, error } = await probe(TARGET_FILE, TARGET_FN, five);
    assert.equal(error, null, `unexpected error: ${error}`);
    assert.equal(severity, 3, `expected megamorphic (3), got ${SEV_LABEL[severity] || severity}`);
  });

  test('returns error (not throw) for bad function name', async () => {
    const strategies = derive(SEED).slice(0, 1);
    const { severity, error } = await probe(TARGET_FILE, 'nonExistentFn', strategies);
    // Driver exits non-zero; probe returns severity 0 + error string
    assert.equal(severity, 0);
    assert.ok(typeof error === 'string');
  });

  test('empty strategy list → severity 0', async () => {
    const { severity } = await probe(TARGET_FILE, TARGET_FN, []);
    assert.equal(severity, 0);
  });
});
