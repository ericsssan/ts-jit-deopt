'use strict';

const fs   = require('fs');
const path = require('path');
const { SEV_LABEL } = require('./probe');

/**
 * Returns a progress tracker that:
 *  - prints a dot (·) for boring runs (no ICs, monomorphic, crashed)
 *  - breaks to a new line and prints details for interesting runs (poly/mega)
 *  - is silent during the shrink phase
 */
function createProgress() {
  let dotCount = 0;

  function flush() {
    if (dotCount > 0) { process.stdout.write('\n'); dotCount = 0; }
  }

  function tick({ severity, phase }) {
    if (phase === 'shrink') return;
    if (severity >= 2) {
      flush();
    } else {
      process.stdout.write('·');
      dotCount++;
    }
  }

  return { tick, flush };
}

function printInteresting({ severity, subset }) {
  const label = (SEV_LABEL[severity] || `sev=${severity}`).toUpperCase();
  const shown = subset.length <= 4 ? subset.join(', ') : `${subset.slice(0, 3).join(', ')} … +${subset.length - 3}`;
  console.log(`  [${label}]  ${shown}`);
}

function printShrinking() {
  console.log('\n[ic-fuzzer] shrinking to minimal set...\n');
}

function printResult({ found, minimalStrategies, ics, numShrinks, rngSeed, targetName, outPath, anyICs, anyMonomorphic, reproduceCmd }) {
  if (!found) {
    console.log('');
    if (!anyICs) {
      console.log('[ic-fuzzer] no IC data observed for this function.');
      console.log('            The seed may not match the properties your function actually reads,');
      console.log('            or the function does not use property accesses on its argument.');
    } else if (anyMonomorphic) {
      console.log(`[ic-fuzzer] no ${targetName} found — all probes stayed monomorphic or below.`);
      console.log('            The function appears JIT-friendly with this input variety.');
      console.log('            Try a corpus of real production payloads for a more thorough check.');
    } else {
      console.log(`[ic-fuzzer] no ${targetName} found after all runs.`);
    }
    return;
  }

  console.log(`[ic-fuzzer] minimal set: ${minimalStrategies.length} shape(s)  (${numShrinks} shrink step(s))\n`);

  for (let i = 0; i < minimalStrategies.length; i++) {
    const s = minimalStrategies[i];
    const sampleStr = s.sample != null ? `  e.g. ${JSON.stringify(s.sample)}` : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${s.name.padEnd(28)}  ${s.desc}`);
    if (sampleStr) console.log(`      ${sampleStr}`);
  }

  const failing = (ics || []).filter(ic => ic.severity >= 2);
  if (failing.length) {
    console.log(`\n[ic-fuzzer] IC sites at ${targetName}:`);
    for (const ic of failing) {
      const last = ic.updates[ic.updates.length - 1] || {};
      const icPath = ic.file.startsWith('file:') ? new URL(ic.file).pathname : ic.file;
      const loc    = `${path.relative(process.cwd(), icPath)}:${ic.line}:${ic.column}`;
      console.log(
        `    [${(SEV_LABEL[ic.severity] || '').toUpperCase().padEnd(12)}]` +
        `  .${(last.key || '?').padEnd(10)}  ${ic.functionName}  (${loc})`,
      );
    }
  }

  const corpus = minimalStrategies.map(s => ({
    strategy: s.name,
    desc:     s.desc,
    sample:   s.sample,
  }));
  fs.writeFileSync(outPath, JSON.stringify(corpus, null, 2));

  console.log(`\n[ic-fuzzer] corpus written → ${path.relative(process.cwd(), outPath)}`);
  if (reproduceCmd) console.log(`[ic-fuzzer] reproduce:    ${reproduceCmd}`);
}

module.exports = { createProgress, printInteresting, printShrinking, printResult };
