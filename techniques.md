# Aparecium — Techniques actually used

Each entry: what it is, where it lives, why it was chosen, how it works here,
what else was considered, its limits, how it was verified, and its cost.

> **An important distinction.** Some techniques below are algorithms Aparecium
> itself runs (a heap, a ring buffer, a seeded generator). Others describe
> *behaviour that is modelled inside a simulated component*. Aparecium does not
> implement a database, a cache, or a network stack. It implements a queue with
> an average service time and calls that a database. Nothing here should be read
> as "we built a database".

---

## 1. Graph representation and route validation

**What it is.** Storing the drawing as a set of components plus a list of
connections, and walking it to answer "where does a request from this client
actually go?".

**Where.** `src/simulation/routing.ts`.

**Why.** A connection on the canvas means "these two *can* talk". If it meant
"send everything everywhere", a cache-aside diagram would be indistinguishable
from a broadcast. Something has to decide what the picture means, and say so
when the picture is ambiguous.

**How it works here.** Three structures are built from the document:

```ts
nodesById: Map<string, ArchNode>   // O(1) lookup by id
outgoing:  Map<string, ArchEdge[]> // adjacency list, forwards
incoming:  Map<string, ArchEdge[]> // adjacency list, backwards
```

Then each client is checked: exactly one outgoing connection, to a server; that
server has at most one database and at most one cache and nothing else;
databases and caches have no outgoing connections at all. Finally a
breadth-first walk from every valid client marks reachable components; anything
unmarked is provisioned but carries no traffic, which is a warning rather than
an error because it still costs money.

Every failure carries a message and a hint:

> Cannot run: "Web users" has 2 outgoing connections, so Aparecium cannot tell
> where a request should go.
> *This version supports exactly one operation path per client. Keep one
> connection, or add a second client for the second path.*

**Alternatives.** Depth-first search would find reachability equally well; BFS
was chosen because the natural next feature (shortest path when fan-out is
allowed) wants BFS anyway. Storing only an edge list and scanning it per query
would be O(E) per lookup instead of O(1).

**Limits.** Exactly three shapes are supported today: client→server,
client→server→database, and cache-aside. Fan-out, chained servers and multiple
operation types per client are not.

**Verified by.** Six tests in `tests/engine.test.ts` under "acceptance 16",
covering ambiguous clients, a client wired straight to a database, a database
that calls something, two databases behind one server, an unreachable component
(warning, still runs) and an empty canvas.

**Cost.** Building the graph is O(V + E). Validation is O(V + E). BFS is
O(V + E).

---

## 2. Event scheduling with a binary min-heap

**What it is.** A queue that always hands back the earliest scheduled event.

**Where.** `src/simulation/event-queue.ts`, used by `src/simulation/engine.ts`.

**Why.** Discrete-event simulation only ever asks one question: what happens
next? A heap answers it in O(log n) without sorting anything.

**How it works here.** A standard array-backed binary heap with sift-up on push
and sift-down on pop. The comparison is the important part:

```ts
if (a.time !== b.time) return a.time < b.time;
return a.seq < b.seq;   // insertion order breaks ties
```

Without the sequence number, two events scheduled for the same simulated
millisecond could come back in either order and identical inputs would stop
producing identical results.

**Alternatives.** Re-sorting a pending array after every insert is O(n log n)
per event. A calendar queue is faster for very large, tightly clustered event
sets but needs tuning and is far harder to read; the heap is not the bottleneck
here.

**Limits.** No support for cancelling an already-scheduled event. The engine
never needs it: it schedules only events that will definitely happen.

**Verified by.** `tests/primitives.test.ts` — timestamp ordering, equal-time
ordering across four events, and ordering preserved when new events are pushed
during draining.

**Cost.** Push and pop O(log n); peek O(1); memory O(n).

---

## 3. Seeded pseudorandom numbers with independent streams

**What it is.** Random numbers that are the same every time for the same seed.

**Where.** `src/simulation/rng.ts`.

**Why.** "Same input and seed produce identical results" is acceptance check 1.
It is also what makes a before-and-after comparison mean anything.

**How it works here.** `mulberry32`, a 32-bit generator that fits in a dozen
lines. `RandomStreams` hands out one generator per *name*, seeded from the run
seed mixed with an FNV-1a hash of the name:

```ts
const derived = (Math.imul(seed ^ hashString(name), 0x9e3779b1) ^ hashString(name)) >>> 0;
```

Per-stream generation is the point. With one global generator, adding a second
cache would shift every draw the first cache saw, and two runs that differ only
in an unrelated component would diverge for no reason.

**Alternatives.** `Math.random()` cannot be seeded. A cryptographic generator is
far slower and buys nothing — this is a simulation, not a lottery.

**Limits.** A 2^32 period. That is ample for the sample sizes here; a run that
drew more than four billion numbers would hit the event limits long first.

**Verified by.** `tests/primitives.test.ts` — same seed gives the same sequence,
different seeds diverge, named streams are independent, and 20,000 Bernoulli(0.8)
draws land between 78% and 82%. `tests/engine.test.ts` asserts two full runs of
a cache-aside design serialise to a byte-identical result.

**Cost.** A handful of integer operations per draw.

---

## 4. FIFO queues on a ring buffer

**What it is.** A waiting line where joining and leaving are both O(1).

**Where.** `src/simulation/ring-queue.ts`. Used for the server admission queue,
the CPU wait queue, the database and cache queues, and each link's transmission
queue.

**Why.** `Array.prototype.shift()` is O(n) in the general case because it
re-indexes the array. Aparecium exists to show what happens when queues get
long, so the one operation that must not degrade is dequeuing from a long queue.

**How it works here.** A fixed-capacity array plus a head index and a count.
Pushing writes at `(head + count) % capacity`; shifting reads at `head` and
advances it. When full, capacity doubles and the contents are copied once in
order.

**Alternatives.** A linked list is also O(1) but allocates a node per entry.
`shift()` was rejected on complexity grounds.

**Limits.** Capacity never shrinks. A queue that briefly reached 100,000 keeps
that array for the rest of the run.

**Verified by.** `tests/primitives.test.ts` — 100 items in and out in order past
the initial capacity of 2, and correct wrap-around under interleaved
push/shift.

**Cost.** Push and shift amortised O(1); memory O(peak length).

---

