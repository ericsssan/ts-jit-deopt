# ts-jit-deopt

Runnable companion to **[From Production Flamegraph to Fixed Megamorphic Call Site](./ARTICLE.md)** — a walkthrough of diagnosing and fixing V8 JIT deoptimization in Node.js.

*Profilers tell you where time goes. They don't tell you why the JIT gave up.*

---

There's a class of production performance problem that profilers can locate but not explain. The flamegraph is unambiguous — `handleEvent` is eating 40% of CPU. The function looks fine. Local benchmarks look fine. The problem isn't in the code; it's in what the runtime decided to do with it.

V8 optimizes by speculating on object shapes. When too many distinct shapes flow through a property access, V8 gives up on the fast path — megamorphism — and falls back to a hashtable lookup on every access. This doesn't show up in source. It's a runtime fact, invisible to the reader and undetectable by profiler sampling.

This repo shows the full loop: find it with `--log-ic`, fix it at the shape boundary, enforce it in CI.

```
events: 2,000,000, hot iterations: 20

broken   229.4ms   (megamorphic loads, un-inlinable call)
fixed     54.5ms   (monomorphic loads, inlined)        ← ~4.2× faster
```

The fix is one line at the ingestion boundary. `broken/handler.js` and `fixed/handler.js` are byte-for-byte identical.

---

## Running this repo

```bash
npm install

npm run bench          # broken vs fixed timing (~4-5×)
npm run typecheck      # strict tsc on the TypeScript example
npm run lint           # static JIT-friendliness rules (--max-warnings=0)
npm run trace:broken   # raw --trace-deopt --log-ic for the broken hot path
npm run trace:fixed    # raw --trace-deopt --log-ic for the fixed hot path
npm run gate           # CI deopt-gate on the fixed path  -> PASS
npm run gate:broken    # CI deopt-gate on the broken path -> FAIL
npm run ts             # the TypeScript version
```

---

## ic-fuzzer

This repo also ships `ic-fuzzer`, a tool that finds the minimal set of object shapes that push a function's inline caches to megamorphic. It uses IC severity — not crashes or coverage — as the feedback signal, which makes it novel: no existing fuzzer does this.

```bash
cd ic-fuzzer
node bin/ic-fuzzer.js ../broken/handler.js handleEvent \
  --seed='{"type":"click","id":1,"value":2}'
```

```
[ic-fuzzer] minimal set: 5 shape(s)  (0 shrink step(s))

   1. literal:type-id-value         { type, id, value }  literal
   2. incr:type-value-id            e.type; e.value; e.id  incremental
   3. incr:id-type-value            e.id; e.type; e.value  incremental
   4. incr:value-type-id            e.value; e.type; e.id  incremental
   5. incr:value-id-type            e.value; e.id; e.type  incremental

[ic-fuzzer] IC sites at megamorphic:
    [MEGAMORPHIC ]  .id     handleEvent  (broken/handler.js:10:16)
    [MEGAMORPHIC ]  .type   handleEvent  (broken/handler.js:10:32)
    [MEGAMORPHIC ]  .value  handleEvent  (broken/handler.js:10:52)
```

Use `--watch=<file>` when your entry point is a thin wrapper around a library — it redirects IC collection to the file you actually care about:

```bash
node bin/ic-fuzzer.js test/fixtures/picomatch-scan-entry.js scanDirect \
  --seed='{"pattern":"**/*.{js,ts}","parts":false,...}' \
  --watch=../node_modules/picomatch/lib/scan.js
```

Other flags: `--target=polymorphic`, `--corpus=<file>`, `--dry-run`, `--rng=<n>` (reproduce), `--runs=<n>`.

---

## Layout

```
ts-jit-deopt/
  ARTICLE.md         ← the full article
  event-source.js    ← heterogeneous event source (pure shape variation)
  bench.js           ← broken vs fixed timing harness
  broken/
    handler.js       ← the hot path (receives many shapes → megamorphic)
    drive.js         ← driver
  fixed/
    event.js         ← canonical shape + boundary normalizer
    handler.js       ← identical hot path (receives one shape → monomorphic)
    drive.js         ← driver (normalized at the boundary)
  ci/
    deopt-gate.js    ← fail CI on mono→megamorphic regression
    gate-driver.js   ← replays the corpus through the chosen handler
  ic-fuzzer/
    bin/ic-fuzzer.js ← CLI: ic-fuzzer <file> <export> --seed=<json> [--watch=<file>]
    src/mutate.js    ← derives shape strategies from a seed object
    src/probe.js     ← subprocess driver: runs under --log-ic, parses IC severity
    src/fuzzer.js    ← fast-check loop: search + shrink to minimal shape set
    src/reporter.js  ← progress, result formatting, corpus.json output
  fuzzer/            ← legacy shape fuzzer (predates ic-fuzzer)
  ts/
    example.ts       ← the TypeScript version (boundary encoded in types)
  .github/workflows/
    deopt-gate.yml   ← drop-in GitHub Actions job
```

## License

MIT © 2026 Eric San. See [LICENSE](./LICENSE).
