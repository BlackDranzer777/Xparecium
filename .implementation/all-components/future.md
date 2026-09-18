# Aparecium — Deferred features, ideas and known limitations

Three sections:

1. **Deferred by the specification** — agreed to be out of scope for this release.
2. **Ideas found during implementation** — things noticed while building, recorded
   so they are not lost. None of these expand the agreed scope on their own.
3. **Known limitations and technical debt** — where the current build is thin.

Status and priority are **provisional** unless stated otherwise.

---

## 1. Deferred by the specification

### Cloud sync and collaboration
- **Benefit:** open the same project on two machines; two people editing one design.
- **Deferred because:** it requires accounts, a backend and a conflict model, all
  of which the "browser only, no backend" constraint rules out.
- **Prerequisites:** an identity story; a merge strategy for the document.
- **Direction:** the document is already a plain JSON value with a schema
  version, so a CRDT or last-write-wins sync layer could sit on top without
  changing the engine.
- **Status:** deferred. **Priority:** low.

### Real cloud deployment
- **Benefit:** turn a validated design into actual infrastructure.
- **Deferred because:** explicitly excluded. Aparecium must never provision anything.
- **Open question:** even generating Terraform or CDK from a design would imply a
  fidelity Aparecium does not have; the model is averages, not a specification.
- **Status:** deferred. **Priority:** none — treat as out of scope indefinitely.

### Browser cookies, sessions, storage performance and rendering simulation
- **Deferred because:** out of scope, and each is a research project of its own.
- **Status:** deferred. **Priority:** none.

### Language and framework performance claims
- **Benefit:** "what if we rewrote this in Go?"
- **Deferred because:** any number attached to a language name would be invented.
  The honest model is what exists now: the user sets CPU work per request.
- **Status:** deferred. **Priority:** none. Would need a sourced, citable dataset.

### REST / GraphQL / gRPC / tRPC comparison
- **Deferred because:** the difference lives mostly in payload size and request
  count, both of which the user can already set directly.
- **Direction:** if ever added, it should be a *preset* that fills in payload
  sizes with a stated source, not a hidden performance multiplier.
- **Status:** deferred. **Priority:** low.

### WebSocket / WebTransport emulation
- **Benefit:** model long-lived connections and server-pushed messages.
- **Deferred because:** the arrival model is one-shot requests; persistent
  connections need a different client model and a different link model.
- **Prerequisites:** connection lifetime in the client model; link channels that
  can carry interleaved streams.
- **Status:** deferred. **Priority:** medium — it is the most-requested shape of
  system Aparecium currently cannot draw.

### Detailed cache keys, TTL, LRU, LFU
- **Benefit:** a hit rate that emerges from behaviour instead of being assumed.
- **Deferred because:** it needs a key-space model and per-key state, which
  changes memory characteristics of the simulation itself.
- **Prerequisite / conflict:** ADR-004 samples the cache outcome at request
  creation. A learned hit rate would have to move that sampling to lookup time
  and revise the CPU segment budget mid-request.
- **Status:** deferred. **Priority:** medium.

### SQL execution, indexes, transactions, replication
- **Deferred because:** the database is one average service time and a slot
  count. Anything more is a query planner.
- **Status:** deferred. **Priority:** low.

### Autoscaling, serverless, background workers
*(Load balancers were implemented — see `decisions.md` entry 036. Background
workers were implemented as a Message Queue with an Application Server draining
it — see entry 045. Autoscaling and serverless remain deferred.)*
- **Benefit:** the most common real production shapes.
- **Deferred because:** each needs routing rules beyond "one unambiguous path per
  client" — fan-out, health, warm-up, queue-driven work.
- **Direction:** a load balancer is the smallest step: one node with N identical
  downstream servers and a documented distribution rule. The graph and adjacency
  structures already support fan-out; only the route resolver forbids it.
- **Status:** load balancers **done**; the rest deferred. **Priority:** medium.

