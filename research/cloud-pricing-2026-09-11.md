# Real cloud prices, collected 2026-09-11

Everything on this page was read from a **machine-readable price list the provider
publishes**, on the date shown, with no account and no estimation. Nothing is
scaled, averaged or guessed. Where a number could not be read, it says so.

Companion file: `cloud-pricing-2026-09-11.json` — the same numbers, ready to turn
into a catalog.

## What was reachable

| Provider | Source | Access | Result |
|---|---|---|---|
| **AWS** | Price List Bulk API — per-region CSV files | Public, no account | Collected in full |
| **Azure** | Retail Prices API — public JSON, filterable | Public, no account | Collected in full |
| **Google Cloud** | Cloud Billing Catalog API | **Needs an API key** (HTTP 403 without one). The web pricing page renders its table with JavaScript, so it carries no numbers as text. | **Not collected** — see "What is still needed" |

## How to read the numbers

- **Prices are on-demand / pay-as-you-go, Linux, one instance, no reservation.**
  Windows adds a per-hour licence and is not listed.
- **Regions:** AWS `us-east-1` (N. Virginia), Azure `eastus` (Virginia). Other
  regions differ, sometimes by 10–30%.
- **"vCPU" is the provider's unit, not a core.** On AWS Intel families (t3, m7i,
  c7i, r7i) one vCPU is one hardware thread, so 2 vCPU is one physical core with
  hyper-threading. On AWS Graviton (m7g) one vCPU is one physical core. On Azure
  v5 families one vCPU is one hardware thread.
- **Aparecium's "CPU slot" is a simulation unit.** Mapping a slot count to one of
  these machines is a judgement to be recorded in the catalog — never arithmetic on
  the vCPU numbers.

---

## AWS — us-east-1

