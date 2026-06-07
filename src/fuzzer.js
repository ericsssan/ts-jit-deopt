'use strict';

const fc = require('fast-check');
const { probe } = require('./probe');

/**
 * @param {object}   opts
 * @param {string}   opts.fnFile
 * @param {string}   opts.fnName
 * @param {object[]} opts.strategies
 * @param {number}   opts.targetSev    2 = polymorphic, 3 = megamorphic
 * @param {string}   [opts.watchFile]  alternative file to watch for ICs (default: fnFile)
 * @param {number}   [opts.seed]       fast-check RNG seed
 * @param {number}   [opts.numRuns]
 * @param {number}   [opts.count]      events per driver iteration (default: 20000)
 * @param {number}   [opts.iters]      number of hot iterations (default: 40)
 * @param {Function} [opts.onRun]      ({ subset, severity, phase, hasICs, crashed, error })
 *
 * @returns {{ found, minimalStrategies, ics, numShrinks, rngSeed, anyICs, anyMonomorphic, numCrashes }}
 */
async function fuzz({ fnFile, fnName, strategies, targetSev, watchFile, seed, numRuns = 200, count, iters, onRun }) {
  const names  = strategies.map(s => s.name);
  const byName = Object.fromEntries(strategies.map(s => [s.name, s]));

  let phase        = 'search';
  let anyICs        = false;
  let anyMonomorphic = false;
  let numCrashes     = 0;

  const fcResult = await fc.check(
    fc.asyncProperty(
      fc.subarray(names, { minLength: 2 }),
      async (subset) => {
        const selected = subset.map(n => byName[n]);
        const { severity, error, hasICs, crashed } = await probe(fnFile, fnName, selected, watchFile, count, iters);

        if (hasICs) anyICs = true;
        if (severity === 1) anyMonomorphic = true;
        if (crashed) numCrashes++;
        if (onRun) onRun({ subset, severity, phase, hasICs, crashed, error });
        if (severity >= targetSev && phase === 'search') phase = 'shrink';

        return severity < targetSev;
      },
    ),
    { numRuns, ...(seed !== undefined ? { seed } : {}) },
  );

  if (!fcResult.failed) {
    return { found: false, minimalStrategies: [], ics: [], numShrinks: 0, rngSeed: fcResult.seed, anyICs, anyMonomorphic, numCrashes };
  }

  const minimalNames      = fcResult.counterexample[0];
  const minimalStrategies = minimalNames.map(n => byName[n]);
  const { ics }           = await probe(fnFile, fnName, minimalStrategies, watchFile, count, iters);

  return { found: true, minimalStrategies, ics, numShrinks: fcResult.numShrinks, rngSeed: fcResult.seed, anyICs, anyMonomorphic, numCrashes };
}

module.exports = { fuzz };
