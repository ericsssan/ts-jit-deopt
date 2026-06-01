# From Production Flamegraph to Fixed Megamorphic Call Site

*Diagnosing V8 deoptimizations with real production data — the missing middle between "your profiler says **where**" and "now you know **why**."*

---

## The wall everyone hits

Your Node service's p99 has been creeping up. The continuous profiler is unambiguous: `handleEvent` is eating 40% of CPU. You open the function and it's... completely normal. A local microbenchmark of it runs fine.

That's the wall. **Profilers tell you *where* time goes; they don't tell you *why* the JIT gave up on a function.** And the tooling that *does* explain why — V8's own `--trace-deopt` / `--log-ic` tracing — needs a representative workload you can't reproduce by hand.

This article is the bridge: a repeatable six-stage loop that connects production sampling to local root-cause analysis to a fix that stays fixed, with real, *measured* numbers at the end. Every individual layer here has been written about before (inline-cache theory, the local tools, production profiling). What's missing from the literature is the *connection* — so that's what this is.

> Every snippet below is runnable in this repo. `npm run bench` for the numbers; `npm run trace:broken` / `npm run trace:fixed` for the raw deopt/IC trace; `npm run gate` for the parsed hot-path verdict.

---

## The one mental model you need

A JIT optimizes by **speculating**: it watches the types and object shapes your code actually uses, compiles specialized machine code assuming those stay constant, and **deoptimizes** — throws the optimized code away — the moment an assumption breaks. A related failure is **megamorphism**: a property or call site that has seen too many object shapes (>4) gives up on its fast inline cache and falls back to a slow global hashtable lookup. Both are **runtime facts**, not properties you can read off the source.

The intellectual core of this workflow is one distinction:

- **Continuous profilers *sample stacks*** — grab the call stack ~100×/sec and aggregate. Cheap, always-on; they estimate a *distribution* (where time goes). Missing a few samples doesn't matter.
- **Deopt/IC data is made of *discrete state-machine events*** — every inline-cache transition. You can't statistically sample a "mono → megamorphic" transition; miss it and you miss the signal. It must be captured *exhaustively*, which is heavy and local-only.

**No single tool is both cheap-and-continuous and exhaustive-and-explanatory.** So you chain two tools that each do one job.

---

## The running example

`handleEvent(event)` lives in an event-ingestion service. Events arrive from several producers (see [`event-source.js`](./event-source.js)). Crucially, in this demo **every event has the same fields with the same value types** — `type: string`, `id: number`, `value: number`. The *only* thing that varies is the **hidden class**:

- some carry an extra `meta`/`tag` field → a different shape;
- one producer emits the fields in a **different property order** → a different shape;
- one builds the object **incrementally** (`e.id = …; e.type = …`) → a different transition path → a different shape.

That isolation is deliberate: it means the entire speedup at the end is attributable to **one variable — the object shape** — and nothing else. (Real services add type instability and optional values on top; see the attribution sidebar for why isolating matters.)

You'd never guess from reading `handleEvent` that it's a textbook megamorphic call site. That's the point.

---

## Stage 1 — Find the hot *and deoptimized* function in production

Lightest to richest:

- **`node --cpu-prof app.js`** → load the `.cpuprofile` in Chrome DevTools; it annotates frames with optimization state.
- **`perf record` + `node --perf-basic-prof`** → a flamegraph distinguishing JIT machine-code frames from interpreter frames.
- **Continuous profilers** (Datadog, Grafana Pyroscope) for always-on production, 1–5% overhead.

**The skill is not spotting "hot" — it's spotting "hot *and* stuck in a lower tier."** Output of this stage: a short list of suspects. Ours is `handleEvent`.

---

## Stage 2 — Capture representative real inputs

This is the crux, and where naïve attempts fail: **deopt/IC tracing is only as truthful as the data you feed it.** Toy inputs produce a falsely all-green report.

- structured-log a *sampled* fraction (1-in-N) of real payloads, PII-scrubbed;
- tap at the deserialization boundary;
- replay from request logs or a traffic mirror (shadow traffic).

Then build a **driver** that imports the real function and replays the captured payloads in a warm-up loop — that's [`broken/drive.js`](./broken/drive.js) (here `makeEvents` synthesizes the variety; in production you'd feed the captured corpus). You need the *distribution* of shapes, not one request — the shape **variety** is what causes megamorphism.