## 5. Resource pools, admission control and queues *(modelled behaviour)*

**What it is.** Three separate limited resources on a server, plus a slot-limited
service station for databases and caches.

**Where.** `src/simulation/models/server.ts`, `src/simulation/models/station.ts`,
orchestrated by `src/simulation/engine.ts`.

**Why.** Conflating CPU, concurrency and memory is exactly the confusion the
product exists to dispel.

**How it works here.** A server tracks:

- `cpuBusy` against `cpuSlots` — held only while computing,
- `admittedCount` against `concurrencyLimit` — held for the whole request,
- memory as a number: `baseline + admitted × perRequest + queued × perQueued`.

Admission: if a concurrency slot is free *and* memory allows, admit. Otherwise
queue, if the queue has room *and* memory allows. Otherwise reject, recording
whether it was the queue or the memory budget.

CPU work per request is divided evenly across the compute segments between
downstream calls. A request gives its CPU slot back before calling the database
and takes another one when the answer comes back, but never gives up its
concurrency slot or its memory. That is the whole mechanism behind "more CPU
helps here, more RAM alone does not".

Promotion from the waiting queue checks memory as `memoryFor(+1 admitted,
−1 queued)`, because the promoted request stops being queued at the same moment
it starts being admitted.

**Alternatives.** A single "capacity" number would have been much simpler and
would have made acceptance checks 4 and 5 impossible to satisfy honestly.

**Limits.** CPU slots are a deliberate simplification of usable compute
capacity — not cores, not threads, not a cgroup quota. Memory is a number; no
gigabytes are ever allocated. Service times are user-set averages with no
variance.

**Verified by.** `tests/engine.test.ts` — queue growth and rejection under
overload, memory-limited rejection, unfinished requests when the drain window
ends, four CPU slots beating one on a CPU-bound design, and doubling RAM alone
changing *nothing at all* (an exact equality assertion, not an approximate one).

**Cost.** O(1) per admission, release and promotion.

---

## 6. Directional link transmission *(modelled behaviour)*

**What it is.** One message at a time per direction, for a duration proportional
to its size, then a fixed delay.

**Where.** `src/simulation/models/link.ts`.

**Why.** It reproduces the two things that actually matter to an architecture
sketch: a big response on a thin link is slow, and messages queue behind it.

**How it works here.** Each drawn connection becomes two `LinkChannel` objects,
one per direction, because a request going out and a response coming back do not
share a queue. A message starts when the channel is idle; transfer time is
`bytes × 8 / (Mbps × 1000)` milliseconds; delivery is scheduled one propagation
delay after transmission ends.

**Alternatives.** A packet-level model would be far more faithful and far more
work, and would need a congestion-control implementation to mean anything.

**Limits.** No congestion control, no loss, no retransmission, no windowing, no
TCP or QUIC behaviour, no shared physical medium between links. This is stated
in the interface next to the setting and in every run's assumptions list.

**Verified by.** `tests/engine.test.ts` — an exact transfer-time calculation for
a 1 kB and a 1 MB response on a 10 Mbps link, and a saturated return link that
reaches over 95% utilisation with a queue peak above 1.

**Cost.** O(1) per message; two events per message.

---

## 7. Streaming metrics, bounded histograms and time-weighted averages

**What it is.** Summarising millions of events in constant memory.

**Where.** `src/simulation/metrics.ts`.

**Why.** Keeping every latency sample makes memory grow with run length. The
engine must be able to process five million events without the browser noticing.

**How it works here.** Three tools:

- `StreamingStat` — count, sum, min, max updated in place.
- `BoundedHistogram` — 120 exponentially spaced buckets from 0.1 ms with a ratio
  of 1.15, so every bucket is 15% wide *relatively*. The p95 is the upper edge of
  the bucket the quantile falls in, and the interface reports the bracket
  (`between 35.42 ms and 40.74 ms`) and the precision, rather than pretending to
  an exact figure.
- `TimeWeightedAccumulator` — integrates a step function. Call `set(time, level)`
  whenever a level changes; it accumulates `level × elapsed` as area. The average
  is area ÷ elapsed, which is what "time-weighted utilisation" and "average queue
  length" actually mean. Sampling instead would bias short spikes.

**Alternatives.** A t-digest gives better quantile accuracy at similar cost and
is the obvious upgrade; fixed buckets were chosen because their error is trivial
to state honestly in one sentence.

**Limits.** Values below 0.1 ms fall in an underflow bucket and values above
~32 minutes in an overflow bucket. Both are handled, neither is likely.

**Verified by.** `tests/primitives.test.ts` — the true p95 of 1..1000 falls
inside the reported bounds; an empty histogram returns zero; and a level of 4
held for 90 of 100 ms averages to exactly 3.6.

**Cost.** O(1) per record; memory is a fixed 120 floats per histogram.

---

## 8. Web Worker communication and cancellation

**What it is.** Running the simulation off the main thread and being able to stop
it.

**Where.** `src/workers/simulation.worker.ts`, `src/workers/client.ts`,
`src/workers/protocol.ts`.

**Why.** A long run must not freeze the interface, and Cancel must actually
cancel.

**How it works here.** The engine exposes `step(maxEvents)` rather than a
run-to-completion loop. The worker calls it repeatedly for about 12 ms, then
yields with `setTimeout(0)`:

```ts
const started = Date.now();
while (Date.now() - started < CHUNK_BUDGET_MS) {
  if (engine.step(EVENTS_PER_STEP).done) { done = true; break; }
}
// ...
setTimeout(() => tick(runId), 0);
```

The `setTimeout` is the mechanism, not a formality. A worker is single-threaded;
only a macrotask boundary lets a queued `cancel` message be delivered. A
microtask (`queueMicrotask`, `Promise.resolve().then`) would run before the
message queue and Cancel would do nothing until the run finished.

Progress is posted at most every 120 ms, so a five-million-event run produces a
few dozen messages rather than five million.

Every message carries a `runId`. The client settles a superseded run's promise
so nothing hangs, but forwards progress only for the current run and lets the
store discard any result whose id is no longer current. If a `Worker` cannot be
constructed at all, the client runs the same chunked loop on the main thread.

**Alternatives.** `worker.terminate()` cancels instantly but throws away the
partial result and the worker itself; the chosen design returns a usable
`cancelled` result. `SharedArrayBuffer` with an atomic cancel flag would be
lower latency but needs cross-origin isolation headers, which a plain static
host may not provide.

