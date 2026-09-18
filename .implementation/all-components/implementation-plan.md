# Remaining components implementation

Status: in progress. This document tracks authorized work; entries below are not claims that features or tests are finished.

All sixteen components will be simulated inside the browser. No real accounts, credentials, notifications, cloud resources, or infrastructure services are created. Existing projects, immutable runs, and manual pricing remain supported.

| Stage | Components | Behaviors to verify | Status |
| --- | --- | --- | --- |
| A: data | Document database, wide-column store, search index, data warehouse, time-series database | Indexed reads versus scans; partition contention; indexing visibility delay; scan volume and throughput; ingestion, retention and queries | Verified in staged copy |
| B: jobs | Event stream/log, dead-letter queue, scheduler | Retained events and consumer progress; bounded retries and exhausted messages; scheduled background jobs | Engine integrated; 65 focused tests passed; UI verification pending |
| C: real-time | WebSocket server, notification service | Connection capacity and messages; asynchronous delivery, provider limits and failures | In progress |
| D: shared services | Identity/authentication, standalone rate limiter, discovery/configuration, secrets manager, monitoring/logging, service mesh | Checks and refusals; token budget; cached lookups; simulated rotation; independent telemetry; bounded resilience policies | In progress |

For every component: domain types and validated settings; explicit legal connections; bounded event-driven behavior; component-specific metrics; honest unpriced catalog entries when rates are unavailable; Inspector and palette; saving/reopening/export/import; focused tests. Workload settings and old behavior must survive.

Work is staged in `.implementation/all-components`. The existing application remains available during development. Compare baseline file hashes before integrating so concurrent edits are preserved. Required documentation is updated at each stage; decisions.md records performed verification separately from planned checks. Final gates: all unit and Chromium tests, strict type checking, and production build. Firefox and WebKit are outside the current baseline.

## Modeling references

- [MongoDB query optimization](https://www.mongodb.com/docs/manual/core/query-optimization/): distinguish indexed work from collection scans using explicit average costs, not technology bonuses.
- [Kafka design](https://kafka.apache.org/41/design/design/): partitions retain events; consumers track progress separately from retention.
- [SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html): failed processing can exhaust a retry allowance and move a message aside.
- [Envoy transient failure handling](https://www.envoyproxy.io/docs/envoy/latest/faq/load_balancing/transient_failures.html): retries and circuit controls require explicit bounds; they do not create capacity.

These describe mechanisms, not provider performance or prices. New performance defaults will be editable modeling assumptions.
