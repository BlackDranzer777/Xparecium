import type { SupportMetrics } from './models/support-service';
import type { DataKind } from '../domain/data-services';
/**
 * The contract between the simulation engine and everything else.
 *
 * Nothing here references React, the DOM, IndexedDB or the Worker API. The
 * engine is a pure function of (document, limits) -> result, which is what
 * makes it testable in Node and reusable in a worker.
 */
import type {
  ArchitectureDocument,
  ArrivalPattern,
  ClientMode,
  SimulationLimits,
} from '../domain/types';
import type { QuantileEstimate } from './metrics';
import type { ValidationIssue } from './routing';

export const ENGINE_VERSION = '1.0.0';

export interface SimulationInput {
  document: ArchitectureDocument;
  limits: SimulationLimits;
  /** Keep arrivals alive; the caller advances simulated time in bounded slices. */
  continuous?: boolean;
}

export type RunStatus = 'running' | 'completed' | 'incomplete' | 'cancelled' | 'invalid';

export type RejectionReason =
  | 'balancer-queue-full'
  | 'server-queue-full'
  | 'server-memory-full'
  | 'database-queue-full'
  | 'cache-queue-full'
  | 'queue-publish-full'
  | 'queue-full'
  | 'dns-queue-full'
  | 'cdn-queue-full'
  | 'waf-queue-full'
  | 'gateway-queue-full'
  | 'waf-blocked'
  | 'gateway-throttled'
  | 'replica-queue-full'
  | 'kv-queue-full'
  | 'storage-queue-full'
  | 'pubsub-publish-full'
  | 'function-throttled'
  | 'data-service-full' | 'stream-publish-full' | 'worker-failed' | 'support-queue-full' | 'identity-denied' | 'dependency-unavailable' | 'secret-expired' | 'rate-limited' | 'connection-limit' | 'circuit-open' | 'mesh-unavailable' | 'lock-timeout' | 'wallet-rejected' | 'rpc-rate-limited' | 'mempool-full';

export const REJECTION_LABELS: Record<RejectionReason, string> = {
  'support-queue-full': 'Shared service waiting queue is full',
  'identity-denied': 'Identity check refused this user',
  'dependency-unavailable': 'Required shared service unavailable',
  'secret-expired': 'Cached credential is too old after rotation',
  'rate-limited': 'Standalone rate limiter refused this request',
  'connection-limit': 'WebSocket connection or memory limit reached',
  'circuit-open': 'Mesh proxy circuit is open',
  'mesh-unavailable': 'Mesh connection retries exhausted',
  'lock-timeout': 'Gave up waiting for a lock',
  'wallet-rejected': 'The person refused or abandoned the signature',
  'rpc-rate-limited': 'The RPC node refused it: over the plan limit',
  'mempool-full': 'The chain’s pending pool was full',
  'stream-publish-full': 'Event stream publish queue was full',
  'worker-failed': 'The worker failed this attempt',
  'data-service-full': 'Data service waiting queue was full',
  'balancer-queue-full': 'Load balancer waiting queue was full',
  'server-queue-full': 'Server waiting queue was full',
  'server-memory-full': 'Server ran out of memory budget',
  'database-queue-full': 'Database waiting queue was full',
  'cache-queue-full': 'Cache waiting queue was full',
  'queue-publish-full': 'Message queue broker was busy and its waiting line was full',
  'queue-full': 'Message queue was full, so the message could not be published',
  'dns-queue-full': 'DNS resolver waiting queue was full',
  'cdn-queue-full': 'CDN waiting queue was full',
  'waf-queue-full': 'WAF waiting queue was full',
  'gateway-queue-full': 'API gateway waiting queue was full',
  'waf-blocked': 'Blocked by the WAF as malicious',
  'gateway-throttled': 'Refused by the API gateway rate limit',
  'replica-queue-full': 'Read replica waiting queue was full',
  'kv-queue-full': 'Key-value store waiting queue was full',
  'storage-queue-full': 'Object storage waiting queue was full',
  'pubsub-publish-full': 'Pub/sub broker was busy and its waiting line was full',
  'function-throttled': 'Serverless function was at its concurrency limit',
};

/**
 * What one group of users saw. Separate from the totals because a design can
 * have several clients, and a component should only ever show its own numbers.
 */
export interface ClientMetrics {
  nodeId: string;
  name: string;
  /** Whether these users wait for their answers before sending again. */
  mode: ClientMode;
  /**
   * The rate this client was configured for. In closed mode there is no such
   * setting, so this is the rate its users would *settle* at if every answer
   * were instant: population divided by think time. It is a steady-state
   * figure rather than a hard cap — at the start of a run nobody has thought
   * yet, so a run only a few think times long offers more than this.
   */
  offeredRatePerSecond: number;
  /** What was actually offered, measured across the arrival window. */
  achievedRatePerSecond: number;
  offered: number;
  completed: number;
  rejected: number;
  unfinished: number;
  meanResponseMs: number;
}