**Limits.** Cancellation latency is bounded by one chunk, about 12 ms. The
document is structured-cloned into the worker on every run — a few hundred
kilobytes at most.

**Verified by.** `e2e/starter-workflow.spec.ts` clicks Run then Cancel and
asserts the result comes back as `cancelled` with fewer than the configured
20,000 simulated seconds. `tests/engine.test.ts` covers the engine-level
`cancel()` including the measurement-interval rule.

---

## 9. Decimal arithmetic and unit conversion for money

**What it is.** Doing cost arithmetic without binary floating point.

**Where.** `src/pricing/pricing.ts`, using `decimal.js`.

**Why.** `0.1 × 730` in binary floating point is `73.00000000000001`. Across
many lines that error accumulates into the total, not just the display.

**How it works here.** Rates are **decimal strings** in the catalog JSON, so they
never pass through a float at all. `Decimal` is configured once with
`{ precision: 30, rounding: ROUND_HALF_UP }`. Each line is computed at full
precision; the displayed amount is `toFixed(2)`; the total is the sum of the
*unrounded* line amounts, rounded once at the end.

Unit conversions are explicit and named: `HOURS_PER_MONTH = 730`,
`SECONDS_PER_MONTH = 730 × 3600`, `BYTES_PER_GB = 1e9` (decimal GB, matching how
providers bill transfer).

A missing rate is `null`, which produces an unpriced line excluded from the
total and carrying the reason. A charge absent from a profile does not apply at
all. Neither is ever zero.

**Alternatives.** Integer cents overflow badly for per-GB rates with four
decimal places. Floats with display rounding hide the error rather than removing
it.

**Limits.** One currency per catalog; no conversion between currencies.

**Verified by.** `tests/pricing.test.ts` — `0.10 × 730` is exactly `"73.00"`;
outbound transfer of 1 GB over 20 s projects to exactly `131400.000` GB and
`"11826.00"`; doubling the run duration at the same traffic rate leaves the
monthly total identical; an unpriced charge stays out of the total.

---

## 10. Runtime validation with Zod

**What it is.** Checking the shape of data at run time, not just at compile time.

**Where.** `src/domain/schema.ts` (documents, projects, exports),
`src/catalogs/types.ts` (catalog files), `src/storage/run-schema.ts` (historical
results, costs and catalog snapshots).

**Why.** TypeScript types vanish when the code is compiled. Three inputs cross a
trust boundary and could be anything: an imported JSON file, a record read back
from IndexedDB, and a catalog fetched over the network.

**How it works here.** Schemas mirror the types with real bounds — a server has
between 1 and 4096 CPU slots, a hit rate is between 0 and 1, a document has at
most 400 components. `z.discriminatedUnion('kind', ...)` matches the component
union exactly. Two safety rules are enforced above the schema: a size limit
before parsing (20 MB), and an explicit refusal of a schema version *higher*
than this build understands:

> This file uses export format version 99, but this build of Aparecium
> understands version 1. Update Aparecium to open it.

Backwards compatibility uses schema defaults: `pricingOverrides` was added after
the first documents existed, so it is `.default({})` and an older document
validates and gains an empty object rather than failing. A record read back
from IndexedDB never meets the schema, though — it comes back exactly as it was
written — so `upgradeDocument` in `src/domain/defaults.ts` fills the same
defaults for the fields added since (entry 067 found the queue's failure and
retry settings missing from it, and their controls reopening blank). The two
must agree, and a test holds them to it. The version refusal applies on both
paths too: a saved project stamped with a newer schema version is refused when
opened, left as it is, and never stamped down.

**Alternatives.** Hand-written type guards are more code and drift from the
types. Trusting the input is how a corrupt file becomes a blank screen.

**Limits.** Run validation checks structure and supported schema versions, not
whether an imported author's measurements are truthful. Historical runs are
not recalculated. The histogram's open-ended overflow upper bound is restored
from JSON null to Infinity; other numeric metrics must be finite.

**Verified by.** `tests/persistence.test.ts` — round trip, refusal of a newer
export format, refusal of a newer document schema, invalid JSON, oversized
input, a valid-JSON-but-wrong-shape file, an unreadable run being skipped with a
note, and an old document without `pricingOverrides` being accepted.

---

## 11. Local persistence and autosave with Dexie

**What it is.** Saving to IndexedDB in the browser, with no server.

**Where.** `src/storage/db.ts`, `src/storage/runs.ts`, `src/storage/exchange.ts`.

**Why.** IndexedDB is the only browser store that can hold structured objects of
this size. Dexie removes the request/transaction ceremony without hiding the
transaction model.

**How it works here.** Three tables — `projects`, `runs`, `catalogs` — declared
with `.version(1).stores({...})`. Autosave is debounced at 600 ms with a visible
status. A failed save sets an error state and keeps the in-memory work, pointing
at Export. Saves are serialized to keep snapshot order. Switching projects
flushes pending edits and waits for success; a failed save keeps the current
project open. Imports use fresh run IDs and one transaction for the project
and history. Snapshot comparison restores stale-result labels after reopening.

Two things matter more than the plumbing:

*Deep copies.* `createRunRecord` clones the document, the catalog rows it used,
the result and the cost with `structuredClone`. A run is evidence; if it held a
reference to the live document, editing the canvas would rewrite history.

*Transactions.* Deleting a project must delete its runs, and either both happen
or neither does:

```ts
await db.transaction('rw', db.projects, db.runs, async () => {
  await db.runs.where('projectId').equals(id).delete();
  await db.projects.delete(id);
});
```

**Alternatives.** `localStorage` is synchronous, string-only and capped around
5 MB. Raw IndexedDB is workable but verbose enough to invite mistakes.

**Limits.** No quota handling. Runs are pruned to the newest 25 per project with
no interface to manage them.

**Verified by.** `tests/persistence.test.ts` proves the deep-copy property
directly: it edits a live project after a run and asserts the run's stored
document is untouched. The Playwright suite covers save-and-reload in a real
browser.

---

## 12. Undo and redo with bounded snapshots

**What it is.** Two stacks of previous document states.

