import type { SupportKind, SupportNode } from './support-services';
import type { JobKind, JobServiceNode } from './job-services';
import type { DataKind, DataServiceNode } from './data-services';
/**
 * Aparecium domain types.
 *
 * These describe what the user draws and configures. They are plain, serialisable
 * data: no classes, no functions, no references to React, the DOM or IndexedDB.
 * The simulation engine, the pricing engine and the storage layer all consume
 * these same shapes.
 */

/**
 * 1 -> 2: clients gained a mode and a think time, and the workload gained
 * shaped arrival patterns and their options. Both are filled in with defaults
 * by `upgradeDocument`, so a version 1 document opens without complaint.
 * 2 -> 3: a server's Resource profile may be `xlarge`. Nothing to fill in, but
 * a build that does not know the value must refuse the document with the
 * version message rather than a validation error about an enum.
 * 3 -> 4: four edge components — DNS, CDN, WAF, API gateway. A document that
 * uses one cannot be opened by a build that does not know them.
 * 4 -> 5: five more kinds — serverless function, read replica, key-value
 * store, object storage, pub/sub topic — and a database's `readShare`, filled
 * in with the default for older documents.
 */
export const DOCUMENT_SCHEMA_VERSION = 6;

export type ComponentKind =
  | 'client'
  | 'dns'
  | 'cdn'
  | 'waf'
  | 'apiGateway'
  | 'loadBalancer'
  | 'server'
  | 'serverless'
  | 'database'
  | 'readReplica'
  | 'kvStore'
  | 'objectStorage'
  | 'cache'
  | 'queue'
  | 'pubsub'
  | DataKind
  | JobKind | SupportKind;

/** The kinds that run your code: an entry point, a queue's consumer. */
export const COMPUTE_KINDS = ['server', 'serverless'] as const;
export type ComputeKind = (typeof COMPUTE_KINDS)[number];