export interface ServerMetrics {
  nodeId: string;
  name: string;
  /** Absent from records written before serverless functions existed. */
  kind?: 'server' | 'serverless' | 'rpcNode';
  admitted: number;
  completed: number;
  rejected: number;
  /** Fraction of total CPU slot-time that was busy, time-weighted. */
  cpuUtilisation: number;
  cpuSlots: number;
  busySlotsAverage: number;
  concurrencyAverage: number;
  concurrencyPeak: number;
  concurrencyLimit: number;
  admissionQueueAverage: number;
  admissionQueuePeak: number;
  cpuQueueAverage: number;
  cpuQueuePeak: number;
  peakMemoryMb: number;
  memoryLimitMb: number;
  cpuServiceMsTotal: number;
  admissionWaitMsTotal: number;
  cpuWaitMsTotal: number;
  /** Serverless only. */
  coldStarts?: number;
  throttled?: number;
  /** Serverless only: wall-clock milliseconds invocations were alive, summed. */
  busyMsTotal?: number;
  /** Auto-scaled servers only: billed instances, on average and at most. */
  instancesAverage?: number;
  instancesPeak?: number;
  /** Instances serving when the run ended. */
  instancesNow?: number;
  scaleOuts?: number;
  scaleIns?: number;
}

export interface DataServiceMetrics {
  nodeId: string; name: string; kind: DataKind;
  reads: number; writes: number; completed: number; rejected: number;
  inFlight: number; waiting: number; utilisation: number; queuePeak: number;
  serviceMsTotal: number; waitMsTotal: number;
  details: Record<string, number>;
}

export interface StationMetrics {
  nodeId: string;
  name: string;
  kind:
    | 'database'
    | 'cache'
    | 'loadBalancer'
    | 'queue'
    | 'dns'
    | 'cdn'
    | 'waf'
    | 'apiGateway'
    | 'readReplica'
    | 'kvStore'
    | 'objectStorage'
    | 'pubsub' | 'eventStream' | 'workflow';
  operations: number;
  rejected: number;
  /** Fraction of total slot-time that was busy, time-weighted. */
  utilisation: number;
  slots: number;
  queueAverage: number;
  queuePeak: number;
  serviceMsTotal: number;
  waitMsTotal: number;
  /** Cache and CDN only. */
  hits?: number;
  misses?: number;
  populates?: number;
  achievedHitRate?: number;
  /** WAF only: requests refused as malicious. */
  blocked?: number;
  /** API gateway only: requests refused by the rate limit. */
  throttled?: number;
  /** Key-value store and object storage: operations by kind. */
  reads?: number;
  writes?: number;
  /** Read replica only: writes applied from the primary. */
  applied?: number;
  /** Pub/sub only: copies dropped because a subscription was full. */
  dropped?: number;
}

/**
 * What a message queue did, and — the reason to draw one — what it did not get
 * round to.
 */
export interface QueueMetrics {
  kind?: 'queue' | 'pubsub' | 'eventStream' | 'deadLetter' | 'workflow';
  retries?: number;
  retrying?: number;
  expired?: number;
  /** Jobs refused by their worker or its dependencies, distinct from publish failures. */
  failed?: number;
  /** The queue or topic. A topic has one entry per subscriber. */
  nodeId: string;
  name: string;
  consumerId: string | null;
  consumerName: string | null;
  /** Messages accepted into the backlog. */
  enqueued: number;
  /** Messages the consumer finished. */
  processed: number;
  /** Publishes refused because the backlog was full. */
  refused: number;
  /** Still waiting or being worked on when the run ended. */
  outstanding: number;
  maxDepth: number;
  depthAverage: number;
  depthPeak: number;
  /** Total time messages spent waiting for a consumer to pick them up. */
  backlogWaitMsTotal: number;
  /** Mean time from being published to being finished, for messages that were. */
  meanLatencyMs: number;
}

export interface LinkMetrics {
  channelKey: string;
  edgeId: string;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  messages: number;
  bytes: number;
  utilisation: number;
  queueAverage: number;
  queuePeak: number;
  transmissionMsTotal: number;
  waitMsTotal: number;
  bandwidthMbps: number;
  propagationDelayMs: number;
}

export interface JourneyStep {
  atMs: number;
  label: string;
  detail?: string;
}

export interface RequestJourney {
  requestId: number;
  clientName: string;
  startMs: number;
  endMs: number | null;
  outcome: 'completed' | 'rejected' | 'unfinished';
  totalMs: number | null;
  waitMs: number;
  steps: JourneyStep[];
}