**Where.** `src/features/editor/store.ts` — `mutate`, `beginUndoGroup`,
`commitUndoGroup`, `undo`, `redo`.

**Why.** Documents are small and plain, so whole-state snapshots are simpler and
less bug-prone than inverse operations.

**How it works here.** `mutate(fn)` clones the current document, applies `fn` to
the clone, pushes the *previous* document onto the undo stack (capped at 60) and
clears the redo stack.

Dragging is the interesting case. One drag emits dozens of position changes, and
each one becoming an undo step would be useless. Position changes are applied
with `{ undoable: false }`, and a single snapshot is captured on
`onNodeDragStart` and committed on `onNodeDragStop`. One drag, one undo.

**Alternatives.** A command pattern with inverse operations uses less memory but
needs an inverse for every edit type, including "replace the whole canvas with a
template".

**Limits.** History is in memory only and is cleared when a project is opened or
imported.

**Verified by.** Exercised in the browser (add a component, undo, confirm the
node and its validation error disappear) and in `e2e/starter-workflow.spec.ts`,
which adds an unconnected client, asserts Run becomes disabled, undoes, and
asserts Run is enabled again.

**Cost.** O(document size) per edit; at most 60 snapshots each way.

---

## 13. Two themes from one set of CSS custom properties

**What it is.** Light and dark without any component knowing which is active.

**Where.** `src/app/styles.css` (the two value sets), `tailwind.config.js` (the
semantic names), `src/app/theme.ts` (the choice and its persistence).

**Why.** With two themes, any component that names a hue is a bug waiting to
happen: someone changes one theme and forgets the other. Naming *roles* makes
that structurally impossible.

**How it works here.** Every colour is a custom property, defined twice:

```css
:root                    { --surface: #ffffff; --ink: #1c1917; --accent: #6366f1; }
:root[data-theme='dark'] { --surface: #14171f; --ink: #e8ecf3; --accent: #7c6cf0; }
```

Tailwind maps names onto them (`surface: 'var(--surface)'`), so a component
writes `bg-surface text-ink-2` and is correct in both. `theme.ts` resolves the
choice — an explicit one from `localStorage`, otherwise light — and applies it
to `document.documentElement` *before* React renders, so there is no flash of
the wrong theme. Light is the absence of the attribute, so the default needs no
JavaScript at all.

The theme is deliberately not in the editor store: it is a browser preference,
and it must never end up in a saved project, an export, or a run snapshot.

**Alternatives.** Tailwind's `dark:` variant on every colour utility doubles
every class and is easy to forget on one of them. A CSS-in-JS theme object would
add a dependency and a runtime cost for something the platform does natively.

**Limits.** Tailwind's opacity modifiers (`bg-accent/10`) do not work on plain
hex variables, so tinted backgrounds are explicit `-soft` colours. That turned
out to be an improvement: the dark theme picks a tint that actually reads on a
dark ground rather than a washed-out one.

**Verified by.** `e2e/starter-workflow.spec.ts` asserts that a fresh visit is
light, that the toggle sets `data-theme="dark"`, that the choice survives a
reload, and that switching back removes the attribute. Both themes were
inspected in a browser at 1600x1000.

---

## 14. Framing the diagram in the part of the canvas that is visible

**What it is.** Working out the camera position for a canvas that has opaque
panels floating on top of it.

**Where.** `FitToVisibleArea` in `src/features/editor/Canvas.tsx`, fed by a
`ResizeObserver` in `src/app/App.tsx`.

**Why.** React Flow's `fitView` centres the diagram in its whole container. The
container is the whole viewport, but the side panel and the results sheet sit on
top of parts of it, so "centred" put components underneath them — including on
first load, which is the worst possible moment.

**How it works here.** The app measures the bottom stack (which changes height
as the results sheet is closed, collapsed or expanded) and passes that plus the
side panel width to the canvas. The canvas then computes the camera itself:

```ts
const visibleWidth  = width  - rightInset;
const visibleHeight = height - topInset - bottomInset;
const zoom = Math.min(1, (visibleWidth - m*2) / diagramWidth,
                         (visibleHeight - m*2) / diagramHeight);
setViewport({ zoom,
  x: visibleWidth / 2  - diagramCentreX * zoom,
  y: topInset + visibleHeight / 2 - diagramCentreY * zoom });
```

Bounds come from the document's node positions plus a fixed `NODE_WIDTH` and
`NODE_HEIGHT` declared once and used for both the CSS box and this arithmetic,
so the two cannot drift apart.

**Alternatives, and two things that did not work.** React Flow's own
`getNodesBounds` was the first attempt, gated on `useNodesInitialized()` — but
that hook is permanently false in this app, because `onNodesChange` deliberately
drops everything except position changes, so a controlled flow never records
that its nodes were measured. Accepting dimension changes would mean a second
source of truth for node state, which is exactly what technique 15 exists to
avoid. Separately, `setViewport` with a `{ duration }` transition is silently
dropped while React Flow is still building its pan/zoom instance — which is
precisely when this first runs — so the fit is applied without one.

**Limits.** It re-frames when components are added or removed and when a panel
opens or closes, but never during a drag, so it cannot fight with panning.

**Verified by.** Measuring the live DOM transform: identity before the fix,
`translate(19.1px, 143.5px) scale(0.922)` after. The Playwright suite clicks a
component *after* a run, which only passes if the results sheet is not covering
it.

---

## 15. Deriving React Flow's state from the document

**What it is.** The canvas library renders the graph but does not own it.

**Where.** `src/features/editor/Canvas.tsx`.

**Why.** With two sources of truth, undo, autosave, export and validation each
need their own synchronisation path, and they will disagree eventually.

**How it works here.** `nodes` and `edges` are `useMemo` projections of the
document plus the current selection plus the validation results. Every gesture —
drag, connect, delete, click — is translated into a store mutation, and the new
document flows back out as new props. Validation issues are indexed into sets of
node and edge ids once per render so each node knows in O(1) whether to draw an
error ring.

**Alternatives.** React Flow's `useNodesState` hook owns the state internally,
which is convenient for a demo and wrong for an application with undo and
persistence.

**Connection points.** Each component has one handle per side, all of type
`source`, with `connectionMode={ConnectionMode.Loose}`. In loose mode a source
handle also accepts an incoming connection, so a connection can be dragged
between any two edges of any two components without hunting for the one correct
dot. The handle ids are never read: `onConnect` only needs which node the drag
started from and which it ended on. Handles are invisible until the pointer is
near a component, so the diagram stays clean.