Source: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{Offer}/current/us-east-1/index.csv`
Publication dates in the files: EC2 2026-09-10 19:55 UTC; RDS, ElastiCache, SQS, ELB 2026-09-11 12:44–12:46 UTC; Data Transfer 2026-09-11 13:33 UTC.

### EC2 (application servers) — Linux, shared tenancy, on-demand

| Type | vCPU | Memory | USD / hour | Processor |
|---|---|---|---|---|
| t3.small | 2 | 2 GiB | 0.0208 | Intel, burstable |
| t3.medium | 2 | 4 GiB | 0.0416 | Intel, burstable |
| t3.large | 2 | 8 GiB | 0.0832 | Intel, burstable |
| t3.xlarge | 4 | 16 GiB | 0.1664 | Intel, burstable |
| m7i.large | 2 | 8 GiB | 0.1008 | Intel Sapphire Rapids |
| m7i.xlarge | 4 | 16 GiB | 0.2016 | Intel Sapphire Rapids |
| m7i.2xlarge | 8 | 32 GiB | 0.4032 | Intel Sapphire Rapids |
| m7i.4xlarge | 16 | 64 GiB | 0.8064 | Intel Sapphire Rapids |
| m6i.large | 2 | 8 GiB | 0.0960 | Intel Ice Lake |
| m6i.xlarge | 4 | 16 GiB | 0.1920 | Intel Ice Lake |
| m6i.2xlarge | 8 | 32 GiB | 0.3840 | Intel Ice Lake |
| c7i.large | 2 | 4 GiB | 0.0893 | compute-optimised |
| c7i.xlarge | 4 | 8 GiB | 0.1785 | compute-optimised |
| c7i.2xlarge | 8 | 16 GiB | 0.3570 | compute-optimised |
| r7i.large | 2 | 16 GiB | 0.1323 | memory-optimised |
| r7i.xlarge | 4 | 32 GiB | 0.2646 | memory-optimised |
| r7i.2xlarge | 8 | 64 GiB | 0.5292 | memory-optimised |
| m7g.large | 2 | 8 GiB | 0.0816 | Graviton3 (Arm) |
| m7g.xlarge | 4 | 16 GiB | 0.1632 | Graviton3 (Arm) |
| m7g.2xlarge | 8 | 32 GiB | 0.3264 | Graviton3 (Arm) |

**What this says about the current catalog:** the illustrative rates in
`cloud-profiles.v1.json` were t3.medium 0.05, m7i.large 0.10, m7i.xlarge 0.20.
The real figures are 0.0416, 0.1008, 0.2016 — close, but not the same, and the
catalog now has a source to cite.

### RDS PostgreSQL (databases) — single-AZ, on-demand

| Type | vCPU | Memory | USD / hour |
|---|---|---|---|
| db.t4g.medium | 2 | 4 GiB | 0.0650 |
| db.m6g.large | 2 | 8 GiB | 0.1590 |
| db.m7g.large | 2 | 8 GiB | 0.1680 |
| db.m7g.xlarge | 4 | 16 GiB | 0.3370 |
| db.m7g.2xlarge | 8 | 32 GiB | 0.6740 |
| db.r7g.large | 2 | 16 GiB | 0.2390 |

Storage (General Purpose gp3): **0.115 USD per GB-month**. Multi-AZ roughly doubles the instance price.

### ElastiCache Redis (caches) — on-demand

| Type | vCPU | Memory | USD / hour |
|---|---|---|---|
| cache.t4g.medium | 2 | 3.09 GiB | 0.0650 |
| cache.m6g.large | — | — | 0.1190 |
| cache.m7g.large | 2 | 6.38 GiB | 0.1580 |
| cache.m7g.xlarge | 4 | 12.93 GiB | 0.3150 |
| cache.r7g.large | — | — | 0.3500 |
| cache.r7g.xlarge | — | — | 0.6990 |

(vCPU/memory blank where the price list row did not carry them.)

### Application Load Balancer

**0.0225 USD per hour** plus **0.008 USD per LCU-hour**. An LCU is a capacity unit
measured across new connections, active connections, bytes processed and rule
evaluations; a light workload uses a fraction of one.

### SQS (message queue)

| Queue type | USD per million requests |
|---|---|
| Standard | 0.40 |
| FIFO | 0.50 |

First 1,000,000 requests per month are free. **Each API call is a request**: send,
receive and delete are counted separately, so one message usually costs about
three requests. The current catalog's illustrative 0.40 happens to match the
standard rate — but it counts one request per message, which understates it.

### The edge — Route 53, CloudFront, API Gateway, WAF (added 2026-09-12)

Read from the bulk API on 2026-09-12; the files are dated 2026-09-11. Route 53
and CloudFront are priced globally, so their rows are in the offer's whole-file
index (`.../AmazonRoute53/current/index.csv`), not the regional one.

| Service | What is billed | USD | Tier |
|---|---|---|---|
| Route 53 | standard DNS queries | 0.40 per million | first 1 billion/month; 0.20 beyond |
| Route 53 | hosted zone | 0.50 per zone-month | first 25 zones; 0.10 beyond |
| CloudFront | HTTPS requests (United States) | 0.0100 per 10,000 (= 1.00 per million) | flat |
| CloudFront | HTTP requests (United States) | 0.0075 per 10,000 | flat |
| CloudFront | data transfer out to users (United States) | 0.085 per GB | first 10 TB/month |
| API Gateway | HTTP API requests | 1.00 per million | first 300 million/month |
| AWS WAF | web ACL | 5.00 per month, prorated hourly | flat |
| AWS WAF | rule | 1.00 per rule-month | flat |
| AWS WAF | requests inspected | 0.60 per million | tier 1 |

The WAF file also carries *Shield-protected* rows for the same meters at 0.00 —
those apply only to accounts with Shield Advanced and are not the list price.
CloudFront gives 1 TB and 10 million requests a month free; API Gateway gives
one million a month free for the first year. Neither credit is a row.

### Storage, key-value, functions, topics (added 2026-09-12)

Read from the regional bulk files dated 2026-09-11.

| Service | What is billed | USD | Tier |
|---|---|---|---|
| S3 Standard | storage | 0.023 per GB-month | first 50 TB; 0.022 next 450 TB; 0.021 beyond |
| S3 Standard | PUT, COPY, POST, LIST | 0.005 per 1,000 (= 5.00 per million) | flat |
| S3 Standard | GET and all other | 0.0004 per 1,000 (= 0.40 per million) | flat |
| DynamoDB on-demand | read request units | 0.125 per million | flat |
| DynamoDB on-demand | write request units | 0.625 per million | flat |
| DynamoDB | storage | 0.25 per GB-month | after 25 GB free |
| Lambda | requests | 0.20 per million | after 1M free |
| Lambda (x86) | duration | 0.0000166667 per GB-second | first 6 billion GB-s; 0.000015 and 0.0000133334 beyond |
| SNS | API requests (publishes) | 0.50 per million | after 1M free |

DynamoDB's *infrequent-access* table class (0.155 / 0.78) and the *replicated
write* units of global tables were read and not used.

### Twelve more services for the newest components (added 2026-09-14)

Read from the regional bulk files dated 2026-09-11. EventBridge's offer code is
`AWSEvents`. Rows are quoted as the list gives them; the mapping each profile
applies is in its note in the catalog.

| Service | What is billed | USD |
|---|---|---|
| DocumentDB | db.r6g.large, I/O-Optimized instance | 0.2895 per hour (column); description says 0.289465 |
| DocumentDB | I/O-Optimized storage | 0.30 per GB-month |
| DocumentDB | standard instance / storage / I/O | 0.26315 per hour / 0.10 per GB-month / 0.20 per million I/Os (not used) |
| Keyspaces | on-demand read / write request units | 0.125 / 0.625 per million |
| Keyspaces | storage | 0.25 per GB-month |
| OpenSearch Service | r6g.large.search / t3.small.search | 0.167 / 0.036 per hour |
| OpenSearch Service | gp3 storage | 0.122 per GB-month |
| Redshift | ra3.xlplus node / dc2.large node | 1.086 / 0.25 per hour |
| Redshift | managed storage (RA3) | 0.024 per GB-month |
| Redshift | Serverless | 0.375 per RPU-hour (not used: no RPU in the model) |
| Athena | data scanned | 5.00 per TB |
| Timestream | data ingested | 0.50 per GB |
| Timestream | magnetic store / memory store | 0.03 per GB-month / 0.036 per GB-hour |
| Timestream | data scanned by queries | 0.01 per GB (not used: not measured) |
| Kinesis Data Streams | provisioned shard-hour | 0.015 |
| Kinesis Data Streams | PUT payload units | 0.014 per million |
| Kinesis Data Streams | on-demand stream-hour / GB in / GB out | 0.04 / 0.08 / 0.04 (not used) |
| EventBridge Scheduler | scheduled invocations | 1.00 per million after 14 million free |
| API Gateway | WebSocket messages | 1.00 per million (first billion); 0.25 per million connection-minutes not used |
| Secrets Manager | secret / API requests | 0.40 per secret-month / 0.05 per 10,000 |
| Cloud Map | registered resource / discovery API calls | 0.10 per resource-month / 1.00 per million |
| SES | recipients | 0.0001 per recipient |
| CloudWatch Logs | Standard class ingestion / storage | 0.50 per GB / 0.03 per GB-month |
| Cognito | User Pools MAU tier 1 / Essentials MAU | 0.0055 / 0.015 per MAU (read for the note; not applied) |

### Data transfer out to the internet

| Monthly volume | USD per GB |
|---|---|
| first 10,240 GB | 0.090 |
| next 40,960 GB | 0.085 |
| next 102,400 GB | 0.070 |
| beyond 153,600 GB | 0.050 |

AWS also gives 100 GB/month outbound free per account; that credit is not a row
in the price list.

---

## Azure — eastus

Source: `https://prices.azure.com/api/retail/prices?$filter=...` — retrieved 2026-09-11. vCPU and memory for VM SKUs come from the SKU's public specification; the price API carries only the price.