### The rest of the edge
*(DNS, CDN, WAF and API gateway were implemented — see `decisions.md` entry
053. What follows is what they leave out.)*
- **Benefit:** a hit rate that depends on what is asked for; a block rate that
  depends on the traffic; TLS termination and compression on the reverse proxy;
  per-client quotas on the gateway; DNS TTLs and geo-routing.
- **Deferred because:** every one of these needs a model of the *content* of
  requests — which URL, which client, which region — and the engine has none.
  The four components model the consequence of an assumed share, and say so.
- **Direction:** the multiple-operation-types idea below is the prerequisite:
  once requests carry a type, a CDN can cache one type and not another, and a
  gateway can quota one client and not another.
- **Pricing:** Azure API Management and Front Door were read from the Retail
  Prices API and left out — unit-hours per tier and zone tables with base fees,
  which the four charge types cannot represent honestly. Fixed charges the
  engine has no line for (Route 53 hosted zones, WAF rules, CloudFront origin
  fetches) are named in each profile's note as not modelled.
- **Status:** deferred. **Priority:** medium.

### More than one consumer on a queue
- **Benefit:** a worker pool is how real systems drain a queue that one consumer
  cannot keep up with — which is exactly the situation the feature makes visible.
- **Deferred because:** one consumer was enough to show the trade-off, and
  scope had to stop somewhere.
- **Direction:** the topic's per-consumer backlogs (entry 055) are most of the
  machinery: a queue with N consumers is one backlog dispatched to whichever
  consumer has room, the way a balancer picks a server.
- **Status:** deferred. **Priority:** medium — the most obvious next step.

### What the second five leave out
*(Serverless functions, read replicas, key-value stores, object storage and
pub/sub topics were implemented — see `decisions.md` entry 055.)*
- **Replication lag as stale reads:** a replica falls behind visibly (its line
  grows) but a read never returns an old value, because there are no values.
- **Failover and promotion; replicas of a key-value store.**
- **Item-size billing tiers:** DynamoDB charges more units above 4 KB read and
  1 KB written; S3 and Blob bill transfer out from the bucket when served
  directly. Both are named in the profile notes as not modelled.
- **Provisioned concurrency and execution caps** on functions; ARM pricing.
- **Ordering, replay and filtering** on topics; an event stream (Kafka) is a
  topic with a durable, replayable log, and is the natural next messaging kind.
- **Status:** deferred. **Priority:** low to medium.

### Retries, dead-letter queues and acknowledgement timeouts
- **Benefit:** the failure behaviour people actually configure a queue for.
- **Deferred because:** each needs a failure model for the consumer, and nothing
  in the engine can fail a unit of work part-way through yet.
- **Status:** deferred. **Priority:** low.

### Complex purchasing commitments and startup credits
- **Deferred because:** reserved instances and savings plans need term modelling
  and utilisation assumptions; credits need an account balance.
- **Status:** deferred. **Priority:** low.

### AI recommendations
- **Deferred because:** excluded, and the findings mechanism deliberately reports
  only what was measured. An AI suggestion would blur that line.
- **Status:** deferred. **Priority:** none.

---

## 2. Ideas found during implementation

### Verified pricing from a machine-readable source — implemented
`scripts/refresh-cloud-prices.mjs` reads the AWS Price List Bulk API and the
Azure Retail Prices API and generates the catalog with `verified: true` and the
provider's publication date (decisions.md entry 052). It is a manual command,
not a build step, so builds stay offline.

**Still open — Google Cloud.** Its Billing Catalog API needs an API key. The
script reads `GCP_BILLING_API_KEY` from the environment; until one is set, the
Google profiles stay illustrative and say so. **Priority:** medium — it is the
one provider left without real numbers.

**Still open — tiers and extras.** Every verified rate is a single number: the
first egress tier, the hourly part of a load balancer without capacity units,
one region per provider, Linux only. Each is stated in the profile's note.
Modelling tiers properly would need the pricing engine to carry a tier table
per charge. **Priority:** low.

