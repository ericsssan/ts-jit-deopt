'use strict';

/**
 * Core fuzzing loop.
 *
 * Uses fast-check's fc.subarray to randomly sample subsets of the strategy
 * catalog and fc.check's shrinking to find the minimal subset that causes IC
 * degradation to the target severity.
 *
 * The predicate is the IC state: the property test passes when severity is
 * BELOW target, fails (triggering shrinking) when it meets or exceeds target.
 */

const fc = require('fast-check');
const { probe } = require('./probe');

/**
 * @param {object}   opts
 * @param {string}   opts.fnFile       absolute path to the module
 * @param {string}   opts.fnName       exported function name
 * @param {object[]} opts.strategies   from mutate.derive() or mutate.fromCorpus()
 * @param {number}   opts.targetSev    2 = polymorphic, 3 = megamorphic
 * @param {number}   [opts.seed]       fast-check RNG seed for reproduction
 * @param {number}   [opts.numRuns]    max runs before giving up (default 200)
 * @param {Function} [opts.onRun]      progress callback({ subset, severity, phase })
 *
 * @returns {{ found, minimalStrategies, ics, numShrinks, seed }}
 */
async function fuzz({ fnFile, fnName, strategies, targetSev, seed, numRuns = 200, onRun }) {
  const names  = strategies.map(s => s.name);
  const byName = Object.fromEntries(strategies.map(s => [s.name, s]));

  let phase = 'search';

  const fcResult = await fc.check(
    fc.asyncProperty(
      fc.subarray(names, { minLength: 1 }),
      async (subset) => {
        const selected = subset.map(n => byName[n]);
        const { severity, error } = await probe(fnFile, fnName, selected);

        if (onRun) onRun({ subset, severity, phase, error });

        if (severity >= targetSev && phase === 'search') phase = 'shrink';

        return severity < targetSev;
      },
    ),
    { numRuns, ...(seed !== undefined ? { seed } : {}) },
  );

  if (!fcResult.failed) {
    return { found: false, minimalStrategies: [], ics: [], numShrinks: 0, seed: fcResult.seed };
  }

  // Confirm the minimal counterexample and collect IC details for reporting.
  const minimalNames      = fcResult.counterexample[0];
  const minimalStrategies = minimalNames.map(n => byName[n]);
  const { ics }           = await probe(fnFile, fnName, minimalStrategies);

  return {
    found: true,
    minimalStrategies,
    ics,
    numShrinks: fcResult.numShrinks,
    seed: fcResult.seed,
  };
}

module.exports = { fuzz };
