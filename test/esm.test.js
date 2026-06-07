'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const { derive }                       = require('../src/mutate');
const { probe, validateExport, isESMFile } = require('../src/probe');

const FIXTURES = path.resolve(__dirname, 'fixtures');
const SEED     = { id: 1, value: 2 };

// ---------------------------------------------------------------------------
// isESMFile()
// ---------------------------------------------------------------------------

describe('isESMFile()', () => {
  test('.mjs extension → true', () => {
    assert.equal(isESMFile('/any/path/file.mjs'), true);
  });

  test('.cjs extension → false', () => {
    assert.equal(isESMFile('/any/path/file.cjs'), false);
  });

  test('.js in CJS package (fixtures/target.js) → false', () => {
    assert.equal(isESMFile(path.join(FIXTURES, 'target.js')), false);
  });

  test('.js in ESM package (target-esm-pkg/index.js) → true', () => {
    assert.equal(isESMFile(path.join(FIXTURES, 'target-esm-pkg', 'index.js')), true);
  });
});

// ---------------------------------------------------------------------------
// validateExport() — async, CJS and ESM
// ---------------------------------------------------------------------------

describe('validateExport()', () => {
  const CJS_FILE = path.join(FIXTURES, 'target.js');
  const MJS_FILE = path.join(FIXTURES, 'target.mjs');

  test('CJS: valid export → null', async () => {
    assert.equal(await validateExport(CJS_FILE, 'compute'), null);
  });

  test('CJS: missing export → error string', async () => {
    const err = await validateExport(CJS_FILE, 'noSuchExport');
    assert.ok(typeof err === 'string' && err.length > 0);
  });

  test('CJS: file not found → error string', async () => {
    const err = await validateExport('/nonexistent/file.js', 'compute');
    assert.ok(typeof err === 'string' && err.length > 0);
  });

  test('ESM (.mjs): valid export → null', async () => {
    assert.equal(await validateExport(MJS_FILE, 'compute'), null);
  });

  test('ESM (.mjs): missing export → error string', async () => {
    const err = await validateExport(MJS_FILE, 'noSuchExport');
    assert.ok(typeof err === 'string' && err.length > 0);
  });

  test('ESM (package "type":"module"): valid export → null', async () => {
    const file = path.join(FIXTURES, 'target-esm-pkg', 'index.js');
    assert.equal(await validateExport(file, 'compute'), null);
  });
});

// ---------------------------------------------------------------------------
// probe() — ESM targets
// ---------------------------------------------------------------------------

describe('probe() — ESM', () => {
  test('.mjs single shape → monomorphic', async () => {
    const file = path.join(FIXTURES, 'target.mjs');
    const [s]  = derive(SEED);
    const { severity, crashed, error } = await probe(file, 'compute', [s]);
    assert.equal(crashed, false, `crashed: ${error}`);
    assert.equal(error,   null);
    assert.equal(severity, 1);
  });

  test('.mjs five shapes → megamorphic', async () => {
    const file  = path.join(FIXTURES, 'target.mjs');
    const strats = derive(SEED).slice(0, 5);
    const { severity, error } = await probe(file, 'compute', strats);
    assert.equal(error, null);
    assert.equal(severity, 3);
  });

  test('.mjs bad export → crashed, not throw', async () => {
    const file = path.join(FIXTURES, 'target.mjs');
    const [s]  = derive(SEED);
    const { severity, crashed } = await probe(file, 'badFn', [s]);
    assert.equal(severity, 0);
    assert.equal(crashed, true);
  });

  test('package "type":"module" .js → megamorphic with five shapes', async () => {
    const file  = path.join(FIXTURES, 'target-esm-pkg', 'index.js');
    const strats = derive(SEED).slice(0, 5);
    const { severity, error } = await probe(file, 'compute', strats);
    assert.equal(error, null);
    assert.equal(severity, 3);
  });
});
