# From Production Flamegraph to Fixed Megamorphic Call Site

*Profilers tell you where time goes. They don't tell you why the JIT gave up.*

---

There's a class of production performance problem that profilers can locate but not explain. The flamegraph is unambiguous — `handleEvent` is eating 40% of CPU. You open the function. It looks fine. A local microbenchmark runs fine. So you ship more aggressive caching, tune connection pools, maybe add an index. p99 ticks down a little and then climbs back up, because you didn't fix anything.

The problem isn't in the code. It's in what the runtime decided to do with it.

V8 optimizes by speculating. It watches the types and object shapes flowing through a function, compiles specialized machine code under the assumption those stay constant, and deoptimizes — throws that machine code away — the moment an assumption breaks. A related failure is megamorphism: a property access that has seen too many object shapes (more than four) gives up on its fast inline cache and degrades to a global hashtable lookup on every access. Neither of these shows up in source. They're runtime facts, invisible to the reader.

This is why profilers fail at the last mile. A profiler samples — it grabs call stacks at ~100Hz and aggregates. That's enough to tell you *where* time goes, but not enough to distinguish "this function is expensive because it does a lot of work" from "this function is expensive because V8 gave up on it and is executing it 10× slower than it should." The signal you'd need — inline-cache state transitions — is made of discrete events. You can't sample them. Miss one "monomorphic → megamorphic" transition and you've missed the diagnosis.

The right tool for IC state is V8's own logging: `--trace-deopt --log-ic`. It captures every transition exhaustively. But it's heavy — you can't run it in production — and it's only truthful if the inputs you feed it match production reality. Toy inputs produce toy results.

So you need both tools: production profiling to find what's worth investigating, and local exhaustive tracing to find out why. Neither replaces the other. This article is about the connection between them.

---

## Finding the right suspect

Not every hot function is worth investigating. The question isn't "is this function slow?" but "is this function slow *because V8 gave up on it*?" A function doing genuinely expensive work is a different problem — you can't JIT-optimize your way out of that.

What you're looking for is a function that's hot *and stuck in a lower optimization tier than it should be*. Modern profiling tools expose this. In Chrome DevTools' CPU profile view, frames are annotated with their optimization state. With `perf record` and `node --perf-basic-prof`, a flamegraph distinguishes JIT machine-code frames from interpreter frames — they look different. Continuous profilers like Datadog and Grafana Pyroscope do the same thing at always-on production scale, at 1–5% overhead.

The tell is a function that appears consistently hot but isn't doing anything obviously expensive. Fast code running slowly. That's the JIT signature.

In this example, that function is `handleEvent`.

---

## Getting real inputs

The most common way to botch this is to trace with synthetic inputs. You write a quick loop, generate some fake events, feed them through, see everything green, conclude your function is fine. It isn't fine — you just didn't give V8 the shapes that break it.

Megamorphism is caused by shape *variety*. A single synthetic event has one shape. Production traffic has dozens of producers, each emitting objects constructed in slightly different ways. Some have extra fields. Some initialize properties in a different order. Some build objects incrementally. Each variation produces a different hidden class, and it only takes five distinct hidden classes to push a property access off its fast inline cache.

The driver has to replay that variety. In this repo, `broken/drive.js` synthesizes the diversity that `event-source.js` describes:

- some events carry an extra `meta` or `tag` field → a different hidden class;
- one producer emits fields in a **different property order** → another hidden class;
- one builds the object **incrementally** (`e.id = …; e.type = …`) → yet another transition path.

Every event carries the same field names and value types. The *only* variable is the hidden class. That isolation is what makes the diagnosis clean.

In production, you'd capture a sampled corpus of real payloads from the deserialization boundary — 1-in-N, PII-scrubbed — and replay those. The distribution of shapes in the corpus has to match the distribution in production traffic, or the trace lies to you.

---

## Discovering the shapes automatically

Manually crafting shape variety — as `event-source.js` does — works, but it requires you to already know which structural mutations your codebase produces. In practice you're guessing. A cleaner approach is to use IC state itself as the feedback signal: generate structural mutations systematically, run them through the hot path under `--log-ic`, observe the IC severity, and stop when you've found the minimal set that pushes the function to megamorphic.

This repo ships a shape fuzzer that does exactly that:

```bash
npm run fuzz
```

It works by adding one new shape variant per round and probing IC state after each:

```
[shape-fuzzer] target: megamorphic  (8 strategies in catalog)

  round  1  [literal-canonical] ... monomorphic
  round  2  [literal-canonical, literal-id-first] ... polymorphic
  round  3  [literal-canonical, literal-id-first, literal-value-first] ... polymorphic
  round  4  [literal-canonical, ..., incremental-t-i-v] ... polymorphic
  round  5  [literal-canonical, ..., incremental-i-t-v] ... megamorphic ← STOP

[shape-fuzzer] megamorphic reached with 5 shape(s):

   1. literal-canonical     { type, id, value }  — baseline literal order
   2. literal-id-first      { id, type, value }  — different property order
   3. literal-value-first   { value, type, id }  — yet another order
   4. incremental-t-i-v     e.type; e.id; e.value  — incremental, same order as canonical
   5. incremental-i-t-v     e.id; e.type; e.value  — incremental, different order
```