**Telling React Flow the nodes are already measured.** Deriving the node
objects from the document means handing React Flow a *new* object for every node
on every edit. React Flow measures each node's handle positions from the DOM and
caches them, and `adoptUserNodes` throws that cache away whenever the node it is
given carries no `measured` size — it reads the absence as "this node was
re-initialised, measure it again". An edge whose endpoints have no handle
positions cannot be placed, and `EdgeWrapper` renders `null` for it. So every
edit unmounted every connection for one frame and remounted it the next: the
lines flickered and, because SMIL animations live and die with their element,
the traffic on them restarted. Since the card is a fixed size the honest fix is
to say so — the nodes carry `measured: { width, height }` alongside `width` and
`height`, the cached handle positions survive, and the connections are never
torn down by an edit. If the real size ever drifts from the constants, React
Flow's resize observer notices the difference and re-measures.

**One component, one name.** `COMPONENT_LABELS` is the only place a component
type is named. Templates build their nodes from it rather than from string
literals, so a type cannot acquire a second name by drift — the starter used to
seed "App server" under a type called "Application Server", which made two boxes
on one canvas look like two different things. Node cards print the type only
when the name does not already say it, so a default-named component does not
show the same words twice. Documents saved before a default name changed are
translated by `normaliseComponentNames` when they are opened, narrowly enough
that a name someone typed themselves is never touched.

**Limits.** A full document clone per edit. Fine at this scale.

---

## 16. Showing the simulation on the diagram

**What it is.** Traffic drawn moving along the connections while a run happens,
and each component carrying its own result afterwards.

**Where.** `FlowEdge` and `ComponentNodeView` in
`src/features/editor/Canvas.tsx`; `src/features/results/node-metrics.ts`.

**Why.** A results table answers "how did the system behave". Standing in front
of a diagram, the question is usually narrower: how did *this box* behave, and
which connections did the traffic actually use.

**How it works here.** Two independent pieces.

*Packets.* Each connection renders three SVG circles that follow the edge's own
bezier path with staggered start times:

```tsx
<circle r={3.2} style={{ opacity: data.flowing ? 1 : 0 }}>
  <animateMotion dur="1.5s" repeatCount="indefinite" begin={`${i * 0.5}s`}>
    <mpath href={`#${id}`} xlinkHref={`#${id}`} />
  </animateMotion>
