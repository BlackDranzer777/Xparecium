# Remaining components implementation

Status: complete. All sixteen components are released in the main application — each behind the palette gate of entry 062, one at a time, with its own browser case (entries 062–065) — and thirteen of them carry verified AWS rates, the other three an unpriced line with a stated reason (entry 066). The copy under `.implementation/all-components`, where the work was staged, is a reference only. The table below is the plan as it was written, with the status each stage reached; decisions.md holds the verification actually performed.

All sixteen components are simulated inside the browser. No real accounts, credentials, notifications, cloud resources, or infrastructure services are created. Existing projects, immutable runs, and manual pricing remain supported.

| Stage | Components | Behaviors verified | Status |
| --- | --- | --- | --- |
| A: data | Document database, wide-column store, search index, data warehouse, time-series database | Indexed reads versus scans; partition contention; indexing visibility delay; scan volume and throughput; ingestion, retention and queries | Released (entries 062–063); priced (066) |
| B: jobs | Event stream/log, dead-letter queue, scheduler | Retained events and consumer progress; bounded retries and exhausted messages; scheduled background jobs | Released (entry 064); priced (066) |
| C: real-time | WebSocket server, notification service | Connection capacity and messages; asynchronous delivery, provider limits and failures | Released (entry 065); priced (066) |
| D: shared services | Identity/authentication, standalone rate limiter, discovery/configuration, secrets manager, monitoring/logging, service mesh | Checks and refusals; token budget; cached lookups; simulated rotation; independent telemetry; bounded resilience policies | Released (entry 065); discovery, secrets and monitoring priced, identity, rate limiter and mesh unpriced with a reason (066) |

For every component, delivered: domain types and validated settings; explicit legal connections; bounded event-driven behavior; component-specific metrics; a priced line where a provider sells the thing and an honest unpriced line where none does; Inspector and palette; saving/reopening/export/import; focused unit and browser tests. Workload settings and old behavior survived; older saved documents reopen with the settings added since filled in (entry 067).

Final gates at release: all unit and Chromium tests, strict type checking, and production build (entry 065, and every entry since). Firefox and WebKit remain outside the baseline. What remains outside the models — exactly-once side effects, durable recovery after browser closure, partition rebalance, calendar cron, provider-specific deployment profiles — is listed in future.md.

## Modeling references

- [MongoDB query optimization](https://www.mongodb.com/docs/manual/core/query-optimization/): distinguish indexed work from collection scans using explicit average costs, not technology bonuses.
- [Kafka design](https://kafka.apache.org/41/design/design/): partitions retain events; consumers track progress separately from retention.
- [SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html): failed processing can exhaust a retry allowance and move a message aside.
- [Envoy transient failure handling](https://www.envoyproxy.io/docs/envoy/latest/faq/load_balancing/transient_failures.html): retries and circuit controls require explicit bounds; they do not create capacity.

These describe mechanisms, not provider performance or prices. New performance defaults will be editable modeling assumptions.
