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

function distinctMapCount(ic) {
  return new Set((ic.updates || []).map(u => u.map).filter(Boolean)).size;
}

function printResult({ found, minimalStrategies, ics, numShrinks, rngSeed, targetName, outPath, anyICs, anyMonomorphic, anyTurbofan, numCrashes, reproduceCmd, reportMaps }) {
  if (!found) {
    console.log('');
    if (!anyICs && !anyTurbofan) {
      console.log('[ic-fuzzer] no IC data observed for this function.');
      console.log('            The seed may not match the properties your function actually reads,');
      console.log('            or the function does not use property accesses on its argument.');
    } else if (anyTurbofan && !anyICs) {
      console.log('[ic-fuzzer] function is Turbofan-compiled — IC sites show no_feedback (X).');
      console.log('            V8 has already optimized this function; IC transitions are no longer logged.');
      console.log('            Use --no-turbofan to keep the function interpreted and observe baseline ICs.');
    } else if (anyMonomorphic) {
      console.log(`[ic-fuzzer] no ${targetName} found — all probes stayed monomorphic or below.`);
      console.log('            The function appears JIT-friendly with this input variety.');
      console.log('            Try a corpus of real production payloads for a more thorough check.');
    } else {
      console.log(`[ic-fuzzer] no ${targetName} found after all runs.`);
    }
    if (anyTurbofan && anyICs) {
      console.log('[ic-fuzzer] note: some probes had Turbofan-compiled ICs (no_feedback); use --no-turbofan for full IC observability');
    }
    if (numCrashes > 0) {
      console.log(`[ic-fuzzer] note: ${numCrashes} probe(s) crashed (use --verbose to see errors)`);
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
      const mapsStr = reportMaps ? `  maps=${distinctMapCount(ic)}` : '';
      console.log(
        `    [${(SEV_LABEL[ic.severity] || '').toUpperCase().padEnd(12)}]` +
        `  .${(last.key || '?').padEnd(10)}  ${ic.functionName}  (${loc})${mapsStr}`,
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

function buildJsonResult({ found, target, minimalStrategies, ics, numShrinks, rngSeed, anyICs, anyMonomorphic, anyTurbofan, numCrashes, reproduceCmd }) {
  const icSites = (ics || [])
    .filter(ic => ic.severity >= 2)
    .map(ic => {
      const rawPath = ic.file.startsWith('file:') ? new URL(ic.file).pathname : ic.file;
      const last = ic.updates[ic.updates.length - 1] || {};
      return {
        file:         path.relative(process.cwd(), rawPath),
        line:         ic.line,
        column:       ic.column,
        functionName: ic.functionName,
        severity:     ic.severity,
        severityLabel: (SEV_LABEL[ic.severity] || '').toLowerCase(),
        key:          last.key || null,
        distinctMaps: distinctMapCount(ic),
      };
    });

  const severity = (ics || []).length ? Math.max(...(ics || []).map(ic => ic.severity)) : 0;

  return {
    found,
    severity,
    severityLabel: (SEV_LABEL[severity] || 'no-ics').toLowerCase(),
    target,
    minimalStrategies: (minimalStrategies || []).map(s => ({ name: s.name, desc: s.desc, sample: s.sample ?? null })),
    ics: icSites,
    numShrinks:    numShrinks   ?? 0,
    rngSeed:       rngSeed      ?? null,
    anyICs:         anyICs         ?? false,
    anyMonomorphic: anyMonomorphic ?? false,
    anyTurbofan:    anyTurbofan    ?? false,
    numCrashes:     numCrashes     ?? 0,
    reproduceCmd:  reproduceCmd ?? null,
  };
}

function printDeopts(deopts, fnName, filePath, json) {
  const rel = f => {
    const p = f.startsWith('file:') ? new URL(f).pathname : f;
    return path.relative(process.cwd(), p);
  };

  if (json) {
    const out = (deopts || []).map(d => {
      const last = d.updates[d.updates.length - 1] || {};
      return {
        functionName: d.functionName,
        file: rel(d.file),
        line: d.line,
        column: d.column,
        severity: d.severity,
        events: d.updates.length,
        bailoutType: last.bailoutType || null,
        deoptReason: last.deoptReason || null,
      };
    });
    process.stdout.write(JSON.stringify({ fn: fnName, file: rel(filePath), deopts: out }, null, 2) + '\n');
    return;
  }

  console.log(`[ic-fuzzer] trace-deopt: ${fnName}  in  ${path.relative(process.cwd(), filePath)}\n`);
  if (!deopts || !deopts.length) {
    console.log('  no deoptimizations observed');
    return;
  }
  for (const d of deopts) {
    const loc  = `${rel(d.file)}:${d.line}:${d.column}`;
    const last = d.updates[d.updates.length - 1] || {};
    const tag  = (last.bailoutType || 'deopt').toUpperCase().padEnd(12);
    console.log(`  [${tag}]  ${d.functionName}  (${loc})  ×${d.updates.length}`);
    for (const u of d.updates) {
      const reason = u.deoptReason || '(unknown reason)';
      const type   = u.bailoutType ? `  [${u.bailoutType}]` : '';
      console.log(`      ${reason}${type}`);
    }
  }
}

function printBench({ monoMs, mixedMs, ratio }) {
  const fmt   = ms => ms === null ? 'n/a' : `${ms.toFixed(0)}ms`;
  const delta = ratio !== null ? `  Δ=${ratio.toFixed(1)}×` : '';
  console.log(`[ic-fuzzer] bench: mono=${fmt(monoMs)}  mixed=${fmt(mixedMs)}${delta}`);
}

module.exports = { createProgress, printInteresting, printShrinking, printResult, printBench, printDeopts, buildJsonResult, distinctMapCount };