---

## Stage 3 — Run exhaustive deopt analysis locally

```bash
npm run trace:broken          # node --trace-deopt --log-ic broken/drive.js
#   eager/lazy deopts print to stdout; IC transitions go to isolate-*.log
# To read that IC log as a table, parse it with v8-deopt-parser — which is
# exactly what the Stage-6 gate does (npm run gate:broken).
```

What the trace tells you (representative — exact format varies by V8 version; on modern V8 the distinguishing signal is **IC state**, not necessarily eager deopts):

```
handler.js
  handleEvent
    10  return event.id * 31 + event.type.length + event.value
          ● LoadIC  .id     MEGAMORPHIC  (5+ maps)    [red]
          ● LoadIC  .type   MEGAMORPHIC  (5+ maps)    [red]
          ● LoadIC  .value  MEGAMORPHIC  (5+ maps)    [red]
```

**Reading it:** `.id`, `.type`, `.value` each went **megamorphic** — more than four hidden classes flowed through, so V8 abandoned the inline fast path and does a slow global-hashtable lookup on every access. Those megamorphic loads also keep `handleEvent` from being profitably inlined into `run`. Every red marker traces back to one producer's shape.

---

## Stage 4 — Diagnose and fix: normalize to one canonical shape at the boundary

Define a single shape, and a boundary function that funnels every incoming shape into it ([`fixed/event.js`](./fixed/event.js)):

```js
class Event {
  constructor(type, id, value) {
    this.type = type;   // always string
    this.id = id;       // always number
    this.value = value; // always number
  }
}

// Runs ONCE per event at the ingestion boundary — NOT in the hot loop.
function toEvent(raw) {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const rid = raw.id;
  const id = rid == null ? 0 : typeof rid === 'string' ? rid.length : rid;
  const value = typeof raw.value === 'number' ? raw.value : 0;
  return new Event(type, id, value); // every instance shares ONE hidden class
}
```

The key move: **the hot path doesn't change at all.** [`broken/handler.js`](./broken/handler.js) and [`fixed/handler.js`](./fixed/handler.js) are *byte-for-byte identical*:

```js
function handleEvent(event) {
  return event.id * 31 + event.type.length + event.value;
}
```

The only difference is in the driver — [`fixed/drive.js`](./fixed/drive.js) adds one boundary pass:

```js
const events = makeEvents(2_000_000).map(toEvent); // unify the shape, once
```

### Measured result

```
events: 2,000,000, hot iterations: 20

broken   229.4ms   (megamorphic loads, un-inlinable call)
fixed     54.5ms   (monomorphic loads, inlined)        ← ~4.2× faster
```

Identical checksums; identical handler code. **The entire speedup came from giving the hot path one object shape instead of five.** (Absolute times vary per run and machine — **~4–5×** is the stable signal; the identical checksums prove both paths compute the same result.)

### The subtlety most write-ups miss

**You don't eliminate the megamorphic read — you confine it.** `toEvent` still reads `.id`/`.type`/`.value` off heterogeneous `raw` objects, so *its* loads are still megamorphic. The win is structural:

- **Before:** the megamorphic access ran **40M times** (2M events × 20 hot iterations).
- **After:** it runs **2M times, once** (the boundary pass), and the 40M-iteration hot loop is **monomorphic**.

You moved the unavoidable cost of heterogeneous input *out of the hot path* and paid it once at the edge.

---

## ⚠️ Sidebar: attribution — measure, don't assume (a real mistake)

The first draft of this example added a type-unstable `normalizeId(event.id)` (where `id` was `number | string | null`) to the broken handler, and I *assumed* the megamorphic shapes were the cause. Measuring proved otherwise:

```
A broken-logic / heterogeneous shapes   306 ms
B broken-logic / monomorphic shape      296 ms   ← unifying the shape barely helped!
C fixed-logic  / monomorphic shape       51 ms
```

The shape contributed only ~3% there — the type-unstable per-element logic dominated and **masked** the shape cost. Only after isolating a pure-shape variant did the real megamorphism penalty show up cleanly:

```
monomorphic (1 shape)     47 ms
megamorphic (6 shapes)   267 ms   ← 5.6× from shape alone
```

