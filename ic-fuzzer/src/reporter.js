'use strict';

const fs   = require('fs');
const path = require('path');
const { SEV_LABEL } = require('./probe');

function printRun({ subset, severity, phase }) {
  if (phase === 'shrink') return; // silent during shrinking; summary printed at end
  const label = SEV_LABEL[severity] || `sev=${severity}`;
  const names = subset.length <= 5
    ? subset.join(', ')
    : `${subset.slice(0, 4).join(', ')}, … +${subset.length - 4}`;
  process.stdout.write(`  [${label.padEnd(12)}]  ${names}\n`);
}

function printShrinking() {
  console.log('\n[ic-fuzzer] shrinking to minimal set...\n');
}

function printResult({ found, minimalStrategies, ics, numShrinks, seed, targetName, outPath }) {
  if (!found) {
    console.log(`\n[ic-fuzzer] no ${targetName} found. Add more strategies and re-run.`);
    return;
  }

  console.log(`[ic-fuzzer] minimal set: ${minimalStrategies.length} shape(s)  (${numShrinks} shrink step(s))\n`);

  for (let i = 0; i < minimalStrategies.length; i++) {
    const s = minimalStrategies[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${s.name.padEnd(32)}  ${s.desc}`);
  }

  const failing = (ics || []).filter(ic => ic.severity >= 2);
  if (failing.length) {
    console.log(`\n[ic-fuzzer] IC sites at ${targetName}:`);
    for (const ic of failing) {
      const last = ic.updates[ic.updates.length - 1] || {};
      const loc  = `${path.relative(process.cwd(), ic.file)}:${ic.line}:${ic.column}`;
      console.log(
        `    [${(SEV_LABEL[ic.severity] || ic.severity).toUpperCase().padEnd(12)}]` +
        `  .${(last.key || '?').padEnd(10)}  ${ic.functionName}  (${loc})`,
      );
    }
  }

  const corpus = minimalStrategies.map(s => ({ strategy: s.name, desc: s.desc }));
  fs.writeFileSync(outPath, JSON.stringify(corpus, null, 2));

  console.log(`\n[ic-fuzzer] corpus written → ${path.relative(process.cwd(), outPath)}`);
  console.log(`[ic-fuzzer] reproduce:  ic-fuzzer ... --seed-rng=${seed}`);
}

module.exports = { printRun, printShrinking, printResult };