### A time series in the results, not just totals
- **Problem it solves:** "queue length peaked at 50" does not say *when*, and
  whether the system was recovering or diverging.
- **Direction:** the accumulators in `src/simulation/metrics.ts` already
  integrate over time; adding a fixed number of buckets (say 200 across the run)
  gives a bounded series at negligible cost. The bar chart component would need
  a line variant.
- **Status:** idea. **Priority:** medium.

### Non-blocking cache population
- **Problem it solves:** the server currently waits for the cache write to be
  acknowledged before answering. Many real implementations do not.
- **Direction:** a boolean on the cache; the request responds and the write
  continues as an independent scheduled item.
- **Open question — now answered.** A fire-and-forget write outlives its request,
  so the bookkeeping needs a second owner for it. Message queues solved exactly
  this (entry 045): a consumer route owns work that its publisher has stopped
  waiting for. The same mechanism should carry a non-blocking cache write.
- **Status:** idea, unblocked. **Priority:** medium.

### Per-component result overlay on the canvas
- **Problem it solves:** results are in a drawer; the eye has to move between the
  numbers and the picture.
- **Direction:** after a run, tint each node by utilisation and print its queue
  peak on the node. All of that data is already in `SimulationResult`.
- **Status:** idea. **Priority:** medium.

### Multiple operation types per client
- **Problem it solves:** real clients mix cheap reads and expensive writes.
- **Direction:** a client would carry a list of weighted operations, each with
  its own payload sizes and downstream behaviour. The route resolver would then
  resolve one path per operation rather than one per client.
- **Trade-off:** this is the change that most affects the "one unambiguous path"
  rule, so it should come after load balancers, not before.
- **Status:** idea. **Priority:** medium.

### Saved scenarios and a run matrix
- **Problem it solves:** comparing two runs is manual. "Run this design at 1x,
  2x and 4x load" is the actual question people ask.
- **Direction:** a list of workload overrides run in sequence in the worker, with
  the comparison table extended to more than two columns.
- **Status:** idea. **Priority:** medium.

### Bundle splitting
- **Problem it solves:** the main chunk is about 650 kB (203 kB gzipped), and
  Vite warns about it. React Flow is most of it.
- **Direction:** lazy-load the canvas, or set `manualChunks` to separate vendor
  code.
- **Status:** idea. **Priority:** low — it loads acceptably as one chunk today.

---

## 3. Known limitations and technical debt

### The measurement interval for very short runs
Throughput is completed requests divided by the measured interval. For a run
whose duration is shorter than a single arrival interval, the numbers are
technically correct but not meaningful. There is no warning for this yet.
**Priority:** low.

### Undo history is not persisted
Undo and redo stacks live in memory and are cleared when a project is opened or
imported. Reloading the page loses them. **Priority:** low.

### Run history is capped at 25 per project with no UI to manage it
Older runs are pruned silently. There is no way to pin a run as a baseline or to
delete one by hand. `deleteRun` exists in `src/storage/db.ts` but nothing calls
it. **Priority:** medium.

### No storage-quota handling
If IndexedDB refuses a write because the origin is over quota, the save fails
with a message and the work stays in memory, but nothing tells the user how much
space is used or offers to prune runs. **Priority:** medium.

### The p95 is a histogram estimate, not an exact quantile
Buckets are 15% wide, and the interface states the bracket and the precision.
That is honest but coarse for tightly clustered latencies. A t-digest would be
more accurate at similar cost. **Priority:** low.

### Journey sampling is stride-based
Traced requests are chosen by taking every *k*-th offered request, where *k* is
derived from the expected total. If a run is cut short, samples cluster at the
start. **Priority:** low.