/** The four kinds that sit in front of the entry point, in the request's path. */
export const EDGE_KINDS = ['cdn', 'waf', 'apiGateway', 'websocket', 'rateLimiter', 'serviceMesh'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Where a component lives. `null` means "not assigned to a cloud profile". */
export interface CloudAssignment {
  profileId: string | null;
  /** Explicit rate choices survive automatic hardware matching and reopening. */
  pricingMode?: 'automatic' | 'manual';
  /** Retain the provider/region when an automatic size match is unavailable. */
  previousProfileId?: string;
}

/**
 * How a group of users decides when to send its next request.
 *
 * `open`: requests are generated at a rate, whether or not earlier ones ever
 * came back. Simple, and the right model for traffic arriving from a large
 * population you do not control — but it keeps piling load onto a system that
 * is already failing, which overstates what a real crowd would do.
 *
 * `closed`: a fixed number of users, each of whom waits for its own response,
 * thinks for a while, and only then sends the next request. The offered rate is
 * then an *outcome* rather than a setting: when the system slows down, the users
 * slow down with it, which is what people actually do.
 */
export type ClientMode = 'open' | 'closed';

export interface ClientSettings {
  mode: ClientMode;
  /** Number of simultaneously active users represented by this client. */
  activeUsers: number;
  /** Actions each active user performs per minute. One action = one request. */
  actionsPerUserPerMinute: number;
  /**
   * Closed mode only: how long a user waits after receiving a response before
   * sending the next request. Drawn from an exponential distribution with this
   * mean, from a stream of its own.
   */
  thinkTimeMs: number;
  /** Advanced: if set, replaces the users x actions calculation entirely (requests/second). */
  requestRateOverridePerSecond: number | null;
  /** Advanced: bytes sent by the client for one request. */
  requestBytes: number;
  /** Advanced: bytes the server sends back for one response. */
  responseBytes: number;
}

/** How a load balancer picks which server gets the next request. */
export type LoadBalancingPolicy = 'round-robin' | 'least-busy';

export interface LoadBalancerSettings {
  /** How many requests it can be forwarding at the same instant. */
  maxConcurrentRequests: number;
  /** Average time it spends on one request before forwarding it. */
  serviceTimeMs: number;
  /** How many requests may wait. Beyond this, requests are rejected. */
  queueLimit: number;
  policy: LoadBalancingPolicy;
}

export type ServerProfileId = 'small' | 'medium' | 'large' | 'xlarge' | 'custom';

export interface ServerSettings {
  /** Basic control. Choosing anything other than `custom` overwrites the advanced fields. */
  profile: ServerProfileId;
  /** Simplified model of usable compute capacity: how many requests can compute at once. */
  cpuSlots: number;
  ramMb: number;
  /** Average CPU work one request needs, in milliseconds of a single CPU slot. */
  cpuMsPerRequest: number;
  /** How many requests the application will hold open at once (admitted requests). */
  concurrencyLimit: number;
  /** Memory the process uses before serving any request. */
  baselineMemoryMb: number;
  /** Memory charged to each admitted request for its whole lifetime. */
  memoryPerRequestMb: number;
  /** Explicit assumption: memory charged to a request that is only waiting in the queue. */
  memoryPerQueuedRequestMb: number;
  /** How many requests may wait for admission. Beyond this, requests are rejected. */
  queueLimit: number;
}

export interface DatabaseSettings {
  /** Stored data size. Used for storage cost accounting only. */
  dataSizeGb: number;
  /**
   * Share of queries that only read, 0..1. Reads can be answered by a Read
   * Replica when one is connected to the server; writes always go here.
   */
  readShare: number;
  /** Average time to serve one query once it has a slot. */
  queryServiceTimeMs: number;
  maxConcurrentQueries: number;
  queueLimit: number;
  /** Bytes on the wire for a query request. */
  queryRequestBytes: number;
  /** Bytes on the wire for a query result. */
  queryResultBytes: number;
}

export interface CacheSettings {
  lookupServiceTimeMs: number;
  /** Assumed probability that a lookup is a hit, 0..1. Fixed; not learned from traffic. */
  hitRate: number;
  maxConcurrentLookups: number;
  /** Configured capacity. Used for configuration and pricing; does not change the hit rate. */
  capacityGb: number;
  queueLimit: number;
  /** Whether the server writes the value back to the cache after a miss. */
  populateOnMiss: boolean;
  /** Simplified write cost for populating the cache after a miss. */
  populateServiceTimeMs: number;
  lookupRequestBytes: number;
  lookupResultBytes: number;
  populateBytes: number;
}

/**
 * A message queue between an application server and a consumer.
 *
 * The point of it is that the publisher does not wait for the work: the server
 * hands the message over, gets an acknowledgement, and answers its own caller,
 * while the consumer works through the backlog at its own pace. What that buys
 * — a response time that no longer includes the slow part — and what it costs —
 * a backlog that grows without bound when the consumer cannot keep up — is the
 * whole reason to draw one.
 *
 * The broker itself is modelled as a service station: it accepts publishes with
 * a small service time and its own concurrency. The backlog is separate, and is
 * the number worth watching.
 *
 * Not modelled in this version: retries, dead-letter queues, ordering
 * guarantees, visibility timeouts, partitions, or more than one consumer.
 */
export interface QueueSettings {
  processingFailureShare: number;
  maxAttempts: number;
  retryDelayMs: number;
  /** How many messages may be waiting. A publish beyond this is refused. */
  maxDepth: number;
  /** Average time the broker takes to accept one message. */
  publishServiceTimeMs: number;
  /** How many publishes the broker can be accepting at the same instant. */
  maxConcurrentPublishes: number;
  /** How many publishes may wait for the broker. Beyond this, the publish fails. */
  publishQueueLimit: number;
  /** Bytes on the wire for one message. */
  messageBytes: number;
}

/**
 * DNS: turns a name into an address, before the request is sent.
 *
 * Not in the request's path — beside it. A user's machine caches the answer
 * for the record's TTL, so only a share of requests pay for a lookup at all;
 * the rest already know where to go. That share is a setting, because it is
 * an assumption about caching and there is nothing here to derive it from.
 */
export interface DnsSettings {
  /** Average time the resolver takes to answer. */
  lookupServiceTimeMs: number;
  maxConcurrentLookups: number;
  queueLimit: number;
  /** Share of requests that need a fresh lookup, 0..1. The rest are cached. */
  lookupShare: number;
  queryBytes: number;
  answerBytes: number;
}

/**
 * CDN: a cache at the edge, in front of everything.
 *
 * A hit is answered here and never reaches your servers; a miss goes through
 * to the origin and the answer comes back this way. The hit rate is assumed,
 * as the application cache's is, because nothing here models what is being
 * asked for.
 */
export interface CdnSettings {
  /** Assumed share of requests answered at the edge, 0..1. */
  hitRate: number;
  serviceTimeMs: number;
  maxConcurrentRequests: number;
  queueLimit: number;
}

/**
 * WAF / reverse proxy: inspects every request and turns some away.
 *
 * The blocked share is an assumption about the traffic, not a detection
 * model. What the simulation shows is the consequence: blocked requests never
 * reach anything behind the firewall, so everything behind it sees less load.
 */
export interface WafSettings {
  serviceTimeMs: number;
  maxConcurrentRequests: number;
  queueLimit: number;
  /** Share of requests judged malicious and refused, 0..1. */
  blockRate: number;
}

/**
 * API gateway: the front door, with a rate limit.
 *
 * It forwards, it never computes — but it is the one component that says no
 * on purpose. Above the limit, requests are refused rather than queued, which
 * is what a real gateway does and what protects everything behind it.
 */
export interface ApiGatewaySettings {
  serviceTimeMs: number;
  maxConcurrentRequests: number;
  queueLimit: number;
  /** Requests per second let through. Null means no limit. */
  rateLimitPerSecond: number | null;
  /** How many requests above the steady rate a short burst may carry. */
  burstCapacity: number;
}

/**
 * Serverless function: your code, run per request, with no server to keep.
 *
 * Nothing is provisioned, so there is no CPU-slot contention and no waiting
 * line: each invocation gets its own capacity, up to an account-wide limit,
 * and anything over that limit is refused on the spot. What it costs is
 * wall-clock time — the provider bills every millisecond an invocation is
 * alive, including the time it spends waiting for a database — and a cold
 * start now and then when there is no warm instance to reuse.
 */
export interface ServerlessSettings {
  /** Average CPU work one invocation needs. */
  cpuMsPerRequest: number;
  /** Memory allotted to each invocation. Sets the billing rate per second. */
  memoryMb: number;
  /** Invocations that may run at once, account-wide. Above it, requests are refused. */
  maxConcurrentInvocations: number;
  /** Share of invocations that find no warm instance and pay a cold start, 0..1. */
  coldStartShare: number;
  coldStartMs: number;
}

/**
 * Read replica: a copy of a database that only answers reads.
 *
 * Reads are the queries it takes off the primary; writes still land on the
 * primary and, a moment later, on every replica too — applying them costs the
 * replica time, which is why replicas scale reads and never writes.
 */
export interface ReadReplicaSettings {
  queryServiceTimeMs: number;
  maxConcurrentQueries: number;
  queueLimit: number;
  /** Time the replica spends applying one write that reached the primary. */
  applyServiceTimeMs: number;
}

/**
 * Key-value / document store: records looked up by key, at any scale.
 *
 * A managed one scales itself, so its concurrency is effectively unbounded and
 * the bill is per request instead of per machine. Reads and writes are priced
 * differently, so the share of each is a setting.
 */
export interface KvStoreSettings {
  readServiceTimeMs: number;
  writeServiceTimeMs: number;
  /** Share of operations that read, 0..1. The rest write. */
  readShare: number;
  maxConcurrentRequests: number;
  queueLimit: number;
  /** Bytes on the wire for one record, read or written. */
  itemBytes: number;
  /** Stored data size. Used for storage cost accounting only. */
  storedGb: number;
}

/**
 * Object storage: files — images, uploads, backups — kept by the bucket-full.
 *
 * Every request through the server reads or writes one object. Reads and
 * writes take different times and are priced differently; what is kept is
 * priced by the gigabyte-month.
 */
export interface ObjectStorageSettings {
  getServiceTimeMs: number;
  putServiceTimeMs: number;
  /** Share of operations that write an object, 0..1. The rest read one. */
  writeShare: number;
  /** Size of the object read or written, on the wire. */
  objectBytes: number;
  maxConcurrentRequests: number;
  queueLimit: number;
  /** Stored data size. Used for storage cost accounting only. */
  storedGb: number;
}

/**
 * Pub/sub topic: one event, many listeners.
 *
 * A queue hands each message to one consumer; a topic hands a copy to every
 * subscriber, each with a backlog of its own. The publisher waits only for the
 * broker to accept the message, and never hears whether a subscriber kept up:
 * a full subscription drops its copy and counts it, the way a real topic does.
 */
export interface PubSubSettings {
  publishServiceTimeMs: number;
  maxConcurrentPublishes: number;
  /** How many publishes may wait for the broker. Beyond this, the publish fails. */
  publishQueueLimit: number;
  messageBytes: number;
  /** How many messages each subscription may hold. Beyond this, a copy is dropped. */
  maxDepth: number;
}

export type ComponentSettings =
  | ClientSettings
  | LoadBalancerSettings
  | ServerSettings
  | ServerlessSettings
  | DatabaseSettings
  | ReadReplicaSettings
  | KvStoreSettings
  | ObjectStorageSettings
  | CacheSettings
  | QueueSettings
  | PubSubSettings
  | DnsSettings
  | CdnSettings
  | WafSettings
  | ApiGatewaySettings;

export interface NodeBase {
  id: string;
  name: string;
  position: { x: number; y: number };
  cloud: CloudAssignment;
}

export interface QueueNode extends NodeBase {
  kind: 'queue';
  settings: QueueSettings;
}
export interface ServerlessNode extends NodeBase {
  kind: 'serverless';
  settings: ServerlessSettings;
}
export interface ReadReplicaNode extends NodeBase {
  kind: 'readReplica';
  settings: ReadReplicaSettings;
}
export interface KvStoreNode extends NodeBase {
  kind: 'kvStore';
  settings: KvStoreSettings;
}
export interface ObjectStorageNode extends NodeBase {
  kind: 'objectStorage';
  settings: ObjectStorageSettings;
}
export interface PubSubNode extends NodeBase {
  kind: 'pubsub';
  settings: PubSubSettings;
}

export interface DnsNode extends NodeBase {
  kind: 'dns';
  settings: DnsSettings;
}
export interface CdnNode extends NodeBase {
  kind: 'cdn';
  settings: CdnSettings;
}
export interface WafNode extends NodeBase {
  kind: 'waf';
  settings: WafSettings;
}
export interface ApiGatewayNode extends NodeBase {
  kind: 'apiGateway';
  settings: ApiGatewaySettings;
}

export interface ClientNode extends NodeBase {
  kind: 'client';
  settings: ClientSettings;
}
export interface LoadBalancerNode extends NodeBase {
  kind: 'loadBalancer';
  settings: LoadBalancerSettings;
}

export interface ServerNode extends NodeBase {
  kind: 'server';
  settings: ServerSettings;
}
export interface DatabaseNode extends NodeBase {
  kind: 'database';
  settings: DatabaseSettings;
}
export interface CacheNode extends NodeBase {
  kind: 'cache';
  settings: CacheSettings;
}

export type ArchNode =
  | SupportNode
  | JobServiceNode
  | DataServiceNode
  | ClientNode
  | DnsNode
  | CdnNode
  | WafNode
  | ApiGatewayNode
  | LoadBalancerNode
  | ServerNode
  | ServerlessNode
  | DatabaseNode
  | ReadReplicaNode
  | KvStoreNode
  | ObjectStorageNode
  | CacheNode
  | QueueNode
  | PubSubNode;

export interface LinkSettings {
  /** One-way propagation delay in milliseconds (applies in each direction). */
  propagationDelayMs: number;
  /** Link bandwidth in megabits per second (applies in each direction). */
  bandwidthMbps: number;
}

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  settings: LinkSettings;
}