### Virtual Machines (application servers) — Linux, pay-as-you-go

| SKU | vCPU | Memory | USD / hour | Series |
|---|---|---|---|---|
| Standard_B2s | 2 | 4 GiB | 0.0416 | B, burstable |
| Standard_B2ms | 2 | 8 GiB | 0.0832 | B, burstable |
| Standard_D2s_v5 | 2 | 8 GiB | 0.0960 | Dsv5 general purpose |
| Standard_D4s_v5 | 4 | 16 GiB | 0.1920 | Dsv5 general purpose |
| Standard_D8s_v5 | 8 | 32 GiB | 0.3840 | Dsv5 general purpose |
| Standard_D2ps_v5 | 2 | 8 GiB | 0.0770 | Dpsv5, Arm (Ampere) |
| Standard_D4ps_v5 | 4 | 16 GiB | 0.1540 | Dpsv5, Arm (Ampere) |
| Standard_E2s_v5 | 2 | 16 GiB | 0.1260 | Esv5 memory-optimised |
| Standard_E4s_v5 | 4 | 32 GiB | 0.2520 | Esv5 memory-optimised |
| Standard_F2s_v2 | 2 | 4 GiB | 0.0846 | Fsv2 compute-optimised |
| Standard_F4s_v2 | 4 | 8 GiB | 0.1690 | Fsv2 compute-optimised |