### One instance per component
A component is exactly one instance for costing. There is no replica count, so a
three-node database cluster has to be modelled as one node with a hand-edited
rate, and a queue drained by four workers cannot be drawn at all.
**Priority:** medium — pairs naturally with the load-balancer work and with
"More than one consumer on a queue" above.

### Full validation of imported run history — implemented, and a lesson
`src/storage/run-schema.ts` validates results, costs, catalog snapshots and
schema versions before import. Unreadable runs are skipped with an explanation.
Fresh IDs prevent import from overwriting original history. See decisions.md
entries 024–025 and architecture.md section 7.

**It has to be updated whenever the engine's output changes.** It had not been
since the load-balancer work, and the effect was that importing any project
containing a load balancer rejected its whole run history (entry 045). New and
possibly-absent fields are now `.default()`ed rather than required, and a test
round-trips a load-balanced and a queue-bearing run. Anything added to
`SimulationResult` from here needs a line in that file and a case in that test.

### No automated accessibility audit
Focus is visible, every control has a label, tabs use `role="tab"` with
`aria-selected`, and the progress bar has proper ARIA attributes. None of this is
verified by an automated check such as axe. **Priority:** medium.

### `window.aparecium` is exposed in the production build
`src/app/main.tsx` attaches the editor store and the simulation client to
`window` in every build, not only in development. The Playwright suite runs
against the production build and reads engine numbers through it, which is what
makes those assertions exact rather than screen-scraped. Nothing sensitive is
exposed — everything is already local to the browser — but it is a test
affordance shipped to users. Gating it behind `import.meta.env.DEV` would mean
the browser tests no longer exercise the artefact that ships.
**Priority:** low.

### The palette has no categories — resolved
With four components, category headings left half-empty rows and said nothing
the tile did not, so the palette was one flat grid, with a note that they should
return "as soon as there are enough components to group — which is the same
moment load balancers and queues arrive". Both arrived. The palette is grouped
into Traffic / Compute / Data / Messaging. See decisions.md entry 045.

### React Flow's node measurement is still unused
*(Partly resolved: nodes now carry an explicit `width` and `height`, so React
Flow never needs to measure the card. The note below still applies to any
future variable-height node.)*
`onNodesChange` deliberately drops everything except position changes, so a
controlled flow never records that its nodes were measured and
`useNodesInitialized()` is permanently false. Nothing depends on it today —
the canvas frames the diagram from the document plus a fixed node size — but any
future feature that wants real measured dimensions (variable-height nodes, an
auto-layout pass) will have to solve this first, most likely by keeping a local
React Flow node state that is synced from the document.
**Priority:** medium, and a prerequisite for auto-layout.

### Only Chromium is tested
The Playwright project list has one browser. The app uses no exotic APIs, but
Firefox and WebKit are untested. **Priority:** medium.

### Live-mode follow-ups (entry 056)
- Live execution is implemented. Moving and renaming preserve the same engine.
- Changing traffic, hardware, topology or price inputs starts a fresh measurement;
  preserving in-flight work across those edits needs explicit migration rules.
- Metrics are cumulative. Rolling time-window charts and configurable playback
  speed remain future work. Background throttling slows simulated time.
- Pricing remains a catalog-based estimate with documented omissions; no claim
  is made that a verified rate makes the entire monthly bill complete.

## Remaining component expansion (in progress)

All sixteen additions are tracked in implementation-plan.md. Five specialized data stores are currently implemented in a staged copy and undergoing verification; eleven messaging, real-time and shared infrastructure components remain pending. These items must not be marked delivered until their behavior, UI, persistence and tests are complete. Provider-specific deployment profiles and full database internals remain outside these simplified models.

Stage A is now verified in the staged copy; event-stream, dead-letter and scheduler integration is in progress (entry 060). Final integration and full expansion checks remain pending.


Expansion progress (2026-09-13): Staged job mechanisms now exist, with integration testing underway. Remaining fidelity limits include exactly-once side effects, durable recovery after browser closure, partition rebalance and calendar/time-zone cron scheduling.