/**
 * How traffic is spread across the run.
 *
 * `constant` is evenly spaced, which is what every earlier version did.
 * `poisson` is the only one that draws random numbers: intervals come from an
 * exponential distribution with the same mean, which is the standard model for
 * independent arrivals and makes results vary from seed to seed. `ramp` and
 * `burst` stay deterministic — they vary the *rate* over time and keep the
 * spacing even at whatever rate is current.
 */
export type ArrivalPattern = 'constant' | 'poisson' | 'ramp' | 'burst';

/**
 * The numbers the shaped patterns need.
 *
 * One flat object rather than a discriminated union: the fields a pattern does
 * not use are simply ignored, which keeps the schema, the settings form and the
 * simulation signature straightforward. Multipliers are relative to the rate the
 * client is configured for, so changing the pattern never silently changes how
 * much traffic the design is asked to carry on average.
 */
export interface ArrivalOptions {
  /** ramp: rate at the start of the window, as a multiple of the configured rate. */
  rampStartMultiplier: number;
  /** ramp: rate at the end of the window. */
  rampEndMultiplier: number;
  /** burst: how often a burst begins, in seconds. */
  burstPeriodSeconds: number;
  /** burst: how long each burst lasts, in seconds. Clamped to the period. */
  burstDurationSeconds: number;
  /** burst: rate during a burst, as a multiple of the configured rate. */
  burstMultiplier: number;
}