The result is more interesting than the manually-coded `event-source.js` example: **extra fields aren't needed to trigger megamorphism**. Five different property orderings — three literal, two incremental — are sufficient. The fuzzer found this automatically; the hand-written example mixed in extra fields because that's the intuitive explanation for shape variety, but the IC doesn't care about field names as much as it cares about initialization order.

The minimal triggering set is written to `fuzzer/corpus.json`, which can seed the CI gate for functions where you don't have a production corpus yet. The fuzzer can also target the polymorphic threshold — useful for catching IC degradation earlier, before it goes fully megamorphic:

```bash
npm run fuzz:polymorphic   # stops at 2 shapes (mono→poly transition)
```

Extend the strategy catalog in `fuzzer/shape-gen.js` to cover mutations specific to your codebase — prototype chains, frozen objects, class instances vs. plain objects.

---

## What the trace actually shows

With a representative corpus, you run the driver under IC logging:

```bash
npm run trace:broken   # node --trace-deopt --log-ic broken/drive.js
```

Parsing the IC log (`npm run gate:broken`) shows this:

```
handler.js
  handleEvent
    10  return event.id * 31 + event.type.length + event.value
          ● LoadIC  .id     MEGAMORPHIC  (5+ maps)    [red]
          ● LoadIC  .type   MEGAMORPHIC  (5+ maps)    [red]
          ● LoadIC  .value  MEGAMORPHIC  (5+ maps)    [red]
```

Three property accesses, all megamorphic. More than four hidden classes flowed through each one, so V8 gave up on the fast path and does a hashtable lookup on every access, every iteration. The megamorphic loads also block inlining — V8 won't inline a function whose call sites are megamorphic — so callers pay the full call overhead too.

The function didn't get slower because someone changed it. It got slower because the inputs changed it — more producers, more shape variety, and V8's inline caches quietly fell off a cliff.

> `--log-ic` is the flag name on Node 20+. Older V8 used `--trace-ic`. Modern V8 has also fixed many of the classic "deopt killers" from 2015-era guides (try/catch, generators, arguments objects). Measure actual IC state rather than applying a blacklist inherited from old blog posts.

---

## The fix is a boundary, not a rewrite

The instinct, when you find a megamorphic function, is to rewrite it. That's almost never right. The function isn't broken. The *inputs* are the problem.

The fix is to normalize to one canonical shape at the edge — before the hot path ever sees the data:

```js
class Event {
  constructor(type, id, value) {
    this.type = type;
    this.id = id;
    this.value = value;
  }
}

function toEvent(raw) {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const rid = raw.id;
  const id = rid == null ? 0 : typeof rid === 'string' ? rid.length : rid;
  const value = typeof raw.value === 'number' ? raw.value : 0;
  return new Event(type, id, value);
}
```

Every `Event` instance is constructed the same way, in the same order, so every instance shares one hidden class. `handleEvent` never changes:

```js
function handleEvent(event) {
  return event.id * 31 + event.type.length + event.value;
}
```

`broken/handler.js` and `fixed/handler.js` are byte-for-byte identical. The only change is in the driver, which adds one boundary pass before the hot loop:

```js
const events = makeEvents(2_000_000).map(toEvent); // unify the shape, once
```

The result:

```
events: 2,000,000, hot iterations: 20

broken   229.4ms   (megamorphic loads, un-inlinable call)
fixed     54.5ms   (monomorphic loads, inlined)        ← ~4.2× faster
```

Identical checksums. The entire gain came from shape. (~4–5× is stable across runs; absolute times vary by machine.)

There's a subtlety worth naming. `toEvent` also reads `.id`/`.type`/`.value` off heterogeneous `raw` objects — so its loads are megamorphic too. You haven't eliminated the megamorphic reads. You've confined them:

- **Before:** 40M megamorphic accesses (2M events × 20 hot iterations).
- **After:** 2M megamorphic accesses, once, at the boundary. The 40M-iteration hot loop is monomorphic.

You paid the unavoidable cost of heterogeneous input once, at the edge, and kept it out of the path that matters.

---

## Closing the loop

Once you have a fix, confirm it with the same tool that found the problem. Re-run the trace on the fixed driver:

```bash
npm run trace:fixed
npm run gate          # parsed verdict: all monitored IC sites monomorphic
npm run bench         # ~4-5× speedup confirmed
```

Then deploy and confirm on the same continuous profiler that surfaced `handleEvent` — that it's dropped out of the hot list. Using a different verification tool than the one that found it is how fixes slip through unconfirmed.

