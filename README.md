# Aparecium

**Reveal how your system works.**

A browser-based system-design simulator. Draw a small architecture, choose
hardware and cloud profiles, set the traffic, press Run, and see performance,
resource usage and an estimated monthly cost — then change one thing and compare.

Everything runs locally in your browser. There is no backend, no account, no
external database, no paid API, no AI, and **no real cloud resources are ever
created**.

---

## Documentation

| Document | What it covers |
|---|---|
| [info.md](info.md) | Plain-English introduction. Start here if you are not a developer. |
| [architecture.md](architecture.md) | How the application is built, with diagrams, data flow and numbered architecture decisions. |
| [techniques.md](techniques.md) | Every technique actually used, why, how it works here, and how it was verified. |
| [decisions.md](decisions.md) | Chronological development journal, including the bugs and the fixes. |
| [future.md](future.md) | Deferred features, ideas found during implementation, and known limitations. |
| [acceptance-audit.md](acceptance-audit.md) | Verification of the linked plan and gaps corrected in the September 2026 audit. |

---

## Getting started

Requires **Node 20.17 or newer** (Vite 6; Vite 7 would need Node 20.19+).

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. A starter project is created on first visit
and is ready to run without changing anything.

### All commands

```bash
npm run dev         # dev server on :5173
npm run build       # type-check, then production build into dist/
npm run preview     # serve the production build on :4173
npm run typecheck   # tsc --noEmit
npm test            # Vitest: engine, pricing, persistence, primitives
npm run test:e2e    # Playwright against the production build
npm run prices:refresh   # regenerate the cloud catalog from the AWS and Azure price lists
npm run prices:check     # exit 1 if the shipped catalog no longer matches what they publish
```

Playwright needs its browser once: `npx playwright install chromium`.

### Deploying

`npm run build` produces a `dist/` folder that any static file host will serve.
It contains the bundle, the worker as its own chunk, and `catalogs/*.json`.
There is nothing to configure and no environment variables. To deploy under a
sub-path, set `base` in `vite.config.ts`; catalogs are fetched relative to it.

---

The canvas fills the window. Everything else floats over it and can be put away:
the menu (top left) holds projects, import and export; the theme and panel
toggles are top right; the palette and the settings share one card on the right;
Run and the traffic controls sit in the bar along the bottom; results slide up
above that bar.

1. **Draw.** The **Components** tab adds Users; a DNS, a CDN, a WAF or an API
   Gateway at the edge; a Load Balancer, an Application Server or a Serverless
   Function to run your code; a Database, a Read Replica, a Cache, a Key-Value
   Store or Object Storage to keep things; a Message Queue or a Pub/Sub Topic
   to hand work on. To connect two components, drag from a dot on the edge of
   one to the other — any side works, in either direction.
2. **Configure.** Click a component; the panel switches to **Settings**. Basic
   settings are always visible; open **Advanced** only if you want to.
3. **Set the traffic.** Click the offered-load figure in the bottom bar to jump
   to the client's settings — active users and actions per minute. The bar shows
   the resulting request rate and the assumption behind it.
4. **Run.** **Live** is the default: requests and queues keep advancing until
   **Stop simulation**. Counts and estimates refresh four times per second.
   **Timed** computes the chosen duration and drain window for a comparison.
   Its **Stop updates** button disables automatic recalculation after edits.
   **Keep** saves an immutable snapshot for Compare; moving or renaming boxes
   does not restart the engine. Changing simulation settings starts a fresh
   measurement automatically. Invalid edits leave the previous configuration
   running, clearly marked **Earlier configuration**.
5. **Read.** The results sheet has three states: a headline strip, expanded with
   five tabs (Summary, Components, Journeys, Cost, Compare), or closed.
6. **Change one thing and run again.** The Compare tab lists exactly which inputs
   differed, and flags changes that make the comparison less controlled.

While the results are behind the canvas — during a re-run, or while a validation
error stops one — they are marked as belonging to an earlier configuration, so
they can never be mistaken for current. The simulation keeps running either way;
the problems chip says why no newer numbers are arriving.

Aparecium ships a light theme and a dark one. Light is the default; the toggle
is top right and your choice is remembered in this browser.

### Keyboard