</circle>
```

The circle follows the line by *reference*, through `<mpath>` pointing at the
`<path>` that `BaseEdge` renders, rather than carrying its own copy of the curve
in a `path` attribute. Dragging a component redraws every connection touching it
sixty times a second, and SMIL leaves the effect of rewriting a running
animation's own attributes to the implementation. Chrome was measured to carry
on smoothly either way; `mpath` is the spelling that does not depend on that,
and a drag never touches the animation elements at all.

`animateMotion` draws schematic traffic at a readable speed. Circles stay
mounted through drags, but are visible only while a real worker run is active.
Live mode advances at roughly one simulated second per foreground second;
Timed finishes as fast as possible and then hides its packets. Saved snapshots
do not animate. Reduced-motion preferences hide the packets entirely.

*Per-component results.* `nodeMetricsFrom` turns a `SimulationResult` into one
entry per component id, and each kind gets only what it actually has: users get
requests sent and average response but no utilisation bar, because they have no
capacity; a database gets its query count; a cache gets hits and misses; a
balancer gets what it forwarded. A queue figure appears only when something
queued. This is also why the engine reports `clients` separately from the
totals — with two groups of users, showing the global figure on one of them
would be wrong.

**Alternatives.** Animating each simulated request was never on the table: a
20-second run moves over a thousand of them in under a second. A canvas-based
particle system would allow denser effects at the cost of a render loop and its
own hit-testing; three declarative circles per edge need neither.

**Limits.** The packets are indicative, not proportional: a busy link and a
quiet one show the same three dots. Colour tells you which links carried
traffic; the Components tab has the byte counts.

**Verified by.** A Playwright probe against the running app: opacity `0`
before a run, `1` after it, and `0` again once the design is edited and the
results go stale. `e2e/canvas-regressions.spec.ts` tags every packet and
connection element, drags a connected component, an unconnected one, and renames
a third, and asserts that the same elements are still there afterwards and that
every dot is still travelling — the regression test for the flicker described in
section 15. `e2e/starter-workflow.spec.ts` asserts each component shows its own
line — "forwarded" on the balancer, "served" on a server, "queries" on the
database.

---

## 17. Deciding when an edit is worth re-running

**What it is.** A one-line summary of a document that answers "would this
simulate differently?".

**Where.** `src/simulation/signature.ts`, used by `mutate` in
`src/features/editor/store.ts`.

**Why.** The editor re-runs itself after a change. Without a way to tell which
changes matter, dragging a component across the canvas would fire a simulation
on every animation frame, and renaming a box would throw away a result that is
still perfectly valid.

**How it works here.** `simulationSignature` serialises exactly the parts of a
document the engine reads:

```ts
JSON.stringify({
  nodes: document.nodes.map((n) => [n.id, n.kind, n.cloud.profileId, n.settings]),
  edges: document.edges.map((e) => [e.id, e.source, e.target, e.settings]),
  workload: document.workload,
  pricing: document.pricingOverrides,
})
```

Positions and names are absent; rate overrides are present, because a run
carries a cost estimate. `mutate` compares the signature before and after an
edit and only then schedules a run — debounced at 450 ms, and skipped entirely
while the design has validation errors, since the problems chip is already
saying so.

**Live and Timed share an engine.** `running` tracks actual worker execution;
`live` permits automatic updates after edits. In Live mode one engine retains
its event heap, queues and random streams, advancing to successive time
boundaries. Every 250ms the worker sends a snapshot. Stop cancels the active
engine and preserves the partial result. Timed mode retains finite experiments.
Meaningful edits replace the engine after 450ms; position/name edits do not.
Invalid edits keep the old configuration running with a stale-result label.

Snapshots do not alter accumulators or append unfinished journeys to the
engine. Their denominator is elapsed simulated time; in-flight function time
is included in duration charges. Only user routes enter user totals; workers
are reported separately. History stays bounded and Keep clones a new record.

The same signature decides whether a *result* is still about what is on screen.
Staleness used to be a whole-document comparison, which meant renaming a
component or simply reopening a project marked a perfectly valid result as out
of date. "Stale" now means one thing everywhere: the design would simulate
differently.

The file lives beside the engine rather than in the editor for two reasons: it
can then be tested with no browser, and it sits next to the code whose
behaviour it claims to summarise, where a future change to what the engine
reads is likeliest to be noticed.

**Alternatives.** A deep equality check on the whole document would also catch
position changes, which is the one thing it must not do. Hashing would save a
few bytes over comparing strings; documents are small enough that it would be
optimising nothing.

**Limits.** It is conservative in one direction: changing a cloud rate
re-simulates when only the cost needed recomputing. The run is fast and the
alternative is a second, subtler code path.

**Verified by.** `tests/signature.test.ts` — moving a component and renaming
one leave the signature untouched, and the position case goes further and
asserts the two runs serialise identically, which is the claim the signature
actually stands for. Settings, traffic, workload, connections, cloud profile
and edited rates all change it.

---

## 18. Pull-based dispatch, for work nobody is waiting for

**What it is.** A message queue: the publisher hands the work over and answers
its own caller, and a consumer takes messages off the backlog whenever it has
room for another.

**Where.** `src/simulation/models/queue.ts` (the backlog),
`src/simulation/models/station.ts` (the broker that accepts publishes),
`dispatchFromQueue` and `compileConsumers` in `src/simulation/engine.ts`.

**Why.** Every other flow in the engine is *push*: a station finishes and hands
the request onward, so nothing can ever accumulate that some request is not
already waiting on. A queue is the other way round — the work sits still until a
consumer comes for it — and that is precisely why a backlog can grow. Without
it, the whole shape of asynchronous design is undrawable.

**How it works here.** A queue compiles to a **consumer route**: the existing
pipeline (admission, CPU segments, cache, database) entered from the queue
instead of from a client, and *finished* rather than answered. The
queue-to-worker link carries the message in its forward direction and the
acknowledgement back in its reverse, which is a hop a real consumer pays anyway.
That is why there is no separate `JobState` and no second branch in every
handler — and why a worker gets a cache and a database of its own for free.

Dispatch runs on the only two events that change either side: a message being
accepted, and a consumer finishing one.

```ts
while (backlog.depth > 0 && backlog.inFlight < worker.concurrencyLimit && worker.canAdmitNow())
```

The `inFlight` bound is not redundant. `canAdmitNow` counts only what the server
has already admitted, and a message spends a moment on the link before it gets
there; without the bound the consumer takes more than it can hold.

**Refusing rather than dropping.** A publish beyond `maxDepth` fails, and the
request behind it is rejected with `queue-full`. Accepting and discarding would
have hidden the failure; refusing puts backpressure in the rejection figures
where it can be seen.

**Alternatives.** A separate job entity with its own event types was written
first and abandoned: it doubled the handlers for no behaviour that the consumer
route does not already give. Modelling the queue as a `StationModel` was
rejected because a station is "N things in progress at once" and a queue is
work that nobody has started.

**Limits.** One consumer per queue; no retries, dead-letter queues,
acknowledgement timeouts, ordering guarantees or partitions. The load balancer's
fan-out machinery is the natural way to add a consumer pool later.

**Verified by.** `tests/queue.test.ts` — a worker at 200 ms drains 5 a second, so
110 seconds of run leaves 550 of 1,000 messages done and 450 waiting; a full
queue refuses the publish and the rejection is counted; a queue with no consumer,
two consumers, two queues on one server, and a worker publishing back into its
own queue each produce their own error code. `e2e/async-queue.spec.ts` runs the
whole thing in a browser.

---

## 19. Escaping an ancestor's clipping

**What it is.** `Popover` renders its panel into `document.body` and positions
it against the element that wraps it.

**Where.** `src/ui/primitives.tsx`.

**Why.** An absolutely-positioned panel is at the mercy of every ancestor's
`overflow`, and the control bar has two: `overflow-hidden` on the card, which
keeps the progress bar inside its rounded corners, and `overflow-x-auto` on the
wrapper that lets a narrow window scroll the bar sideways. A panel opening
upward is clipped by both, and there is no CSS that opts out — `overflow-y:
visible` is computed as `auto` when `overflow-x` is not `visible`. The only
answer is to leave the subtree.

**How it works here.** A `<span class="hidden">` stays where the component was
written, purely so its `parentElement` can be measured; the panel goes through
`createPortal` with `position: fixed`, `placement` choosing above or below, and a
`maxHeight` taken from the space that is actually available. It repositions on
scroll and resize.

**The lesson underneath it.** Both popovers were clipped away for months and a
test asserted one of them was visible the whole time. Playwright's visibility
check asks whether an element has a box and is not `display:none`; ancestor
clipping is invisible to it, and `allInnerTexts()` in a hand-written probe has
the same blind spot. Anything that must be *seen* needs
`document.elementFromPoint` at its centre — `isReallyOnScreen` in
`e2e/async-queue.spec.ts` — not `toBeVisible`.

**Verified by.** That test, confirmed in both directions: it fails with the panel
back inside its trigger and passes with the portal.

---

## 20. A chain of hops in front of the entry point, and a map back

**What it is.** The CDN, WAF and API gateway are resolved as a list of hops
between the users and the entry point, and a response finds its way back by a
lookup table of reverse links rather than by remembering where it has been.

**Where.** `EdgeHop` and the chain walk in `src/simulation/routing.ts`;
`CompiledHop`, `relayBack` and `leaveHop` in `src/simulation/engine.ts`.

**Why.** The three components share one shape — a service station that
forwards to exactly one thing and has one reason of its own to stop a request
— and differ only in that reason. Modelling them as one mechanism with three
`leaveHop` branches keeps them interchangeable and orderable: a WAF inside a
CDN and a CDN inside a WAF are the same code. Fixing an order would have baked
one vendor's topology into the engine.

**How it works here.** The route resolver takes the users' outgoing link and
walks forward while the target is an edge kind, collecting hops and refusing a
loop, a dead end or a fork with its own error each; the walk stops at the
first non-edge target, and the existing entry-point rules take over from
there. Compilation lays the links out as a path and records, for the reverse
of every link on it, the reverse of the link before it — `relayBack`. When a
response arrives on a link whose reverse is in the map, it is forwarded along
the mapped link without queueing at the hop; the balancer's branches map to
the reverse of the entry link so the same table covers fan-out. A CDN hit
sends the response straight onto the hop's back channel, which is just the
map applied one step early.

**DNS is deliberately not a hop.** A lookup gates the *creation* of a request:
a sampled share of requests send a `dnsQuery`, and the request is only sent on
when the `dnsAnswer` comes back. Putting DNS on the path would charge every
request a lookup, which is wrong by the inverse of the cached share.

**Verified by.** `tests/edge.test.ts`: a full chain with every count
reconciled (hits + served + blocked = offered); each hop's own reason in
isolation; stream independence between hops; the four routing errors.
`e2e/edge.spec.ts` runs the template in a browser and reads the same counts
off the store, the canvas and the results sheet.

---

## 21. One compute model, two shapes

**What it is.** A serverless function is the application server's model —
CPU slots, a concurrency limit, a memory budget, an admission line — with the
numbers a platform fixes for you filled in by a function, `shapeOfFunction`.

**Where.** `src/simulation/models/server.ts`; the `kind` checks in
`admitAtServer` and `startCpu` in `src/simulation/engine.ts`.

**Why.** The alternative was a second entity with its own admission, its own
CPU segments and its own hooks into every store — a copy of the server with
one branch changed in three places. Shaping the existing model instead means a
function can be attached to a cache, a database, a replica, a key-value store,
object storage, a queue and a topic, and can stand behind a balancer, an edge
chain, a queue or a topic, with no new code in any of those places. The
routing rules were the only thing that had to change, and there the word
"server" became "compute kind".

**How it works here.** A CPU slot per invocation up to the concurrency limit,
so nothing ever waits for CPU; memory per invocation equal to what was
allotted, so peak memory reads as concurrency times memory; a waiting line of
zero, so `canQueueNow` is always false and the kind check turns the refusal
into `function-throttled`. Two things are genuinely new: a cold start,
sampled per invocation and added to the first CPU segment, and a clock on the
time between admission and response, which is what the provider bills.

**Verified by.** `tests/serverless-stores-pubsub.test.ts`: a one-slot server
queues 200 ms of work at 20 a second and a function does not; a limit of two
refuses exactly half; 5 ms of CPU plus 10 ms of database is 15 ms billed, and
the Lambda duration line follows from it.

---

## 22. Testing and build tooling

**Vitest** (`tests/`) runs in Node against the pure engine,
the pricing engine and the storage helpers. Worker failure tests substitute a
small Worker double to trigger crashes; the engine tests use the real engine
without DOM dependencies. Test
helpers in `tests/helpers.ts` build documents from typed partials so a test can
say "the default server, but with one CPU slot".

The tests are named after the acceptance checks they cover, so a failure points
straight at the requirement it broke.

**Playwright** (`e2e/`) runs against the **production build** served by
`vite preview`, because that is what a user gets. Console errors and page errors
are collected and asserted empty, which is how acceptance check 17 is actually
checked rather than claimed. The tests read engine numbers through
`window.aparecium.store`, so an assertion about a mean response time is exact
rather than a fragile screen-scrape.

**TypeScript** in strict mode, plus `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch` and `noUncheckedIndexedAccess`. This paid for
itself immediately: `noUnusedLocals` flagged `stationRequest` as unused, which
turned out to be a real defect — `onDeliver` had no branches for `cacheLookup`,
`dbQuery` or `cachePopulate`, so downstream messages were arriving at the
database and cache and being silently dropped (`decisions.md` entry 006).

**Vite 6** for the dev server and build (Vite 7 needs a newer Node than the one
installed). The worker is imported with
`new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })`,
which Vite recognises and emits as its own chunk with no configuration.

**Tailwind 3** with a small custom palette (`ink`, `reveal`, plus `ok`/`warn`/`bad`)
and a handful of component classes in `src/app/styles.css`.

**Icons** are 24 hand-written SVG paths in `src/ui/icons.tsx` that inherit
`currentColor`, rather than an icon package. A library would have been hundreds
of kilobytes for the dozen glyphs Aparecium uses, and the specification asks for
a modest dependency count.

**Verified by.** `npm run typecheck`, `npm test`, `npm run test:e2e`, and
`npm run build`. Current counts and outcomes are recorded in README.md and the
append-only decisions.md journal.

## Continuous execution and exact boundaries (entry 056)

The engine's `step(maxEvents, untilMs)` uses a half-open interval: events at the
boundary stay queued for the next slice. Constant arrivals use the arrival
index times the interval instead of repeated addition, avoiding an extra
request at the end. `result()` is observational: calling it between slices
cannot change the final numbers. Accumulator reads no longer advance state.

`src/workers/runner.ts` shares the clock and chunk loop between Worker and
fallback. Each turn has a 12ms budget; a throttled tab slows simulated time
instead of accumulating an unbounded catch-up target. Live runs retain pending
work, in-flight and replication-backlog limits, while the finite-run total-event
cap applies only to Timed. The UI displays the elapsed simulated time.

Coverage: `tests/live-simulation.test.ts`, `e2e/live-simulation.spec.ts` and the
existing worker/canvas regressions. New tests compare sampled and unsampled
execution, carry queues across boundaries, stop and supersede fallback runs,
and keep/export/import/reopen snapshots.

## Housekeeping is not workload (entries 067, 068, 070)

**What it is.** Telling the events that move work apart from the events that
only tidy up after it, when deciding how long a run was.

**Why.** Retention runs on the simulated clock: a stream record, a dead-lettered
job or a telemetry record expires at a scheduled `jobMaintenance` event. When a
record outlives the traffic, those events keep the engine busy after the last
request, and a run measured "to the last event" grows with the retention
setting. Ten requests over one second reported 1.7 a second with a five-second
retention and 10 a second with a hundredth of a second, for identical traffic —
and the projected bill shrank to match.

**How it works here.** `step()` records `workEndMs` for every event except
`jobMaintenance`, and sets it to the end of the drain window when the window
runs out with work still pending (nothing but work can be scheduled past the
end). A completed Timed run is measured over `max(workEndMs, arrivalWindowMs)`.
A cancelled or limited run keeps that window only when it has been covered
and only housekeeping remains. Otherwise it uses the simulated time reached,
even if all requests finished: expiries inside the window may still be pending.
The housekeeping still runs to completion
inside the drain — the expiry counts are its result — but once only
housekeeping is left (`queue.size < maintenanceAt.size`, and housekeeping never
creates work) that interval is known, and every backlog depth accumulator is
told where it ends (`TimeWeightedAccumulator.endAt`). From then on a change
integrates the level that held up to that end and no further: a job
dead-lettered at 100 ms that expires at 600 ms averages 0.5 over a 1-second
window, one that expires at 2.1 s averages 0.9, and so does one that never
expires within the drain. Entry 067 had ended the accumulators at `workEndMs`
instead, which is earlier than the window when the work finishes early, and
`timeAverage` then filled the gap with the level *after* the expiry — zero.
Codex's review caught it; entry 068 corrected it. Entry 070 then separated
knowing the final endpoint from having covered the interval: a stop at 600 ms
must not label a partial queue average as a full-second measurement when
expiries at 700 and 800 ms are still pending. Live mode is untouched: its
interval is wherever the clock has got to.

**Limits.** Retention still happens; it is simply not measured as traffic. A
depth average describes the measured interval, and the retained and expired
counts describe the state after the drain's housekeeping — two honest readings
of two different moments.

**Verified by.** `tests/job-services.test.ts` ("retention housekeeping and the
measured interval"): the reproduction, genuine drain still counted, Live
unchanged, a dead-letter depth average bounded by its own peak, and the review's
three cases — a message expiring inside the interval (0.5), after it (0.9) and
never within the drain (0.9) — plus cancellation and event limits during
housekeeping before, exactly at and after the measurement endpoint;
`tests/primitives.test.ts` for `endAt`; `e2e/remaining-components.spec.ts` for
the same reproduction through the worker.

## Three backend pieces on existing machinery (entry 075)

**What it is.** A distributed lock, a workflow engine and auto scaling, each
built from a mechanism the engine already had.

**How it works here.**
- *A lock's own line.* `SupportServiceModel.finishLock` separates the lock
  service's work from the lock itself. A request occupies a slot only while its
  grant or release is processed; then it either holds its lock (a map of
  holders by lock number) or joins that lock's own waiting line, with a timeout
  scheduled. One event per request can mean three things — grant processed,
  hold over, or waited too long — and which one is told by where the request
  is, so a timeout that fires after the request was granted does nothing.
- *A workflow as chained backlogs.* The workflow node gets a broker station and
  one `QueueModel` per step (step one keyed by the node id, so a start is an
  ordinary publish). A finished step reserves room in the next backlog with
  `reserveArrival`, and the job arrives after the state-save time with
  `restoreArrival`. Billing counts `transitions`: every step taken off a
  backlog, retries included.
- *A server that is a group.* `ServerModel` keeps one instance's resources and
  multiplies them by `instances` through getters, so every existing check —
  free CPU, admission, memory, queue room — follows the group with no change.
  A check reads CPU busy and slot *areas* since the last check
  (`TimeWeightedAccumulator.integral`), so utilisation is a share of what was
  actually serving. A started instance is counted in `billedAcc` at once and
  in capacity only when ready.

**Verified by.** `tests/backend-components.test.ts` (24 tests: the 50-a-second
lock cap, per-item locks, skipped requests, timeouts; step order, durations,
retries, failed and refused steps, transitions billed; scaling out, bounds,
scaling in, warm-up, Timed-run interval, Live, billing and fallback, version
6 upgrade), the release cases in `e2e/released-components.spec.ts`, and
`e2e/backend-components.spec.ts`.

## A chain on the event queue (entry 076)

**What it is.** Blocks, a pending pool and a moving fee, simulated with the same
event queue as everything else.

**How it works here.**
- *Blocks on a beat.* A `chainBlock` event per contract, every block time. In a
  Timed run the beat continues while traffic arrives and, after that, only while
  something is pending; a transaction arriving when no block is scheduled asks
  for the next beat (`ensureBlock`), so blocks stay aligned to the chain's
  clock. Live keeps the beat for ever.
- *Two events per transaction.* The submission is processed in a slot and put
  in the pool; the block that takes it schedules one more event at its last
  confirmation, which finishes the request. Waiting in the pool is counted as
  the request's waiting time.
- *The fee.* `fee *= 1 + (fullness − 0.5) / 0.5 / 8` after each block, with
  fullness counting everyone else's elastic share (`backgroundShare / fee`).
  Each transaction records the fee of its block; the gas bill uses that
  weighting.
- *One decision per request.* `chainTx` is set by the first chain piece that
  asks, so a wallet and a contract never disagree about what a request is.

**Verified by.** `tests/blockchain.test.ts` (18 tests: waiting for blocks and
confirmations, reads that never wait, a layer-2's speed, a block's gas cap, the
fee rule and its ceiling, a full pool, gas billing and an entered rate, the
wallet's share and refusals and its agreement with the contract, the RPC plan
limit and its one target, indexer lag, oracle updates and staleness, cached and
uncached storage, schema and saved runs, rate-less profiles, Live, version 8,
the workshop); six release cases in `e2e/released-components.spec.ts`; and
`e2e/blockchain.spec.ts`.

## Specialized data resources (released; entries 062–066)

`domain/data-services.ts` defines numeric settings, limits, labels and editable defaults once. The document schema and Inspector consume this metadata so fields cannot silently lose validation or editing. A separate pure TypeScript `DataServiceModel` prepares operations and owns per-partition ring queues, active slots, visibility state and bounded retention buckets. The main event heap schedules completion; both request and response use the existing network channels. No extra real timer, DOM or worker API is used by the model. Queue wait is added to the same request's wait total. Snapshots copy counters and derive visibility without changing engine state.

The warehouse ledger measures GB scanned independently of request count; decimal arithmetic projects that measured rate into a monthly flat-rate charge. Unknown rates remain null. Generic additions live in a separate static JSON list also included by the refresh script, preserving them when public provider prices are refreshed.


Expansion progress (2026-09-13): Background jobs use separate completion/failure counters. Retry slots are reserved before scheduling a retry, preventing a later publish from stealing the slot. Stream readers acknowledge offsets; reading never deletes shared history.
