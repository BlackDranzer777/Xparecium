/**
 * A service station with a fixed number of parallel slots and a bounded
 * waiting line. Both the Database and the Cache are instances of this.
 *
 * What this models: "N things can be in progress at once, each takes about T
 * milliseconds, and anything beyond that waits in a line of bounded length."
 * A Load Balancer is the same shape: it holds a request for a moment, then
 * forwards it. It never computes anything. So is the broker side of a Message
 * Queue: it accepts a message, acknowledges it, and the work happens later —
 * the backlog it accepts messages into is a separate thing entirely, in
 * `queue.ts`.
 *
 * What this does NOT model: SQL planning, indexes, transactions, replication,
 * cache keys, eviction or expiry. Those are listed as deferred work. The
 * service time is a single average that the user sets.
 */
import type { EventStreamNode } from '../../domain/job-services';
import { TimeWeightedAccumulator } from '../metrics';
import { RingQueue } from '../ring-queue';
import type {
  ApiGatewayNode,
  CacheNode,
  CdnNode,
  DatabaseNode,
  DnsNode,
  KvStoreNode,
  LoadBalancerNode,
  ObjectStorageNode,
  PubSubNode,
  QueueNode,
  ReadReplicaNode,
  WafNode,
} from '../../domain/types';

/** Every node kind that is modelled as a service station. */
export type StationNode =
  | DatabaseNode
  | CacheNode
  | LoadBalancerNode
  | QueueNode
  | DnsNode
  | CdnNode
  | WafNode
  | ApiGatewayNode
  | ReadReplicaNode
  | KvStoreNode
  | ObjectStorageNode
  | PubSubNode | EventStreamNode;

export type StationOp =
  | 'dbQuery'
  | 'cacheLookup'
  | 'cachePopulate'
  | 'lbForward'
  | 'queuePublish'
  | 'edgeForward'
  | 'dnsLookup'
  | 'replicaQuery'
  /** A write reaching a replica from its primary. Nobody waits for it. */
  | 'replicaApply'
  | 'kvRead'
  | 'kvWrite'
  | 'storageGet'
  | 'storagePut'
  | 'topicPublish' | 'streamPublish';

export interface StationJob {
  requestId: number;
  op: StationOp;
  queuedAt: number;
}

export class StationModel {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: StationNode['kind'];
  readonly slots: number;
  readonly queueLimit: number;

  busy = 0;
  readonly queue = new RingQueue<StationJob>();
  readonly busyAcc = new TimeWeightedAccumulator(0);
  readonly queueAcc = new TimeWeightedAccumulator(0);

  operations = 0;
  rejected = 0;
  serviceMsTotal = 0;
  waitMsTotal = 0;

  // Cache-only counters. Left at zero for a database. A CDN uses hits and
  // misses too; it is a cache, just at the other end of the path.
  hits = 0;
  misses = 0;
  populates = 0;
  // Edge-only counters: what a WAF refused, what a gateway throttled.
  blocked = 0;
  throttled = 0;
  // Stores that bill reads and writes apart count them apart.
  reads = 0;
  writes = 0;
  // Replica-only: writes applied from the primary. Topic-only: copies dropped
  // because a subscription was full.
  applied = 0;
  dropped = 0;
  /** Replica-only: time to apply one write from the primary. */
  readonly applyMs: number;

  constructor(node: StationNode) {
    this.nodeId = node.id;
    this.name = node.name;
    this.kind = node.kind;
    this.queueLimit =
      node.kind === 'queue' || node.kind === 'pubsub' || node.kind === 'eventStream'
        ? node.settings.publishQueueLimit
        : node.settings.queueLimit;
    if (node.kind === 'database' || node.kind === 'readReplica') {
      this.slots = node.settings.maxConcurrentQueries;
    } else if (node.kind === 'cache') {
      this.slots = node.settings.maxConcurrentLookups;
    } else if (node.kind === 'queue' || node.kind === 'pubsub' || node.kind === 'eventStream') {
      this.slots = node.settings.maxConcurrentPublishes;
    } else if (node.kind === 'dns') {
      this.slots = node.settings.maxConcurrentLookups;
    } else {
      this.slots = node.settings.maxConcurrentRequests;
    }
    this.applyMs = node.kind === 'readReplica' ? node.settings.applyServiceTimeMs : 0;
  }

  get hasFreeSlot(): boolean {
    return this.busy < this.slots;
  }

  get hasQueueRoom(): boolean {
    return this.queue.length < this.queueLimit;
  }

  occupy(now: number, serviceMs: number): void {
    this.busy += 1;
    this.busyAcc.set(now, this.busy);
    this.operations += 1;
    this.serviceMsTotal += serviceMs;
  }

  enqueue(job: StationJob, now: number): void {
    this.queue.push(job);
    this.queueAcc.set(now, this.queue.length);
  }

  release(now: number): void {
    this.busy -= 1;
    this.busyAcc.set(now, this.busy);
  }

  /** Take the next waiting job, recording how long it waited. */
  dequeue(now: number): StationJob | undefined {
    const job = this.queue.shift();
    if (!job) return undefined;
    this.queueAcc.set(now, this.queue.length);
    this.waitMsTotal += now - job.queuedAt;
    return job;
  }
}