### Azure Database for PostgreSQL — Flexible Server

Priced **per vCore-hour**, not per instance:

| Tier | USD per vCore-hour | Example |
|---|---|---|
| General Purpose Ddsv5 | 0.0890 | D2ds_v5 (2 vCore) = 0.1780 / hr; D4ds_v5 = 0.3560 / hr |
| General Purpose Dadsv5 (AMD) | 0.0855 | |
| Burstable B2ms | 0.1360 / hr (whole instance) | |

Backup storage: 0.095 USD per GB-month.

### Azure Cache for Redis

| Tier | USD / hour |
|---|---|
| Standard C1 (1 GB) | 0.1380 |
| Standard C2 (2.5 GB) | 0.2250 |
| Standard C3 (6 GB) | 0.4500 |
| Premium P1 (6 GB) | 0.5550 |
| Premium P2 (13 GB) | 1.1100 |

### Load Balancer (Standard) — priced globally

**0.025 USD per hour** (includes 5 rules) + **0.010 USD per extra rule-hour** +
**0.005 USD per GB processed**.

### Service Bus (message queue)

| Tier | USD per million operations |
|---|---|
| Basic | 0.05 |
| Standard | 0.80 first tier, then 0.50, then 0.20 (plus a base charge) |
| Premium | 0.9275 per messaging-unit hour |

### Azure DNS and Azure CDN from Microsoft (added 2026-09-12)

| Service | What is billed | USD | Tier |
|---|---|---|---|
| Azure DNS | public queries (Zone 1) | 0.40 per million | first 1 billion/month; 0.20 beyond |
| Azure DNS | hosted zone | 0.50 per zone-month | first 25 |
| Azure CDN from Microsoft | Standard requests (Zone 1) | 0.60 per million | first tier |
| Azure CDN from Microsoft | Standard data transfer (Zone 1) | 0.081 per GB | first tier |

Zone 1 is North America and Europe. Azure API Management (unit-hours per tier)
and Front Door (base fee plus zone tables) were read and not used: neither fits
the four charge types honestly.

### Blob Storage and Functions (added 2026-09-12)

| Service | What is billed | USD | Tier |
|---|---|---|---|
| Blob Storage, GPv2, Hot, LRS | data stored | 0.0208 per GB-month | first 50 TB |
| Blob Storage, Hot | write operations | 0.05 per 10,000 (= 5.00 per million) | flat |
| Blob Storage, Hot | read operations | 0.004 per 10,000 (= 0.40 per million) | flat |
| Functions, Consumption | executions | 0.20 per million | after 1M free |
| Functions, Consumption | execution time | 0.000016 per GB-second | after 400,000 free |

The Flex Consumption plan (0.000026 per GB-second on demand, plus always-ready
instances) was read and not used.

### Data transfer out to the internet — default (Microsoft network) routing

| Monthly volume | USD per GB |
|---|---|
| first 100 GB | 0.000 |
| next 10,235 GB | 0.087 |
| next 40,960 GB | 0.083 |
| next 102,400 GB | 0.070 |
| beyond 153,695 GB | 0.050 |

The cheaper "Internet routing" option is 0.080 / 0.065 / 0.060 / 0.040 across the same tiers.

---

## What is still needed

**Google Cloud.** The only official machine-readable source needs an API key.
Creating one is free but is an account action, so it is yours to do:

1. In a Google Cloud project, enable *Cloud Billing API* and create an API key.
2. Then this works, no SDK required:
   `https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus?key=YOUR_KEY`
   (`6F81-5844-456A` is Compute Engine; Cloud SQL, Memorystore and Pub/Sub have their own service ids, listable at `/v1/services`.)

Paste the key into a local environment variable — never into the repo — and the
same script that read AWS and Azure can read Google.

**Not covered anywhere yet:** Windows licensing, reserved/savings-plan discounts,
multi-AZ databases, and regions other than the two above.

## How this becomes a catalog

`cloud-profiles.v1.json` already has the fields for this: `verified`,
`priceSourceUrl`, `priceCheckedAt`, `priceNote`, and per-charge `unit` /
`amount`. A profile built from this page can honestly say `verified: true`,
name the bulk-API URL and the publication date, and drop the "(illustrative)"
suffix. The `future.md` idea "Verified pricing from a machine-readable source"
describes the build-time script that would keep it current.