export interface Workload {
  /** How long new requests are generated for, in seconds of simulated time. */
  durationSeconds: number;
  /** Extra simulated time allowed for in-flight work to finish after arrivals stop. */
  drainSeconds: number;
  /** Seed for the pseudorandom streams. Same seed + same input = same result. */
  seed: number;
  arrivalPattern: ArrivalPattern;
  arrivalOptions: ArrivalOptions;
}

/** The three kinds of charge Aparecium prices. Declared here so the domain
 * layer stays the base of the dependency graph. */
/**
 * The kinds of charge Aparecium prices. `writes` is for stores that bill reads
 * and writes at different rates; `duration` is for compute billed by the
 * gigabyte-second it is alive rather than by the hour it is provisioned.
 */
export type ChargeType =
  | 'compute'
  | 'storage'
  | 'egress'
  | 'requests'
  | 'writes'
  | 'duration'
  | 'scan'
  /** Gigabytes taken in: log records, time-series points. */
  | 'ingest';

/**
 * User edits to catalog rates, keyed by cloud profile id. Amounts are decimal
 * strings so they survive JSON without binary floating-point drift.
 * A `null` amount explicitly means "unpriced", which is never the same as zero.
 */
export type RateOverrides = Partial<Record<ChargeType, string | null>>;

export interface ArchitectureDocument {
  schemaVersion: number;
  nodes: ArchNode[];
  edges: ArchEdge[];
  workload: Workload;
  /** Optional per-profile rate edits. Empty for a fresh project. */
  pricingOverrides: Record<string, RateOverrides>;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  document: ArchitectureDocument;
}

/** Hard stops so a runaway configuration cannot hang the browser. */
export interface SimulationLimits {
  maxPendingEvents: number;
  maxInFlightRequests: number;
  maxProcessedEvents: number;
  maxJourneySamples: number;
}

export const DEFAULT_LIMITS: SimulationLimits = {
  maxPendingEvents: 500_000,
  maxInFlightRequests: 200_000,
  maxProcessedEvents: 5_000_000,
  maxJourneySamples: 8,
};