---

## Making it stick

A fix that isn't enforced rots. Six months from now, a new producer adds a field, an engineer refactors the constructor, and megamorphism creeps back. Nobody notices because there's no signal until the profiler starts climbing again.

There are two enforcement layers. The first is a linter. [`eslint.config.js`](./eslint.config.js) bans the locally-decidable shape-wreckers: `delete` (pushes objects into dictionary mode), `with`, `arguments` leakage, `eval`, `no-param-reassign`, and `@typescript-eslint/no-explicit-any` for `.ts` files. Rules are `warn`-severity in the editor but `npm run lint` runs `--max-warnings=0`, so any violation fails CI. A linter can only catch what's visible from syntax; it can't see cross-function megamorphism at runtime.

The second layer is a deopt-gate: a CI job that runs the driver under V8 IC logging, parses the log, and fails the build if any watched hot-path access regresses from monomorphic back to megamorphic. JIT-friendliness is a runtime property — the enforcement has to be runtime too.

This repo ships one: [`ci/deopt-gate.js`](./ci/deopt-gate.js) + [`ci/gate-driver.js`](./ci/gate-driver.js) + a [GitHub Actions workflow](./.github/workflows/deopt-gate.yml).

```bash
npm run gate        # PASS (exit 0) — fixed path is monomorphic
npm run gate:broken # FAIL (exit 1) — broken path is megamorphic
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

The gate watches by file rather than property name because `toEvent` in `fixed/event.js` legitimately reads megamorphic input — that's its job. Watching `handler.js` and ignoring `event.js` means boundary megamorphism doesn't trigger it. Configure via env: `GATE_WATCH`, `GATE_IGNORE`, `GATE_MAX_SEV` (set to `2` to also fail on polymorphic).

Keep the corpus fresh from production. The gate only guards the paths the corpus exercises.

---

## The TypeScript angle

The typed version ([`ts/example.ts`](./ts/example.ts)) encodes the boundary in the type system:

```ts
type RawEvent = { type: string; id: number | string | null; value?: number; meta?: unknown };
class Event { constructor(readonly type: string, readonly id: number, readonly value: number) {} }
function toEvent(raw: RawEvent): Event { /* the only bridge */ }
function handleEvent(event: Event): number { /* hot path typed to the canonical shape */ }
```

With `strict` on and no `any`, the compiler refuses to let a `RawEvent` reach `handleEvent`. This turns out to be the same constraint as the runtime fix — one canonical shape at the boundary, nothing else beyond it. Type safety and JIT-friendliness are the same discipline. The type system just makes violations a compile error instead of a slow flamegraph three months later.

---

## The loop

Sampling finds the suspect. Exhaustive tracing convicts it. You fix the shape — not the function — at the boundary. The gate makes the fix permanent. You confirm with the same profiler that found it.

That's the loop. None of the individual pieces are new. The connection between them is what's been missing.

---

## Running this repo

> Every code snippet in this article is runnable here. `npm run bench` for the numbers; `npm run trace:broken` / `npm run trace:fixed` for the raw IC trace; `npm run gate` for the parsed hot-path verdict.

```bash
npm install            # eslint, typescript-eslint, v8-deopt-parser
npm run bench          # broken vs fixed timing
npm run typecheck      # strict tsc on the TS example
npm run lint           # static JIT-friendliness rules
npm run trace:broken   # raw --trace-deopt --log-ic for the broken hot path
npm run trace:fixed    # raw --trace-deopt --log-ic for the fixed hot path
npm run gate           # CI deopt-gate on the fixed path  -> PASS
npm run gate:broken    # CI deopt-gate on the broken path -> FAIL
npm run fuzz           # shape fuzzer: find minimal inputs that cause megamorphism
npm run fuzz:polymorphic # same, stopping at the polymorphic threshold
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
    drive.js         ← driver (replay corpus)
  fixed/
    event.js         ← canonical shape + boundary normalizer
    handler.js       ← the SAME hot path (receives one shape → monomorphic)
    drive.js         ← driver (normalized at the boundary)
  tsconfig.json      ← strict TS config for the example (npm run typecheck)
  eslint.config.js   ← static layer (JIT-friendliness lint rules)
  ci/
    deopt-gate.js    ← dynamic layer: fail CI on mono→megamorphic regression
    gate-driver.js   ← replays the corpus through the chosen handler
  fuzzer/
    shape-gen.js     ← structural mutation strategies (extend this for your codebase)
    fuzz-driver.js   ← hot-path driver run under --log-ic by the fuzzer
    run-fuzzer.js    ← discovery loop: add shapes until IC degrades, report minimal set
  .github/workflows/
    deopt-gate.yml   ← drop-in GitHub Actions job
  ts/
    example.ts       ← the typed version (boundary encoded in types)
```

## License

MIT © 2026 Eric San. See [LICENSE](./LICENSE).