| Key | Action |
|---|---|
| `Ctrl`/`Cmd` + `Enter` | Run the simulation |
| `Ctrl`/`Cmd` + `Z` | Undo |
| `Ctrl`/`Cmd` + `Shift` + `Z`, or `Ctrl` + `Y` | Redo |
| `Delete` / `Backspace` | Delete the selected component or connection |

---

## Supported models

### Components

| Component | Models | Does not model |
|---|---|---|
| **Users** | Either a steady rate, or a fixed population where each user waits for its own response and thinks before sending again; request and response payload sizes. | Individual user sessions; per-user variation beyond the think time. |
| **DNS** | Beside the path, not in it. An assumed share of requests need a lookup before setting off; each waits an average lookup time at a station with concurrent slots and a bounded queue. Every lookup is a billed query. | TTLs, resolver hierarchies, caching layers, geo-routing. The share that needs a lookup is your assumption. |
| **CDN** | A cache at the edge with an assumed hit rate. A hit is answered at the edge and never reaches anything behind it; a miss is forwarded and the response comes back the same way. Every request is billed; the bytes to users are the CDN's egress. | What is cacheable, per-object TTLs, origin shielding, invalidation. The hit rate is your assumption. |
| **WAF** | Inspects every request for an average time and refuses an assumed share as malicious, counted as rejected under its own reason. What it blocks never reaches anything behind it. | Detection itself — rules, signatures, bot scoring. The block share is your assumption. |
| **API Gateway** | Forwards with an average service time and enforces a rate limit as a token bucket: a steady rate plus a burst allowance. What finds no token is refused on the spot, never queued. | Authentication, routing rules, request transformation, per-client quotas. |
| **Load Balancer** | A bounded number of requests in flight, an average forwarding time, a bounded queue, and round-robin or least-busy selection across a pool of servers. | Health checks, connection reuse, sticky sessions, retries, TLS termination. It forwards; it never computes. |
| **Application Server** | CPU slots, application concurrency and a memory budget as three separate resources; a bounded admission queue. | OS scheduling; threads; garbage collection. |
| **Database** | A fixed number of concurrent slots with an average service time, and a bounded queue; provisioned data size for costing. | Query planning, indexes, transactions, replication. Data size does not affect query time. |
| **Cache** | A fixed assumed hit rate, an average lookup time, concurrent slots, a bounded queue, optional write-back after a miss. | Individual keys, expiry, LRU/LFU. Populating the cache does not raise the hit rate. |
| **Message Queue** | A broker that accepts publishes with an average service time and its own concurrency, and a backlog with a depth limit drained by one Application Server or Serverless Function behind it. The publisher waits only for the acknowledgement. | Retries, dead-letter queues, acknowledgement timeouts, ordering guarantees, partitions, more than one consumer. |
| **Pub/Sub Topic** | One publish, a copy into every listener's own backlog; each listener works through its own at its own pace. A full listener drops its copy and counts it; the publisher is never told. | Ordering, replay, filtering, delivery retries. |
| **Serverless Function** | Runs your code with a CPU slot for every invocation, up to an account-wide concurrency limit; over it, requests are refused on the spot. A share of invocations pay a cold start. Billed per invocation and per gigabyte-second alive, waiting on stores included. | Provisioned concurrency, per-region limits, VPC networking, execution time caps. |
| **Read Replica** | A copy of a database that answers the reads (the database's read share, round-robin across replicas) and applies every write the primary took, using the same slots. Reads beyond its line are rejected; writes being applied never are, so a slow replica falls behind instead. | Replication lag as stale reads, failover, promotion. |
| **Key-Value Store** | One operation per request, read or write by a configured share, each at its own service time; effectively unbounded concurrency by default, because a managed one scales itself. A cache hit answers a read; a write always goes through. Billed per read, per write and per GB kept. | Joins, indexes, consistency levels, item-size billing tiers. |
| **Object Storage** | One object read or written per request, by a configured share, carried on the wire in the direction it goes. Billed per GB kept, per read and per write. | Multipart uploads, lifecycle tiers, transfer out straight from the bucket. |
| **Document database** | Records with a flexible shape. A configured share of reads use an index and take one small cost; the rest scan a set number of documents at a per-document cost. Writes take their own time. Priced as DocumentDB, one I/O-Optimized instance plus storage. | Query planning, secondary index maintenance, sharding. |
| **Wide-column store** | Rows split across partitions, each with its own slots and line. A configured share of traffic pins to one partition, which is how a hot key overloads it while the rest sit idle. Writes cost one copy per synchronous replica. Priced as Keyspaces on-demand: per read, per write, per GB. | Compaction, tombstones, consistency levels, the replicas themselves. |
| **Search index** | Searches cost a per-shard time times the shards searched; indexing a record costs its own time and becomes searchable after the refresh interval. Priced as one OpenSearch data node plus gp3 storage. | Relevance, analyzers, real parallel shard fan-out. |
| **Data warehouse** | Reports scan a configured amount of data at a configured throughput, after a setup time, with few running at once; loads take a batch time. Scan volume is a separate charge type, priced as Athena per TB scanned over S3; a provisioned Redshift node is the alternative. | Columnar pruning, result caching, slot scheduling. |
| **Time-series database** | Writes add batches of points at a per-point cost; queries scan the points retained within a window at a per-point cost; readings expire after the retention time. Priced as Timestream: per GB taken in — the bytes the writes carried, every point in a write at the record size — plus magnetic storage. | Downsampling, compression, continuous aggregates. |
| **Event stream** | Events are retained across partitions, up to a depth and a retention time; each connected worker is its own consumer group with its own offsets, reading from the earliest or the latest. Reading never deletes. Priced as Kinesis provisioned: a shard-hour per partition plus a payload unit per record. | Exactly-once semantics, compaction, rebalancing. |
| **Dead-letter queue** | Receives a job once the source queue's retry allowance is exhausted, holds it for a retention time, and can replay it to a connected worker after a delay. Priced as SQS, three billed requests per message. | Poison-message detection, per-message redrive policies. |
| **Scheduler** | Starts a batch of jobs at a fixed interval, after a first delay, with a bound on how many may be outstanding; late jobs are skipped and counted. Priced as EventBridge Scheduler, per job started. | Calendar cron expressions, time zones, missed-run catch-up. |
| **WebSocket server** | Keeps a connection per user for a lease, with a handshake, a memory cost and heartbeat traffic each way; refuses connections over its limit or memory. Sits between the users and the server. Priced as an API Gateway WebSocket API, per message; connection-minutes are not modelled. | Rooms, broadcasts, backpressure per socket. |
| **Rate limiter** | A shared token budget refilled per second with a burst allowance; requests over it are refused, never queued. Sits on the path before the server. Unpriced: nothing is sold as a rate limiter on its own. | Per-client keys, sliding windows, distributed counters. |
| **Service mesh proxy** | One proxy hop that retries a configured share of failed connection attempts up to a bound, and opens a circuit after repeated failures for a reset time. Unpriced: Envoy and Istio are free software you run yourself. | A whole mesh, mTLS, traffic splitting. |
| **Identity service** | An access check the server makes per request, with a caller-side cache; a share of credentials is invalid and a share of calls is unavailable. Unpriced: Cognito bills per monthly active user, which the run does not measure. No real tokens. | Passwords, sessions, token formats. |
| **Service discovery / configuration** | A lookup the server makes per request, with a caller-side cache that can hold an older version until it expires after a configuration update. Priced as Cloud Map: one registered resource plus a call per lookup. | Real addresses, health-based routing. |
| **Secrets manager** | A credential fetch the server makes, cached; rotation makes a cached version too old, and those operations fail until the cache expires, within a grace period. Priced as Secrets Manager: one secret plus a call per fetch. Never enter actual secrets. | Encryption, leases, audit trails. |
| **Notification service** | Delivery work handed off after the server answers: a provider rate, a failed share, bounded attempts with a delay. Acceptance is not delivery. Priced as SES email, per recipient. No real messages. | Templates, channels, provider-specific quotas. |
| **Monitoring / logging** | Samples a share of completed operations and accepts their telemetry in the background; overload drops telemetry, not requests; records expire after a retention time. Priced as CloudWatch Logs, per GB taken in (records times record size). | Real log text, dashboards, alert rules. |
| **Network connection** | One message at a time per direction; transfer time = bits ÷ bandwidth; plus a one-way propagation delay. Both directions counted. | Congestion control, packet loss, retransmission, TCP/QUIC. |

### Routes

Each client must resolve to exactly one unambiguous path:

1. `Users → Server`
2. `Users → Server → Database`
3. `Users → Server`, with `Server → Cache` and `Server → Database` — cache-aside
4. `Users → Load Balancer → many Servers`, each server optionally with its own
   cache and database
5. Any server may also publish to one `Message Queue`, drained by one Application
   Server behind it — which may in turn have its own cache and database
6. In front of the entry point, any number of `CDN`, `WAF` and `API Gateway`
   components in any order, each forwarding to exactly one thing:
   `Users → CDN → WAF → API Gateway → Load Balancer → …`
7. Beside the users, at most one `DNS`: `Users → DNS`. It is consulted, not
   passed through.
8. Wherever an `Application Server` may stand, a `Serverless Function` may stand
   instead: as the entry point, behind a balancer, or draining a queue or topic.
9. Any server may also call one `Key-Value Store` and one `Object Storage`, and
   publish to one `Pub/Sub Topic` with any number of listeners behind it:
   `Server → Topic → many Servers or Functions`
10. A `Database` may replicate to any number of `Read Replicas`
    (`Database → Read Replica`), and a server reads from the replicas of its
    own database (`Server → Read Replica`). Reads go to the replicas; writes go
    to the database, then to every replica.

A load balancer and a topic are the only components that fan out. Everything
else resolves to exactly one path. Responses walk back along the same links
they came in on.

A message queue is the one place where work outlives the request that created
it: the server waits only for the broker to accept the message, answers its
caller, and the consumer works through the backlog at its own pace. What is
still waiting when the run ends is reported as the price of that.

Cache-aside: check the cache; a hit returns the value; a miss reads the
database; if write-back is on the server populates the cache and waits for the
acknowledgement; then the response goes to the client.

Anything else stays on the canvas but is refused at run time with an explanation
and a hint. Multiple clients may share the same server, database and cache.

---

## Assumptions

Every run lists its own assumptions in the results. The permanent ones:

- One user action produces exactly one request.
- Traffic is generated at a constant rate and does not wait for earlier
  responses. Individual sessions are not modelled.
- CPU work per request is split evenly across the compute segments between
  downstream calls; the total per request is unchanged by how many calls it
  makes.
- A request waiting on a database or cache **releases its CPU slot** but keeps
  its application concurrency slot and its memory.
- Queued requests are charged the configured per-queued-request memory. A
  request is rejected if admitting or queueing it would exceed the memory
  budget.
- Cache hit or miss is drawn from the configured rate using the run seed.
  Populating the cache does not change the hit rate.
- The server waits for the cache write acknowledgement before answering.
- A cache miss returns a short negative reply, modelled at lookup-key size.
- One database read per uncached request or cache miss.
- Stored data size affects storage cost only.
- A resource profile (Small/Medium/Large) describes **the machine** — CPU slots,
  memory, baseline memory, and the cloud rates for a machine of that size in the
  provider and region already chosen. It never changes your application
  settings. If that provider has no machine of that size, the rates are cleared
  and the component is reported as unpriced rather than keeping a price for a
  machine that is no longer selected; providers and regions are never crossed.
  Custom hardware is priced as the smallest catalogued machine that fits its
  CPU slots and memory. Hardware bigger than any catalogued machine is priced
  as the largest one and marked as a **floor** — the real charge is at least
  that — so scaling up can never make the estimate fall.
- A load balancer's service time and concurrency limit are charged once, on the
  way in; the response passes back through it without queueing again.
- Which server a request goes to is decided by the configured policy alone.

---

## Limitations

- Constant arrivals only; no bursts, ramps or Poisson arrivals.
- No autoscaling, serverless or background workers.
- A load balancer spreads work by policy alone: no health checks, connection
  reuse, sticky sessions or retries.
- One instance per component; no replicas (a pool is drawn as separate servers).
- One operation type per client.
- The p95 is a histogram estimate; the interface shows the bracket and the ±15%
  bucket width rather than claiming an exact value.
- Run history keeps the newest 25 runs per project.
- Only Chromium is covered by the browser test.

Full list, with priorities, in [future.md](future.md).

### Pricing: read this

Small/Medium/Large selections update the matching cloud rate within the selected
provider and region. Existing preset-based projects with mismatched prices are
repaired when opened or imported; saved results remain historical until you run
again. Manual cloud choices and custom hardware keep their selected rates.
If a size is unavailable, the component is unpriced; returning to a supported
size restores rates for the original provider. A manual mismatch offers
**Use matching rates** in Settings.

**AWS and Azure rates are read from the providers' own machine-readable price
lists** — the AWS Price List Bulk API and the Azure Retail Prices API — by
`npm run prices:refresh`, and are marked `"verified": true` with the source URL
and the provider's publication date. They are on-demand, Linux, single-instance
rates for one region each (`us-east-1`, `eastus`); the globally priced services
— Route 53, CloudFront, Azure DNS and Azure CDN — use the United States or
Zone 1 rates. `npm run prices:check` says
whether the shipped catalog still matches what the providers publish. The Cost
tab shows **Verified rates** when every priced line is one of these, and marks
each line with the date it was checked.

**Google Cloud rates are illustrative placeholders**, marked `"verified": false`
and labelled as such wherever they appear. Google publishes prices only through
an API that needs a key, and its pricing web page renders the table with
JavaScript. Set `GCP_BILLING_API_KEY` and the refresh script will read them.

Every rate is **editable in the interface**; your edits are saved with the
project and travel with export and import. A message queue's rate carries the
provider's own counting rule — AWS bills send, receive and delete as three
requests per message, and the estimate says so on the line.

The arithmetic is exact and explained: fixed compute and storage are charged for
a full 730-hour month regardless of traffic; outbound transfer is projected from
the measured rate during the run, never by scaling a short run's total; a
missing rate is reported as **unpriced** and excluded from the total, never
treated as zero; and what is excluded is listed alongside what is included.

---

## Project structure

```
public/catalogs/      versioned static JSON: hardware and cloud pricing
src/app/              shell, floating layout, theme, entry point, styles
src/catalogs/         catalog schemas and the fetch-validate-cache loader
src/domain/           shared types, Zod schemas, units, defaults, templates
src/features/editor/  Zustand store, canvas, palette, inspector, control bar
src/features/projects/ project create / open / rename / delete / import / export
src/features/results/  results, comparison, cost, chart
src/pricing/          the pricing engine (Decimal arithmetic)
src/simulation/       the pure simulation engine
src/simulation/models/ server, station (database/cache), link
src/storage/          Dexie database, run snapshots, import/export
src/ui/               shared interface primitives and the icon set
src/workers/          worker, worker client, message protocol
tests/                Vitest: engine, pricing, persistence, primitives
e2e/                  Playwright: the browser workflow and its regressions
```

**Dependency rule:** `src/simulation/**` imports only from `src/domain/**` and
itself — no React, no DOM, no IndexedDB, no worker APIs. That is what lets the
engine be unit tested in plain Node and run either in a worker or inline.

---

## Extension points

| You want to… | Change this | Nothing else needs to change |
|---|---|---|
| Add or correct a cloud rate | `public/catalogs/cloud-profiles.v1.json` | The pricing engine reads the catalog as data. |
| Add a hardware size | `public/catalogs/hardware.v1.json` | The inspector renders whatever the catalog contains. |
| Add a new arrival pattern | `workload.arrivalPattern` in `src/domain/types.ts`, plus the arrival handler in `src/simulation/engine.ts` | The field is already a discriminated union with one member. |
| Add a new charge type | `ChargeType` in `src/domain/types.ts` and a block in `src/pricing/pricing.ts` | The catalog schema and the cost table are generic over it. |
| Support a new route shape | `validateAndResolve` in `src/simulation/routing.ts` and the route compiler in the engine | The graph already stores full adjacency in both directions. |
| Add a component kind | The `ComponentKind` union and its settings type, its Zod schema, defaults, a form in the inspector, and a model under `src/simulation/models/` | The engine's event loop is generic over stations. |
| Change the safety limits | `DEFAULT_LIMITS` in `src/domain/types.ts` | Limits are passed into the engine, not hard-coded. |
| Restyle, or add a third theme | The custom properties in `src/app/styles.css` | Components name colour roles (`bg-surface`, `text-ink-2`), never hues. |

---

## Verification

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | passes |
| Unit tests | `npm test` | 428 passed, 22 files |
| Browser workflow | `npm run test:e2e` | 66 passed |
| Production build | `npm run build` | succeeds |

The unit tests are named after the acceptance checks they cover, so a failure
points straight at the requirement it broke.

---

## Licence

MIT.

All thirty-one components are part of the running application (entries 062–066). [implementation-plan.md](implementation-plan.md) records how the last sixteen were staged and released, and what remains outside their models.