export type WaitStage =
  | 'balancer'
  | 'serverAdmission'
  | 'serverCpu'
  | 'database'
  | 'cache'
  | 'queue'
  | 'edge'
  | 'dns'
  | 'replica'
  | 'kv'
  | 'storage'
  | 'pubsub'
  | 'network';

export const WAIT_STAGE_LABELS: Record<WaitStage, string> = {
  balancer: 'waiting at the load balancer',
  serverAdmission: 'waiting to be admitted by a server',
  serverCpu: 'waiting for a free CPU slot',
  database: 'waiting for a database slot',
  cache: 'waiting for a cache slot',
  queue: 'waiting for the queue broker to accept a message',
  edge: 'waiting at the CDN, WAF or API gateway',
  dns: 'waiting for the DNS resolver',
  replica: 'waiting for a read replica slot',
  kv: 'waiting for a key-value store slot',
  storage: 'waiting for an object storage slot',
  pubsub: 'waiting for the topic to accept a message',
  network: 'waiting for a busy network link',
};

/** What the pricing engine needs from a run. Kept deliberately small. */
export interface UsageLedger {
  scannedGbByNodeId?: Record<string, number>;
  /**
   * Bytes a store took in through writes, as the link carried them. A
   * time-series write carries every point in it, so this is what an ingest
   * bill counts. Absent from runs saved before it was measured.
   */
  ingestedBytesByNodeId?: Record<string, number>;
  /**
   * Auto-scaled servers: billed instances, averaged over the measured
   * interval — serving and warming up. Absent from runs saved before it.
   */
  instancesByNodeId?: Record<string, number>;
  /** Gas used by a contract's own transactions, and by each oracle's updates. */
  gasByNodeId?: Record<string, number>;
  /**
   * The same gas, each transaction weighted by the base fee of the block that
   * took it as a multiple of the starting fee. What gas costs follows this.
   */
  feeWeightedGasByNodeId?: Record<string, number>;
  measuredSeconds: number;
  /** Bytes sent from a server towards a client. Used for outbound transfer pricing. */
  egressBytes: number;
  totalBytes: number;
  completedRequests: number;
  /** Outbound bytes towards clients, attributed to the component that sent them. */
  egressByNodeId: Record<string, number>;
  /** Metered operations, attributed to the component that handled them. */
  requestsByNodeId: Record<string, number>;
  /** Of those, the writes — for stores that bill reads and writes apart. */
  writesByNodeId: Record<string, number>;
  /**
   * Wall-clock milliseconds invocations were alive, per serverless function —
   * what a provider bills, waiting on a database included.
   */
  busyMsByNodeId: Record<string, number>;
}

export interface Finding {
  id: string;
  severity: 'info' | 'warning';
  title: string;
  detail: string;
}

export interface JobServiceMetrics {
  nodeId: string; name: string; kind: 'eventStream' | 'scheduler' | 'deadLetter' | 'workflow';
  accepted: number; completed: number; failed: number; waiting: number;
  details: Record<string, number>;
}
export interface SimulationResult {
  supportServices?: SupportMetrics[];
  /** Wallet, smart contract, indexer, storage and oracles. The RPC node reports with the servers. */
  chainServices?: SupportMetrics[];
  jobServices?: JobServiceMetrics[];
  engineVersion: string;
  seed: number;
  status: RunStatus;
  statusReason?: string;

  simulatedMs: number;
  arrivalWindowMs: number;
  drainMs: number;
  eventsProcessed: number;

  offered: number;
  completed: number;
  rejected: number;
  unfinished: number;
  rejectionsByReason: Partial<Record<RejectionReason, number>>;

  offeredRatePerSecond: number;
  /** How the traffic was spread across the run. Part of the evidence. */
  arrivalPattern: ArrivalPattern;
  throughputPerSecond: number;
  throughputWindowMs: number;

  responseTime: {
    meanMs: number;
    minMs: number;
    maxMs: number;
    p95: QuantileEstimate;
  };
  /** Response time split into "doing something" versus "standing in a queue". */
  meanServiceMs: number;
  meanWaitMs: number;
  waitByStageMs: Record<WaitStage, number>;

  clients: ClientMetrics[];
  servers: ServerMetrics[];
  stations: StationMetrics[];
  dataServices?: DataServiceMetrics[];
  queues: QueueMetrics[];
  links: LinkMetrics[];

  /** Messages published to queues across the run. */
  messagesPublished: number;
  /** Messages consumers finished across the run. */
  messagesProcessed: number;
  databaseQueries: number;
  cacheHits: number;
  cacheMisses: number;
  cachePopulates: number;
  bytesTransferred: number;
  bytesEgressToClients: number;

  journeys: RequestJourney[];
  usage: UsageLedger;
  assumptions: string[];
  findings: Finding[];
  issues: ValidationIssue[];
}

export interface ProgressUpdate {
  fraction: number;
  simulatedMs: number;
  eventsProcessed: number;
  completed: number;
}