**Two large effects (un-inlinable type-unstable logic, and shape megamorphism) don't compose simply — whichever bottlenecks the loop dominates and hides the other.** The lesson is the article's whole thesis applied to itself: even when you "know" the JIT, isolate one variable and *measure* the cause. This repo's example is the isolated, honest version.

---

## Stage 5 — Verify, and close the loop

- **Local:** re-run `npm run trace:fixed` (or `npm run gate`) → the watched IC sites read monomorphic instead of megamorphic. Confirm the speedup with `npm run bench`.
- **Production:** deploy and confirm on the *same continuous profiler* that found it that `handleEvent` dropped out of the hot list / moved into the optimized tier.

Verifying the fix with the same prod tool that surfaced it is the part nobody writes. It's what closes the loop.

---

## Stage 6 — Make it stick: a deopt-gate in CI

A fix that isn't enforced rots. Two layers:

- **Cheap static layer:** [`eslint.config.js`](./eslint.config.js) ships the locally-decidable subset — `no-restricted-syntax` rules banning `delete` (dictionary mode), `with`, and `arguments` leakage, plus `no-eval`, `no-implied-eval`, `prefer-rest-params`, `no-param-reassign`, and (for `.ts`) `@typescript-eslint/no-explicit-any`. These rules are `warn`-severity (so they read as advisory shape hints in your editor), but `npm run lint` runs `eslint . --max-warnings=0` — so a single reintroduced shape-wrecker still fails CI. They catch what a linter *can* see from syntax; they can't see cross-function megamorphism — that's the next layer.
- **Real layer — a deopt regression test.** Run the Stage-2 driver under V8 IC logging, parse the log, and **fail the build if a watched hot-path access regresses from monomorphic back to megamorphic.** This is the dynamic analog of a linter, because JIT-friendliness is a runtime property.

