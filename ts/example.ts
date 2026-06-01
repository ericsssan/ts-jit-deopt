// The TypeScript version encodes the fix in the type system: a messy input
// union, a canonical class, and a single normalizer that is the ONLY bridge
// between them. With `strict` on and no `any`, the compiler refuses to let a
// RawEvent reach the hot path -- the same guarantee that keeps V8 monomorphic.
//
// Run with: npx tsx ts/example.ts   (or compile with tsc)

type RawEvent = {
  type: string;
  id: number | string | null;
  value?: number;
  meta?: unknown;
};

class Event {
  constructor(
    readonly type: string, // always string
    readonly id: number, // always number
    readonly value: number, // always number
  ) {}
}

// The ONLY place RawEvent becomes Event. Megamorphism is confined here.
function toEvent(raw: RawEvent): Event {
  const id =
    raw.id == null ? 0 : typeof raw.id === 'string' ? raw.id.length : raw.id;
  return new Event(
    typeof raw.type === 'string' ? raw.type : '',
    id,
    typeof raw.value === 'number' ? raw.value : 0,
  );
}

// Hot path is typed to the canonical shape -- the type system enforces monomorphism.
function handleEvent(event: Event): number {
  return event.id * 31 + event.type.length + event.value;
}

function run(events: Event[]): number {
  let acc = 0;
  for (let i = 0; i < events.length; i++) acc += handleEvent(events[i]);
  return acc;
}

function makeRaw(n: number): RawEvent[] {
  const out: RawEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 2
        ? { type: 'view', id: String(i), value: i * 2, meta: { src: 'b' } }
        : { type: 'click', id: i % 3 === 0 ? null : i, value: i * 2 },
    );
  }
  return out;
}

const events = makeRaw(1_000_000).map(toEvent); // normalize at the boundary
console.log('checksum:', run(events));