This repo ships a working one: [`ci/deopt-gate.js`](./ci/deopt-gate.js) (the gate) + [`ci/gate-driver.js`](./ci/gate-driver.js) (replays the corpus) + a [GitHub Actions workflow](./.github/workflows/deopt-gate.yml). It runs the driver with `--log-ic --log-maps --log-code --log-source-code`, parses the log with [`v8-deopt-parser`](https://github.com/andrewiggins/v8-deopt-viewer) (the parser behind v8-deopt-viewer), and checks the severity of each inline cache.

```bash
npm install        # pulls v8-deopt-parser
npm run gate       # gate the FIXED hot path  -> PASS (exit 0)
npm run gate:broken # gate the BROKEN hot path -> FAIL (exit 1)
```

Real output:

```
$ npm run gate
[deopt-gate] 6 watched IC site(s)  [watch=["/handler.js"] ignore=["node_modules","/event.js"] fail>=megamorphic]
  [ ok ] monomorphic  .id       handleEvent  (fixed/handler.js:8:16)
  [ ok ] monomorphic  .type     handleEvent  (fixed/handler.js:8:32)
  [ ok ] monomorphic  .length   handleEvent  (fixed/handler.js:8:37)
  [ ok ] monomorphic  .value    handleEvent  (fixed/handler.js:8:52)
  [ ok ] monomorphic  .length   run  (fixed/handler.js:13:30)
  [ ok ] monomorphic  .11       run  (fixed/handler.js:13:68)
[deopt-gate] PASS — no watched IC site at >= megamorphic.

$ npm run gate:broken
[deopt-gate] 6 watched IC site(s)  [watch=["/handler.js"] ignore=["node_modules","/event.js"] fail>=megamorphic]
  [FAIL] megamorphic  .id       handleEvent  (broken/handler.js:10:16)
  [FAIL] megamorphic  .type     handleEvent  (broken/handler.js:10:32)
  [FAIL] megamorphic  .value    handleEvent  (broken/handler.js:10:52)
  [ ok ] monomorphic  .length   handleEvent  (broken/handler.js:10:37)
  [ ok ] monomorphic  .length   run  (broken/handler.js:15:30)
  [ ok ] monomorphic  .11       run  (broken/handler.js:15:68)
[deopt-gate] FAIL — 3 hot-path IC site(s) at >= megamorphic. ...
```

(The `.length` and `.11` rows are the `event.type.length` read and the `events[i]`
element access — same `handler.js`, both safely monomorphic; the gate fails only on
the three megamorphic `handleEvent` loads.)

**Why it gates by *file*, not property name:** the boundary normalizer `toEvent` (in `fixed/event.js`) legitimately reads `.id`/`.type`/`.value` off heterogeneous input and is *itself* megamorphic — and that's fine, it's confined. The gate watches only `handler.js` and ignores `event.js`, so the boundary's megamorphism doesn't trip it. Configure via env: `GATE_WATCH`, `GATE_IGNORE`, `GATE_MAX_SEV` (set to `2` to also fail on polymorphic).

**Caveats:** it only guards the paths your captured corpus exercises — keep the corpus fresh from prod. And the logging flag names are V8-version-specific (`--log-ic` on Node 20+; older V8 used `--trace-ic`), so pin your Node version in CI.

---

## The TypeScript payoff

The typed version ([`ts/example.ts`](./ts/example.ts)) models the messy real-world input (which *does* include type instability) and encodes the boundary in types:

```ts
type RawEvent = { type: string; id: number | string | null; value?: number; meta?: unknown };
class Event { constructor(readonly type: string, readonly id: number, readonly value: number) {} }
function toEvent(raw: RawEvent): Event { /* the only bridge */ }
function handleEvent(event: Event): number { /* hot path typed to the canonical shape */ }
```

`handleEvent(event: Event)` isn't just documentation — with `strict` on and no `any`, the compiler **refuses to let a `RawEvent` reach the hot path**, which is the same discipline that keeps V8's speculation monomorphic *and* its values type-stable. Type safety and JIT-friendliness turn out to be the same discipline wearing two hats.

---

## Caveats & when *not* to do this

- IC/deopt tracing (`--log-ic`, `--trace-deopt`) is heavy and local-only; never run it in production.
- Results are **V8-version-specific** — re-verify after Node upgrades (this demo was measured on Node 25 / Maglev+TurboFan).
- Don't chase deopts in cold code; only where the prod profiler proved it costs real time.
- Modern V8 fixed many old "deopt killers" (try/catch, generators). Measure — don't cargo-cult 2015 blacklists.

---

## Conclusion

Sampling finds the suspect and hands you real evidence; exhaustive tracing convicts it; you fix the shape; the same sampler confirms the fix in production. You don't need to escape the JIT to get native-grade performance — you need to feed it monomorphic, type-stable code, and **this loop is how you find where you failed to.**

---

## Running this repo

```bash
npm install            # eslint, typescript-eslint, v8-deopt-parser
npm run bench          # broken vs fixed timing
npm run typecheck      # strict tsc on the TS example (no `any` can sneak in)
npm run lint           # static JIT-friendliness rules (Stage 6, cheap layer)
npm run trace:broken   # raw --trace-deopt --log-ic for the broken hot path
npm run trace:fixed    # raw --trace-deopt --log-ic for the fixed hot path
npm run gate           # CI deopt-gate on the fixed path  -> PASS
npm run gate:broken    # CI deopt-gate on the broken path -> FAIL
npm run ts             # the TypeScript version
```

### Layout

```
ts-jit-deopt/
  README.md          ← this article
  event-source.js    ← heterogeneous event source (pure shape variation)
  bench.js           ← broken vs fixed timing harness
  broken/
    handler.js       ← the hot path (receives many shapes → megamorphic)
    drive.js         ← Stage-2 driver (replay corpus)
  fixed/
    event.js         ← canonical shape + boundary normalizer
    handler.js       ← the SAME hot path (receives one shape → monomorphic)
    drive.js         ← Stage-3 driver (normalized at the boundary)
  tsconfig.json      ← strict TS config for the example (npm run typecheck)
  eslint.config.js   ← Stage-6 static layer (JIT-friendliness lint rules)
  ci/
    deopt-gate.js    ← Stage-6 dynamic layer: fail CI on mono→megamorphic regression
    gate-driver.js   ← replays the corpus through the chosen handler
  .github/workflows/
    deopt-gate.yml   ← drop-in GitHub Actions job
  ts/
    example.ts       ← the typed version (boundary encoded in types)
```

## License

MIT © 2026 Eric San. See [LICENSE](./LICENSE).
