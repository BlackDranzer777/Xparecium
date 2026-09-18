import { SupportServiceModel } from './models/support-service';
import { isSupportKind } from '../domain/support-services';
import type { SupportNode } from '../domain/support-services';
import type { EventStreamNode, EventStreamSettings, DeadLetterNode, SchedulerNode, SchedulerSettings } from '../domain/job-services';
import { RetainedLog } from './models/retained-log';
import { StreamBacklog } from './models/stream-backlog';
import { DeadLetterModel } from './models/dead-letter';
import { isDataKind } from '../domain/data-services';
import type { DataServiceNode } from '../domain/data-services';
import { DataServiceModel } from './models/data-service';
import type { DataOperation } from './models/data-service';
/**
 * The Aparecium simulation engine.
 *
 * Pure TypeScript: no React, no DOM, no IndexedDB, no worker APIs. The worker
 * wraps this; the tests call it directly.
 *
 * Approach: discrete-event simulation with average service costs plus simple
 * resource contention and queues. Simulated time advances by jumping to the
 * timestamp of the next scheduled event, never by using a real timer.
 *
 * What this is not: an operating system scheduler, a query planner, a network
 * stack. Every service cost is an average the user configured.
 */
import type {
  ApiGatewayNode,
  ApiGatewaySettings,
  ArchitectureDocument,
  CacheNode,
  CdnNode,
  CdnSettings,
  DnsNode,
  DnsSettings,
  WafNode,
  WafSettings,
  CacheSettings,
  ClientMode,
  ClientNode,
  DatabaseNode,
  DatabaseSettings,
  LoadBalancerNode,
  LoadBalancerSettings,
  KvStoreNode,
  KvStoreSettings,
  ObjectStorageNode,
  ObjectStorageSettings,
  PubSubNode,
  PubSubSettings,
  QueueNode,
  QueueSettings,
  ReadReplicaNode,
  ReadReplicaSettings,
  ServerNode,
  ServerlessNode,
  Workload,
} from '../domain/types';
import { DEFAULT_LIMITS } from '../domain/types';
import { EventQueue } from './event-queue';
import { BoundedHistogram, StreamingStat } from './metrics';
import { LinkChannel } from './models/link';
import type { LinkMessage, MessageKind } from './models/link';
import { ServerModel } from './models/server';
import { QueueModel } from './models/queue';
import type { PendingMessage } from './models/queue';
import { StationModel } from './models/station';
import type { StationNode, StationOp } from './models/station';
import { RandomStreams } from './rng';
import type { Rng } from './rng';
import { validateAndResolve } from './routing';
import type { RoutingResult, ServerBranch } from './routing';
import {
  ENGINE_VERSION,
  REJECTION_LABELS,
  WAIT_STAGE_LABELS,
} from './types';
import type {
  ClientMetrics,
  Finding,
  JourneyStep,
  LinkMetrics,
  ProgressUpdate,
  QueueMetrics,
  RejectionReason,
  RequestJourney,
  ServerMetrics,
  SimulationInput,
  SimulationResult,
  StationMetrics,
  WaitStage,
} from './types';

// --------------------------------------------------------------------------
// Internal state
// --------------------------------------------------------------------------

type EventPayload =
  | { t: 'supportEnd'; nodeId: string; id: number }
  | { t: 'heartbeat'; nodeId: string }
  | { t: 'scheduledTick'; route: number }
  | { t: 'streamStart'; key: string }
  | { t: 'jobMaintenance'; nodeId: string }
  | { t: 'retry'; key: string; message: PendingMessage }
  | { t: 'replay'; key: string }
  | { t: 'dataEnd'; nodeId: string; request: number }
  | { t: 'arrival'; route: number; user: number }
  | { t: 'txEnd'; channel: string }
  | { t: 'deliver'; channel: string; msg: LinkMessage }
  | { t: 'cpuEnd'; server: string; request: number }
  | { t: 'serviceEnd'; station: string; request: number; op: StationOp };

/** One application server on a route, with whatever it calls behind it. */
interface CompiledBranch {
  supportCalls: SupportCall[]; asyncCalls: SupportCall[];
  streamId: string | null; streamOutChannel: string | null; streamInChannel: string | null; streamSettings: EventStreamSettings | null;
  dataServices: { nodeId: string; outChannel: string; inChannel: string }[];
  serverId: string;
  cacheId: string | null;
  databaseId: string | null;
  /** Forward: from the client or the balancer into this server. */
  serverInChannel: string;
  /** Reverse: from this server back to the client or the balancer. */
  serverOutChannel: string;
  cacheOutChannel: string | null;
  cacheInChannel: string | null;
  dbOutChannel: string | null;
  dbInChannel: string | null;
  cacheSettings: CacheSettings | null;
  databaseSettings: DatabaseSettings | null;
  hitStream: Rng | null;
  /** The queue this server publishes to, if any. */
  queueId: string | null;
  queueOutChannel: string | null;
  queueInChannel: string | null;
  queueSettings: QueueSettings | null;
  /** The topic this server publishes to, if any. */
  pubsubId: string | null;
  pubsubOutChannel: string | null;
  pubsubInChannel: string | null;
  pubsubSettings: PubSubSettings | null;
  /** Draws whether a database query is a write, from the database's read share. */
  writeStream: Rng | null;
  /** Read replicas of this branch's database, read round-robin. */
  replicas: CompiledReplica[];
  nextReplica: number;
  /** Primary -> replica channels, one per replica of the database, for the writes to copy. */
  replicationChannels: string[];
  kvId: string | null;
  kvOutChannel: string | null;
  kvInChannel: string | null;
  kvSettings: KvStoreSettings | null;
  kvStream: Rng | null;
  storageId: string | null;
  storageOutChannel: string | null;
  storageInChannel: string | null;
  storageSettings: ObjectStorageSettings | null;
  storageStream: Rng | null;
  /** Serverless only: draws whether an invocation pays a cold start. */
  coldStream: Rng | null;
  coldStartMs: number;
  coldStartShare: number;
}

interface CompiledReplica {
  nodeId: string;
  outChannel: string;
  inChannel: string;
  settings: ReadReplicaSettings;
}

/** Settings of the queue a branch publishes to, or null when it publishes to none. */
function queueSettingsOf(routing: RoutingResult, queueId: string | null): QueueSettings | null {
  if (!queueId) return null;
  const node = routing.graph.nodesById.get(queueId);
  return node && node.kind === 'queue' ? node.settings : null;
}

/** A small control message: a lookup key, an acknowledgement. */
const CONTROL_BYTES = 256;

/** One edge component on a route, with the channels on either side of it. */
interface SupportCall { nodeId: string; outChannel: string; inChannel: string }
interface CompiledHop {
  identity: SupportCall | null; support: SupportNode | null;
  nodeId: string;
  kind: 'cdn' | 'waf' | 'apiGateway' | 'websocket' | 'rateLimiter' | 'serviceMesh';
  name: string;
  /** Forward: into this hop. */
  inChannel: string;
  /** Forward: out of this hop, to the next hop or the entry point. */
  outChannel: string;
  /** Reverse: back towards the users, from this hop. */
  backChannel: string;
  cdn: CdnSettings | null;
  waf: WafSettings | null;
  gateway: ApiGatewaySettings | null;
  /** Its own stream, so a CDN's hits never shift a WAF's blocks. */
  stream: Rng;
}

/** DNS beside a route: consulted by a share of requests before they set off. */
interface CompiledDns {
  nodeId: string;
  settings: DnsSettings;
  outChannel: string;
  inChannel: string;
  stream: Rng;
}

interface CompiledRoute {
  index: number;
  /** Edge components between the users and the entry point, in path order. */
  hops: CompiledHop[];
  dns: CompiledDns | null;
  /**
   * Where a response goes next on its way back to the users, keyed by the
   * reverse channel it arrived on. Arriving on `clientInChannel` means done.
   * Built once, so the balancer and every hop relay by the same rule.
   */
  relayBack: Map<string, string>;
  /**
   * Whose work this route carries.
   *
   * A `consumer` route is a queue's worker: the same pipeline — admission, CPU
   * segments, cache, database — reached from the queue instead of from a
   * client, and finished instead of answered. Modelling it as a route rather
   * than as a second kind of entity is what lets a worker have a cache and a
   * database of its own without a line of new code.
   */
  kind: 'client' | 'consumer' | 'scheduler';
  scheduler: SchedulerSettings | null; ticks: number; skipped: number;
  /** Consumer routes only: the queue or topic this drains. */
  queueId: string | null;
  /** Consumer routes only: which backlog — the queue's, or this subscriber's. */
  backlogKey: string | null;
  clientId: string;
  clientName: string;
  /** Null when the users talk to one server directly. */
  loadBalancerId: string | null;
  loadBalancerSettings: LoadBalancerSettings | null;
  /** Forward: client into the entry point (balancer, or the single server). */
  clientOutChannel: string;
  /** Reverse: entry point back to the client. Arriving here means "done". */
  clientInChannel: string;
  branches: CompiledBranch[];
  /** Round-robin cursor. Deterministic, so runs stay reproducible. */
  nextBranch: number;
  requestBytes: number;
  responseBytes: number;
  ratePerSecond: number;
  intervalMs: number;
  /** Exponential draws for a Poisson arrival pattern. Its own stream, always. */
  arrivalStream: Rng;
  /** Waiting-then-thinking users. Empty unless the client is in closed mode. */
  clientMode: ClientMode;
  thinkTimeMs: number;
  thinkStream: Rng;
  /** Closed mode: how many users this client stands for. */
  population: number;
  /** How many requests we expect to offer, used to spread journey samples. */
  expectedRequests: number;
  /** Per-client tallies, so each component can show only its own numbers. */
  offered: number;
  completed: number;
  rejected: number;
  responseStat: StreamingStat;
}

interface RequestState {
  actor: string; supportIndex: number; pendingSupport: { call: SupportCall; next: 'branch' | 'gateway' | 'inline'; hopId?: string } | null;
  streamPublished: boolean; jobExecutionChecked: boolean;
  dataIndex: number;
  dataOperation: DataOperation | null;
  id: number;
  routeIndex: number;
  /** Which server on the route is handling this. -1 until a balancer picks. */
  branchIndex: number;
  createdAt: number;
  cacheHit: boolean;
  cacheChecked: boolean;
  dbDone: boolean;
  /** Whether the database query is a write: primary only, and copied to replicas. */
  dbWrite: boolean;
  populateDone: boolean;
  kvDone: boolean;
  kvWrite: boolean;
  storageDone: boolean;
  storageWrite: boolean;
  topicPublished: boolean;
  /** Serverless: the cold start this invocation pays, once, on its first segment. */
  coldStartMs: number;
  admittedAt: number;
  cpuMsPerSegment: number;
  waitMs: number;
  admitted: boolean;
  /** Closed mode: which user is waiting for this. -1 in open mode. */
  userIndex: number;
  /** Whether this request has already handed its message to the queue. */
  queuePublished: boolean;
  /** A job's own message: when it was published, so its age can be measured. */
  message: PendingMessage | null;
  journey: JourneyStep[] | null;
}

const FORWARD = 'fwd';
const REVERSE = 'rev';

function channelKey(edgeId: string, direction: typeof FORWARD | typeof REVERSE): string {
  return `${edgeId}|${direction}`;
}

export interface StepOutcome {
  done: boolean;
  processed: number;
  progress: ProgressUpdate;
}

export class SimulationEngine {
  readonly input: SimulationInput;
  private readonly routing: RoutingResult;

  private readonly queue = new EventQueue<EventPayload>();
  private readonly servers = new Map<string, ServerModel>();
  private readonly stations = new Map<string, StationModel>();
  private readonly dataServices = new Map<string, DataServiceModel>();
  /** The backlog of each message queue, separate from its broker station. */
  private readonly backlogs = new Map<string, QueueModel | StreamBacklog>();
  private readonly support = new Map<string, SupportServiceModel>();
  private nextDetachedId = -1;
  private readonly logs = new Map<string, RetainedLog>();
  private readonly maintenanceAt = new Map<string, number>();
  /** Which route drains each queue, so a freed worker knows where to look. */
  private readonly consumerRouteByQueue = new Map<string, number>();
  /** Which hop a request has reached, by the forward channel it arrives on. */
  private readonly hopByInChannel = new Map<string, { route: number; hop: CompiledHop }>();
  /**
   * One token bucket per API gateway. Tokens refill at the configured rate
   * and are capped at the burst capacity; a request with no token to take is
   * refused, not queued — which is what a rate limit is for.
   */
  private readonly buckets = new Map<string, { tokens: number; refilledAt: number }>();
  private readonly channels = new Map<string, LinkChannel>();
  private readonly requests = new Map<number, RequestState>();
  private readonly routes: CompiledRoute[] = [];
  private readonly streams: RandomStreams;

  private now = 0;
  private nextRequestId = 1;
  private messagesPublished = 0;
  private messagesProcessed = 0;
  private eventsProcessed = 0;
  private finished = false;
  private status: SimulationResult['status'] = 'completed';
  private statusReason: string | undefined;

  private readonly arrivalWindowMs: number;
  private readonly drainMs: number;
  private readonly endTimeMs: number;

  private offered = 0;
  private completed = 0;
  private rejected = 0;
  private readonly rejectionsByReason: Partial<Record<RejectionReason, number>> = {};

  private databaseQueries = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private cachePopulates = 0;

  private readonly responseStat = new StreamingStat();
  private readonly waitStat = new StreamingStat();
  private readonly serviceStat = new StreamingStat();
  private readonly histogram = new BoundedHistogram(0.1, 1.15, 120);

  private readonly journeys: RequestJourney[] = [];
  private tracedCount = 0;
  private traceEvery = 1;

  constructor(input: SimulationInput) {
    this.input = input;
    const doc = input.document;
    this.streams = new RandomStreams(doc.workload.seed);
    this.arrivalWindowMs = doc.workload.durationSeconds * 1000;
    this.drainMs = doc.workload.drainSeconds * 1000;
    this.endTimeMs = this.arrivalWindowMs + this.drainMs;
    this.routing = validateAndResolve(doc);

    if (this.routing.hasErrors) {
      this.finished = true;
      this.status = 'invalid';
      this.statusReason =
        'The architecture could not be simulated. Fix the problems listed below and run again.';
      return;
    }

    this.buildModels(doc);
    this.compileRoutes();
    this.scheduleInitialArrivals();
  }

  // ------------------------------------------------------------------ setup

  private buildModels(doc: ArchitectureDocument): void {
    for (const node of doc.nodes) {
      if (isSupportKind(node.kind)) this.support.set(node.id, new SupportServiceModel(node as SupportNode, this.streams));
      if (isDataKind(node.kind)) this.dataServices.set(node.id, new DataServiceModel(node as DataServiceNode, this.streams));
      if (node.kind === 'deadLetter') this.backlogs.set(node.id, new DeadLetterModel(node));
      if (node.kind === 'eventStream') this.logs.set(node.id, new RetainedLog(node.settings.partitions, node.settings.maxDepth, node.settings.retentionSeconds * 1000));
      if (node.kind === 'server' || node.kind === 'serverless') {
        this.servers.set(node.id, new ServerModel(node as ServerNode | ServerlessNode));
      } else if (
        node.kind === 'database' ||
        node.kind === 'cache' ||
        node.kind === 'loadBalancer' ||
        node.kind === 'queue' ||
        node.kind === 'dns' ||
        node.kind === 'cdn' ||
        node.kind === 'waf' ||
        node.kind === 'apiGateway' ||
        node.kind === 'readReplica' ||
        node.kind === 'kvStore' ||
        node.kind === 'objectStorage' ||
        node.kind === 'pubsub' || node.kind === 'eventStream'
      ) {
        this.stations.set(node.id, new StationModel(node as StationNode));
        // A queue is two things: a broker that accepts publishes (the station
        // above) and a pile of messages waiting for a consumer (this).
        if (node.kind === 'queue') this.backlogs.set(node.id, new QueueModel(node as QueueNode));
      }
    }
    // A topic keeps one backlog per subscriber, so each listener's copy waits
    // on its own; created here from the consumers the resolver found.
    for (const consumer of this.routing.consumers) {
      if (this.backlogs.has(consumer.backlogKey)) continue;
      const source = this.routing.graph.nodesById.get(consumer.queueId);
      if (source?.kind === 'eventStream') this.backlogs.set(consumer.backlogKey, new StreamBacklog(source, consumer.backlogKey, this.logs.get(source.id)!));
      if (source && source.kind === 'pubsub') {
        this.backlogs.set(consumer.backlogKey, new QueueModel(source as PubSubNode, consumer.backlogKey));
      }
    }
    for (const edge of doc.edges) {
      if (!this.routing.graph.nodesById.has(edge.source)) continue;
      if (!this.routing.graph.nodesById.has(edge.target)) continue;
      this.channels.set(
        channelKey(edge.id, FORWARD),
        new LinkChannel({
          key: channelKey(edge.id, FORWARD),
          edgeId: edge.id,
          fromId: edge.source,
          toId: edge.target,
          bandwidthMbps: edge.settings.bandwidthMbps,
          propagationDelayMs: edge.settings.propagationDelayMs,
        }),
      );
      this.channels.set(
        channelKey(edge.id, REVERSE),
        new LinkChannel({
          key: channelKey(edge.id, REVERSE),
          edgeId: edge.id,
          fromId: edge.target,
          toId: edge.source,
          bandwidthMbps: edge.settings.bandwidthMbps,
          propagationDelayMs: edge.settings.propagationDelayMs,
        }),
      );
    }
  }

  private compileRoutes(): void {
    let expectedTotal = 0;
    this.routing.routes.forEach((route, index) => {
      const source = this.routing.graph.nodesById.get(route.clientId) as ClientNode | SchedulerNode;
      const scheduler = source.kind === 'scheduler' ? source.settings : null;
      const client: ClientNode = source.kind === 'client' ? source : { ...source, kind: 'client', settings: {
        activeUsers: 0, actionsPerUserPerMinute: 0, requestRateOverridePerSecond: scheduler!.batchSize / scheduler!.intervalSeconds,
        requestBytes: scheduler!.requestBytes, responseBytes: scheduler!.responseBytes, mode: 'open', thinkTimeMs: 0,
      } };
      const balancer = route.loadBalancerId
        ? (this.routing.graph.nodesById.get(route.loadBalancerId) as LoadBalancerNode)
        : null;

      const rate = clientRequestRate(client);
      const intervalMs = rate > 0 ? 1000 / rate : Number.POSITIVE_INFINITY;
      const expectedRequests =
        rate > 0
          ? Math.ceil(
              (this.arrivalWindowMs / intervalMs) *
                meanArrivalMultiplier(this.input.document.workload),
            )
          : 0;
      expectedTotal += expectedRequests;

      const branches: CompiledBranch[] = route.branches.map((branch) => this.compileBranch(branch));

      // The edge chain, and the map that walks a response back through it.
      const pathEdges = [...route.edgeChain.map((h) => h.inboundEdgeId), route.entryEdgeId];
      const hops: CompiledHop[] = route.edgeChain.map((hop, i) => {
        const node = this.routing.graph.nodesById.get(hop.nodeId) as CdnNode | WafNode | ApiGatewayNode | SupportNode;
        return {
          nodeId: hop.nodeId,
          support: isSupportKind(node.kind) ? node as SupportNode : null,
          identity: node.kind === 'apiGateway' ? (() => {
            const e = (this.routing.graph.outgoing.get(node.id) ?? []).find(e => this.routing.graph.nodesById.get(e.target)?.kind === 'identity');
            return e ? { nodeId: e.target, outChannel: channelKey(e.id, FORWARD), inChannel: channelKey(e.id, REVERSE) } : null;
          })() : null,
          kind: hop.kind,
          name: node.name,
          inChannel: channelKey(hop.inboundEdgeId, FORWARD),
          outChannel: channelKey(pathEdges[i + 1]!, FORWARD),
          backChannel: channelKey(hop.inboundEdgeId, REVERSE),
          cdn: node.kind === 'cdn' ? node.settings : null,
          waf: node.kind === 'waf' ? node.settings : null,
          gateway: node.kind === 'apiGateway' ? node.settings : null,
          stream: this.streams.stream(`edge:${hop.nodeId}`),
        };
      });
      const relayBack = new Map<string, string>();
      for (let i = pathEdges.length - 1; i >= 1; i -= 1) {
        relayBack.set(channelKey(pathEdges[i]!, REVERSE), channelKey(pathEdges[i - 1]!, REVERSE));
      }
      for (const branch of route.branches) {
        if (route.loadBalancerId) {
          relayBack.set(
            channelKey(branch.inboundEdgeId, REVERSE),
            channelKey(route.entryEdgeId, REVERSE),
          );
        }
      }
      for (const hop of hops) this.hopByInChannel.set(hop.inChannel, { route: index, hop });

      const dnsNode = route.dnsId
        ? (this.routing.graph.nodesById.get(route.dnsId) as DnsNode | undefined)
        : undefined;
      const dns: CompiledDns | null =
        dnsNode && route.dnsEdgeId
          ? {
              nodeId: dnsNode.id,
              settings: dnsNode.settings,
              outChannel: channelKey(route.dnsEdgeId, FORWARD),
              inChannel: channelKey(route.dnsEdgeId, REVERSE),
              stream: this.streams.stream(`dns:${dnsNode.id}`),
            }
          : null;

      this.routes.push({
        index,
        kind: scheduler ? 'scheduler' : 'client', scheduler, ticks: 0, skipped: 0,
        queueId: null,
        backlogKey: null,
        hops,
        dns,
        relayBack,
        clientId: route.clientId,
        clientName: client.name,
        loadBalancerId: route.loadBalancerId,
        loadBalancerSettings: balancer ? balancer.settings : null,
        clientOutChannel: channelKey(route.clientEdgeId, FORWARD),
        clientInChannel: channelKey(route.clientEdgeId, REVERSE),
        branches,
        nextBranch: 0,
        requestBytes: client.settings.requestBytes,
        responseBytes: client.settings.responseBytes,
        ratePerSecond: rate,
        intervalMs,
        arrivalStream: this.streams.stream(`arrival:${route.clientId}`),
        clientMode: client.settings.mode,
        thinkTimeMs: client.settings.thinkTimeMs,
        thinkStream: this.streams.stream(`think:${route.clientId}`),
        population: Math.max(0, Math.floor(client.settings.activeUsers)),
        expectedRequests,
        offered: 0,
        completed: 0,
        rejected: 0,
        responseStat: new StreamingStat(),
      });
    });

    this.compileConsumers();

    const maxSamples = this.input.limits.maxJourneySamples;
    this.traceEvery = expectedTotal > 0 ? Math.max(1, Math.floor(expectedTotal / maxSamples)) : 1;
  }

  /**
   * Everything a compute node calls, resolved to channels and settings once.
   * The same for a server behind a balancer, a server users reach directly,
   * and a worker behind a queue: the inbound link differs, nothing else.
   */
  private compileBranch(branch: ServerBranch): CompiledBranch {
    const nodeOf = <T>(id: string | null): T | null =>
      id ? ((this.routing.graph.nodesById.get(id) as T | undefined) ?? null) : null;
    const cacheNode = nodeOf<CacheNode>(branch.cacheId);
    const dbNode = nodeOf<DatabaseNode>(branch.databaseId);
    const pubsubNode = nodeOf<PubSubNode>(branch.pubsubId);
    const kvNode = nodeOf<KvStoreNode>(branch.kvStoreId);
    const storageNode = nodeOf<ObjectStorageNode>(branch.objectStorageId);
    const computeNode = this.routing.graph.nodesById.get(branch.serverId);
    const fn = computeNode && computeNode.kind === 'serverless' ? computeNode.settings : null;
    const fwd = (edgeId: string | null) => (edgeId ? channelKey(edgeId, FORWARD) : null);
    const rev = (edgeId: string | null) => (edgeId ? channelKey(edgeId, REVERSE) : null);
    return {
      serverId: branch.serverId,
      streamId: branch.streamId, streamOutChannel: fwd(branch.serverStreamEdgeId), streamInChannel: rev(branch.serverStreamEdgeId),
      streamSettings: nodeOf<EventStreamNode>(branch.streamId)?.settings ?? null,
      supportCalls: branch.supportCalls.map(e => ({ nodeId: e.nodeId, outChannel: channelKey(e.edgeId, FORWARD), inChannel: channelKey(e.edgeId, REVERSE) })),
      asyncCalls: branch.asyncCalls.map(e => ({ nodeId: e.nodeId, outChannel: channelKey(e.edgeId, FORWARD), inChannel: channelKey(e.edgeId, REVERSE) })),
      dataServices: branch.dataServices.map((s) => ({ nodeId: s.nodeId, outChannel: channelKey(s.edgeId, FORWARD), inChannel: channelKey(s.edgeId, REVERSE) })),
      cacheId: branch.cacheId,
      databaseId: branch.databaseId,
      serverInChannel: channelKey(branch.inboundEdgeId, FORWARD),
      serverOutChannel: channelKey(branch.inboundEdgeId, REVERSE),
      cacheOutChannel: fwd(branch.serverCacheEdgeId),
      cacheInChannel: rev(branch.serverCacheEdgeId),
      dbOutChannel: fwd(branch.serverDatabaseEdgeId),
      dbInChannel: rev(branch.serverDatabaseEdgeId),
      cacheSettings: cacheNode ? cacheNode.settings : null,
      databaseSettings: dbNode ? dbNode.settings : null,
      hitStream: cacheNode ? this.streams.stream(`cache-hit:${cacheNode.id}`) : null,
      queueId: branch.queueId,
      queueOutChannel: fwd(branch.serverQueueEdgeId),
      queueInChannel: rev(branch.serverQueueEdgeId),
      queueSettings: queueSettingsOf(this.routing, branch.queueId),
      pubsubId: branch.pubsubId,
      pubsubOutChannel: fwd(branch.serverPubSubEdgeId),
      pubsubInChannel: rev(branch.serverPubSubEdgeId),
      pubsubSettings: pubsubNode ? pubsubNode.settings : null,
      writeStream: dbNode ? this.streams.stream(`db-write:${dbNode.id}`) : null,
      replicas: branch.replicas.map((r) => ({
        nodeId: r.replicaId,
        outChannel: channelKey(r.serverReplicaEdgeId, FORWARD),
        inChannel: channelKey(r.serverReplicaEdgeId, REVERSE),
        settings: (this.routing.graph.nodesById.get(r.replicaId) as ReadReplicaNode).settings,
      })),
      nextReplica: 0,
      // Every write to the primary is copied to every replica of it — including
      // replicas this server does not read from, and writes from a worker that
      // reads from none. Replication is the database's business, not the caller's.
      replicationChannels: dbNode
        ? (this.routing.graph.outgoing.get(dbNode.id) ?? [])
            .filter((e) => this.routing.graph.nodesById.get(e.target)?.kind === 'readReplica')
            .map((e) => channelKey(e.id, FORWARD))
        : [],
      kvId: branch.kvStoreId,
      kvOutChannel: fwd(branch.serverKvStoreEdgeId),
      kvInChannel: rev(branch.serverKvStoreEdgeId),
      kvSettings: kvNode ? kvNode.settings : null,
      kvStream: kvNode ? this.streams.stream(`kv-write:${kvNode.id}`) : null,
      storageId: branch.objectStorageId,
      storageOutChannel: fwd(branch.serverObjectStorageEdgeId),
      storageInChannel: rev(branch.serverObjectStorageEdgeId),
      storageSettings: storageNode ? storageNode.settings : null,
      storageStream: storageNode ? this.streams.stream(`storage-write:${storageNode.id}`) : null,
      coldStream: fn ? this.streams.stream(`cold-start:${branch.serverId}`) : null,
      coldStartMs: fn ? fn.coldStartMs : 0,
      coldStartShare: fn ? fn.coldStartShare : 0,
    };
  }

  /**
   * One route per queue, for the server that drains it.
   *
   * A consumer route generates no arrivals of its own: work reaches it only
   * when a message is taken off a backlog. Its "client" channels are the queue
   * link — the forward direction carries the message to the worker, and the
   * reverse carries the acknowledgement that finishes it, which is the hop a
   * real consumer pays to tell the broker it is done.
   */
  private compileConsumers(): void {
    for (const consumer of this.routing.consumers) {
      const queueNode = this.routing.graph.nodesById.get(consumer.queueId) as
        | QueueNode
        | PubSubNode | EventStreamNode | DeadLetterNode
        | undefined;
      if (!queueNode) continue;
      const worker = this.routing.graph.nodesById.get(consumer.branch.serverId);
      if (!worker) continue;

      // A consumer may publish onward to another queue or topic; only a loop
      // back to its own is refused, by the resolver's cycle check.
      const branch = this.compileBranch(consumer.branch);

      const index = this.routes.length;
      this.consumerRouteByQueue.set(consumer.backlogKey, index);
      this.routes.push({
        index,
        kind: 'consumer', scheduler: null, ticks: 0, skipped: 0,
        hops: [],
        dns: null,
        relayBack: new Map(),
        queueId: consumer.queueId,
        backlogKey: consumer.backlogKey,
        clientId: consumer.queueId,
        clientName: queueNode.name,
        loadBalancerId: null,
        loadBalancerSettings: null,
        clientOutChannel: channelKey(consumer.deliveryEdgeId, FORWARD),
        clientInChannel: channelKey(consumer.deliveryEdgeId, REVERSE),
        branches: [branch],
        nextBranch: 0,
        requestBytes: queueNode.settings.messageBytes,
        responseBytes: 0,
        ratePerSecond: 0,
        intervalMs: Number.POSITIVE_INFINITY,
        arrivalStream: this.streams.stream(`consumer:${consumer.backlogKey}`),
        clientMode: 'open',
        thinkTimeMs: 0,
        thinkStream: this.streams.stream(`consumer-think:${consumer.backlogKey}`),
        population: 0,
        expectedRequests: 0,
        offered: 0,
        completed: 0,
        rejected: 0,
        responseStat: new StreamingStat(),
      });
    }
  }

  private scheduleInitialArrivals(): void {
    for (const model of this.support.values()) if (model.node.kind === 'websocket') {
      const at = model.node.settings.heartbeatSeconds * 1000;
      if (this.input.continuous || at < this.arrivalWindowMs) this.queue.push(at, { t: 'heartbeat', nodeId: model.node.id });
    }
    for (const b of this.backlogs.values()) if (b instanceof StreamBacklog && (this.input.continuous || b.startAt <= this.endTimeMs)) this.queue.push(b.startAt, { t: 'streamStart', key: b.key });
    for (const route of this.routes) {
      if (this.arrivalWindowMs <= 0) continue;
      if (route.scheduler) {
        const at = route.scheduler.startAfterSeconds * 1000;
        if (this.input.continuous || at < this.arrivalWindowMs) this.queue.push(at, { t: 'scheduledTick', route: route.index });
        continue;
      }
      if (route.clientMode === 'closed') {
        // Every user starts by sending one request. From then on each of them
        // sends the next only once its own has come back, so the population is
        // the hard limit on how many can ever be in flight at once.
        //
        // They are spread across one think time rather than released together.
        // Two hundred people do not click at the same instant, and starting
        // them together put a burst of two hundred requests at t=0 that pushed
        // the measured rate *above* the ceiling the same settings imply — an
        // artefact of the start, reported as if it were the system's behaviour.
        // Even spacing rather than a random offset, so this costs no randomness
        // and the run stays reproducible.
        const stagger = route.population > 0 ? route.thinkTimeMs / route.population : 0;
        for (let user = 0; user < route.population; user += 1) {
          const at = user * stagger;
          if (this.input.continuous || at < this.arrivalWindowMs) {
            this.queue.push(at, { t: 'arrival', route: route.index, user });
          }
        }
        continue;
      }
      if (route.ratePerSecond > 0) {
        this.queue.push(0, { t: 'arrival', route: route.index, user: -1 });
      }
    }
  }

  /**
   * How long until this route's next request, in open mode.
   *
   * The shaped patterns divide the configured interval by the multiplier in
   * force right now; Poisson then replaces the even spacing with an exponential
   * draw of the same mean, from this route's own stream.
   */
  private nextArrivalDelay(route: CompiledRoute): number {
    const workload = this.input.document.workload;
    // A multiplier of zero would mean an infinite wait, which ends this route's
    // arrivals for good. The schema keeps the shaped multipliers at 0.01 or
    // more so that cannot happen by accident; this is the backstop.
    const multiplier = arrivalRateMultiplier(workload, this.now, this.arrivalWindowMs);
    if (multiplier <= 0) return Number.POSITIVE_INFINITY;
    const interval = route.intervalMs / multiplier;
    if (workload.arrivalPattern !== 'poisson') return interval;
    // next() is in [0, 1), so 1 - u is in (0, 1] and the logarithm is safe.
    return -Math.log(1 - route.arrivalStream.next()) * interval;
  }

  // -------------------------------------------------------------- execution

  get progressUpdate(): ProgressUpdate {
    const denominator = this.endTimeMs > 0 ? this.endTimeMs : 1;
    return {
      fraction: this.finished ? 1 : Math.min(1, this.now / denominator),
      simulatedMs: this.now,
      eventsProcessed: this.eventsProcessed,
      completed: this.completed,
    };
  }

  get isFinished(): boolean {
    return this.finished;
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.status = 'cancelled';
    this.statusReason = 'The run was cancelled before it finished.';
  }

  /**
   * Process up to `maxEvents` events, then return control. Running in chunks
   * is what keeps the worker able to notice a cancel message.
   */
  step(maxEvents: number, untilMs = Number.POSITIVE_INFINITY): StepOutcome {
    let processed = 0;
    const limits = this.input.limits;

    while (!this.finished && processed < maxEvents) {
      if (!this.input.continuous && this.eventsProcessed >= limits.maxProcessedEvents) {
        this.stop('incomplete', `Stopped after processing ${limits.maxProcessedEvents.toLocaleString()} events. The run reached Aparecium's event limit, so these results cover only part of the configured duration.`);
        break;
      }
      if (this.queue.size >= limits.maxPendingEvents) {
        this.stop('incomplete', `Stopped with ${this.queue.size.toLocaleString()} events waiting to be processed, which is Aparecium's pending-event limit. The configuration generates work faster than the model can retire it.`);
        break;
      }
      if (this.requests.size >= limits.maxInFlightRequests) {
        this.stop('incomplete', `Stopped with ${this.requests.size.toLocaleString()} requests in flight, which is Aparecium's in-flight limit. Requests are arriving much faster than the system can complete them.`);
        break;
      }

      const nextTime = this.queue.peekTime();
      // A snapshot boundary does not drain or reset any resource or random stream.
      if (Number.isFinite(untilMs) && (nextTime === null || nextTime >= untilMs)) {
        this.now = Math.max(this.now, untilMs);
        break;
      }
      if (nextTime === null) {
        this.stop('completed');
        break;
      }
      if (!this.input.continuous && nextTime > this.endTimeMs) {
        this.now = this.endTimeMs;
        this.stop(
          'completed',
          this.requests.size > 0
            ? 'The drain window ended before every in-flight request finished.'
            : undefined,
        );
        break;
      }

      const event = this.queue.pop();
      if (!event) {
        this.stop('completed');
        break;
      }
      this.now = event.time;
      this.handle(event.payload);
      this.eventsProcessed += 1;
      processed += 1;
    }

    return { done: this.finished, processed, progress: this.progressUpdate };
  }

  /** Run to completion. Convenience for tests and for the inline fallback. */
  runToCompletion(chunk = 50_000): SimulationResult {
    while (!this.finished) this.step(chunk);
    return this.result();
  }

  private stop(status: SimulationResult['status'], reason?: string): void {
    this.finished = true;
    this.status = status;
    if (reason) this.statusReason = reason;
  }

  // --------------------------------------------------------------- handlers

  private handle(payload: EventPayload): void {
    switch (payload.t) {
      case 'supportEnd': this.supportEnd(payload.nodeId, payload.id); break;
      case 'heartbeat': this.heartbeat(payload.nodeId); break;
      case 'scheduledTick': this.scheduledTick(payload.route); break;
      case 'streamStart': { const b = this.backlogs.get(payload.key); if (b instanceof StreamBacklog) b.activate(this.now); this.dispatchFromQueue(payload.key); break; }
      case 'jobMaintenance': this.jobMaintenance(payload.nodeId); break;
      case 'replay': this.dispatchFromQueue(payload.key); break;
      case 'retry': { const b = this.backlogs.get(payload.key); if (b instanceof QueueModel) b.restoreRetry(payload.message, this.now); this.dispatchFromQueue(payload.key); break; }
      case 'dataEnd':
        this.onDataEnd(payload.nodeId, payload.request);
        break;
      case 'arrival':
        this.onArrival(payload.route, payload.user);
        return;
      case 'txEnd':
        this.onTransmissionEnd(payload.channel);
        return;
      case 'deliver':
        this.onDeliver(payload.channel, payload.msg);
        return;
      case 'cpuEnd':
        this.onCpuEnd(payload.server, payload.request);
        return;
      case 'serviceEnd':
        this.onServiceEnd(payload.station, payload.request, payload.op);
        return;
    }
  }

  private onArrival(routeIndex: number, userIndex: number): void {
    const route = this.routes[routeIndex];
    if (!route) return;

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (route.kind === 'client') this.offered += 1;
    route.offered += 1;

    const shouldTrace =
      this.tracedCount < this.input.limits.maxJourneySamples &&
      (this.offered - 1) % this.traceEvery === 0;

    const request: RequestState = {
      id,
      routeIndex, actor: `${route.clientId}:${userIndex >= 0 ? userIndex : (route.offered - 1) % Math.max(1, route.population)}`, supportIndex: 0, pendingSupport: null,
      // With a balancer the server is not known yet; without one there is only
      // ever branch 0, so it can be assigned immediately.
      branchIndex: route.loadBalancerId ? -1 : 0,
      createdAt: this.now,
      cacheHit: false,
      cacheChecked: false,
      dbDone: false,
      dbWrite: false,
      populateDone: false,
      kvDone: false,
      kvWrite: false,
      storageDone: false,
      storageWrite: false,
      topicPublished: false, streamPublished: false, jobExecutionChecked: false,
      dataIndex: 0, dataOperation: null,
      coldStartMs: 0,
      admittedAt: 0,
      cpuMsPerSegment: 0,
      waitMs: 0,
      admitted: false,
      userIndex,
      queuePublished: false,
      message: null,
      journey: shouldTrace ? [] : null,
    };
    if (shouldTrace) this.tracedCount += 1;
    this.requests.set(id, request);
    if (request.branchIndex === 0) this.prepareForBranch(request, route.branches[0]!);

    this.trace(request, 'Request created', `${route.clientName} sends ${route.requestBytes} bytes`);

    // A share of requests do not yet know where to go: they ask the DNS first
    // and set off when the answer arrives. The rest have the answer cached.
    if (route.dns && route.dns.stream.bernoulli(route.dns.settings.lookupShare)) {
      this.trace(request, 'DNS lookup', 'no cached answer for the name');
      this.send(route.dns.outChannel, request, 'dnsQuery', route.dns.settings.queryBytes);
    } else {
      this.send(route.clientOutChannel, request, 'request', route.requestBytes);
    }

    // In closed mode there is no timer: this user's next request is scheduled
    // when this one comes back. See completeRequest and rejectRequest.
    if (route.kind === 'scheduler' || route.clientMode === 'closed') return;

    // Compute steady arrivals from their index. Repeatedly adding a fractional
    // interval drifts just below the end boundary and creates an extra request.
    const nextTime = this.input.document.workload.arrivalPattern === 'constant'
      ? route.offered * route.intervalMs
      : this.now + this.nextArrivalDelay(route);
    if (this.input.continuous || nextTime < this.arrivalWindowMs) {
      this.queue.push(nextTime, { t: 'arrival', route: routeIndex, user: -1 });
    }
  }

  /**
   * A user in closed mode has its answer: think for a while, then go again.
   *
   * Scheduled only while arrivals are still being generated, so the drain
   * period ends the run rather than being fed forever by a population that
   * never gets tired.
   */
  private scheduleThink(request: RequestState, route: CompiledRoute): void {
    if (route.clientMode !== 'closed' || request.userIndex < 0) return;
    const mean = route.thinkTimeMs;
    const delay = mean > 0 ? -Math.log(1 - route.thinkStream.next()) * mean : 0;
    const nextTime = this.now + delay;
    if (this.input.continuous || nextTime < this.arrivalWindowMs) {
      this.queue.push(nextTime, { t: 'arrival', route: route.index, user: request.userIndex });
    }
  }

  private branchOf(request: RequestState): CompiledBranch | null {
    const route = this.routes[request.routeIndex];
    if (!route || request.branchIndex < 0) return null;
    return route.branches[request.branchIndex] ?? null;
  }

  /**
   * Fix everything that depends on *which* server will handle this request:
   * whether its cache lookup hits, and therefore how many compute segments it
   * needs and how much CPU each one gets.
   *
   * Without a balancer this happens when the request is created. With one it
   * happens the moment the balancer picks a server — still before any compute,
   * and still from a stream dedicated to that cache, so runs stay reproducible.
   */
  private prepareForBranch(request: RequestState, branch: CompiledBranch): void {
    request.cacheHit = branch.hitStream
      ? branch.hitStream.bernoulli(branch.cacheSettings!.hitRate)
      : false;
    // Each draw from a stream of its own, so adding a store never reshuffles
    // another store's luck and runs stay comparable across designs.
    request.dbWrite = branch.writeStream
      ? !branch.writeStream.bernoulli(branch.databaseSettings!.readShare)
      : false;
    request.kvWrite = branch.kvStream
      ? !branch.kvStream.bernoulli(branch.kvSettings!.readShare)
      : false;
    request.storageWrite = branch.storageStream
      ? branch.storageStream.bernoulli(branch.storageSettings!.writeShare)
      : false;
    request.coldStartMs =
      branch.coldStream && branch.coldStream.bernoulli(branch.coldStartShare)
        ? branch.coldStartMs
        : 0;
    const segments = countDownstreamCalls(branch, request) + 1;
    const server = this.servers.get(branch.serverId);
    request.cpuMsPerSegment = server ? server.cpuMsPerRequest / segments : 0;
  }

  /** Round-robin, or the server with the fewest requests in hand. */
  private chooseBranch(route: CompiledRoute): number {
    if (route.branches.length === 1) return 0;
    if (route.loadBalancerSettings?.policy === 'least-busy') {
      let best = 0;
      let bestLoad = Number.POSITIVE_INFINITY;
      for (let i = 0; i < route.branches.length; i += 1) {
        const server = this.servers.get(route.branches[i]!.serverId);
        // Ties keep the lowest index, so the choice is deterministic.
        const load = server ? server.admittedCount + server.admissionQueue.length : 0;
        if (load < bestLoad) {
          bestLoad = load;
          best = i;
        }
      }
      return best;
    }
    const index = route.nextBranch;
    route.nextBranch = (route.nextBranch + 1) % route.branches.length;
    return index;
  }

  private send(
    key: string,
    request: RequestState,
    kind: MessageKind,
    bytes: number,
  ): void {
    const channel = this.channels.get(key);
    if (!channel) return;
    channel.enqueue({ requestId: request.id, kind, bytes, queuedAt: this.now }, this.now);
    this.pump(channel);
  }

  private pump(channel: LinkChannel): void {
    const started = channel.startNext(this.now);
    if (!started) return;
    const request = this.requests.get(started.message.requestId);
    if (request) request.waitMs += this.now - started.message.queuedAt;
    this.queue.push(this.now + started.durationMs, { t: 'txEnd', channel: channel.key });
  }

  private onTransmissionEnd(key: string): void {
    const channel = this.channels.get(key);
    if (!channel) return;
    const message = channel.finishTransmission(this.now);
    if (message) {
      this.queue.push(this.now + channel.propagationDelayMs, {
        t: 'deliver',
        channel: key,
        msg: message,
      });
    }
    this.pump(channel);
  }

  private onDeliver(key: string, message: LinkMessage): void {
    // A write copied to a replica belongs to no waiting request: the one that
    // wrote it may already have been answered and forgotten.
    if (message.kind === 'heartbeat' || message.kind === 'supportAck') return;
    if (message.kind === 'supportDetached') {
      const ch = this.channels.get(key); const model = ch ? this.support.get(ch.toId) : undefined;
      if (model && ch) this.admitSupport(model, message.requestId, channelKey(ch.edgeId, REVERSE), `detached:${message.requestId}`);
      return;
    }
    if (message.kind === 'deadLetter') {
      const target = this.channels.get(key)?.toId;
      const b = target ? this.backlogs.get(target) : undefined;
      if (b instanceof DeadLetterModel && message.job && b.push(message.job, this.now)) {
        this.scheduleJobMaintenance(b.nodeId);
        const at = this.now + b.node.settings.replayDelaySeconds * 1000;
        if (b.node.settings.replayEnabled && (this.input.continuous || at <= this.endTimeMs)) this.queue.push(at, { t: 'replay', key: b.key });
      }
      return;
    }
    if (message.kind === 'replicate') {
      const channel = this.channels.get(key);
      if (channel) this.replicaApply(channel.toId, message.requestId);
      return;
    }
    const request = this.requests.get(message.requestId);
    if (!request) return;
    const route = this.routes[request.routeIndex]!;
    const branch = this.branchOf(request);

    switch (message.kind) {
      case 'request': {
        // A request arriving at an edge component is held there for a moment
        // and then let through, stopped, or answered — see onServiceEnd.
        const at = this.hopByInChannel.get(key);
        if (at) {
          if (at.hop.support) { request.pendingSupport = { call: { nodeId: at.hop.nodeId, outChannel: key, inChannel: at.hop.backChannel }, next: 'inline', hopId: at.hop.nodeId }; this.admitSupport(this.support.get(at.hop.nodeId)!, request.id, String(route.index), request.actor); return; }
          this.stationRequest(at.hop.nodeId, request, 'edgeForward');
          return;
        }
        // Otherwise it has reached the balancer when there is one, and the
        // single server when there is not.
        if (route.loadBalancerId && request.branchIndex < 0) {
          this.stationRequest(route.loadBalancerId, request, 'lbForward');
        } else {
          this.admitAtServer(request);
        }
        return;
      }
      case 'dnsQuery':
        if (route.dns) this.stationRequest(route.dns.nodeId, request, 'dnsLookup');
        return;
      case 'dnsAnswer':
        this.trace(request, 'Name resolved', 'the request can set off');
        this.send(route.clientOutChannel, request, 'request', route.requestBytes);
        return;
      case 'cacheLookup':
        if (branch?.cacheId) this.stationRequest(branch.cacheId, request, 'cacheLookup');
        return;
      case 'cachePopulate':
        if (branch?.cacheId) this.stationRequest(branch.cacheId, request, 'cachePopulate');
        return;
      case 'dbQuery':
        if (branch?.databaseId) this.stationRequest(branch.databaseId, request, 'dbQuery');
        return;
      case 'replicaQuery': {
        const channel = this.channels.get(key);
        if (channel) this.stationRequest(channel.toId, request, 'replicaQuery');
        return;
      }
      case 'dataOp': {
        const call = branch?.dataServices[request.dataIndex];
        const model = call ? this.dataServices.get(call.nodeId) : undefined;
        if (model && request.dataOperation) {
          const accepted = model.admit(request.id, request.dataOperation, this.now,
            (id, ms, waited) => this.scheduleData(model.node.id, id, ms, waited));
          if (!accepted) this.rejectRequest(request, 'data-service-full');
        }
        return;
      }
      case 'dataResult':
        request.dataIndex++;
        request.dataOperation = null;
        this.trace(request, 'Data service response received');
        this.beginCpuSegment(request);
        return;
      case 'kvOp':
        if (branch?.kvId) this.stationRequest(branch.kvId, request, request.kvWrite ? 'kvWrite' : 'kvRead');
        return;
      case 'kvResult':
        request.kvDone = true;
        this.trace(request, request.kvWrite ? 'Key-value write acknowledged' : 'Key-value record received');
        this.beginCpuSegment(request);
        return;
      case 'storageOp':
        if (branch?.storageId) {
          this.stationRequest(branch.storageId, request, request.storageWrite ? 'storagePut' : 'storageGet');
        }
        return;
      case 'storageResult':
        request.storageDone = true;
        this.trace(request, request.storageWrite ? 'Object stored' : 'Object received');
        this.beginCpuSegment(request);
        return;
      case 'supportCall': { const call = request.pendingSupport?.call; if (call) this.admitSupport(this.support.get(call.nodeId)!, request.id, request.pendingSupport?.next === 'gateway' ? request.pendingSupport.hopId! : this.branchOf(request)?.serverId ?? route.clientId, request.actor); break; }
      case 'supportReply': {
        if (message.failure) this.rejectRequest(request, message.failure as RejectionReason);
        else this.afterSupport(request);
        break;
      }
      case 'streamPublish': if (branch?.streamId) this.stationRequest(branch.streamId, request, 'streamPublish'); break;
      case 'streamAck': request.streamPublished = true; this.beginCpuSegment(request); break;
      case 'queuePublish':
        if (branch?.queueId) this.stationRequest(branch.queueId, request, 'queuePublish');
        return;
      case 'topicPublish':
        if (branch?.pubsubId) this.stationRequest(branch.pubsubId, request, 'topicPublish');
        return;
      case 'topicAck':
        request.topicPublished = true;
        this.trace(request, 'Event accepted by the topic');
        this.beginCpuSegment(request);
        return;
      case 'queueAck':
        request.queuePublished = true;
        this.trace(request, 'Message accepted by the queue');
        this.beginCpuSegment(request);
        return;
      case 'cacheResult':
        request.cacheChecked = true;
        this.trace(request, request.cacheHit ? 'Cache hit' : 'Cache miss');
        this.beginCpuSegment(request);
        return;
      case 'dbResult':
        request.dbDone = true;
        this.trace(request, 'Database result received');
        this.beginCpuSegment(request);
        return;
      case 'cachePopulateAck':
        request.populateDone = true;
        this.trace(request, 'Cache populated');
        this.beginCpuSegment(request);
        return;
      case 'response': {
        // Arriving on the client's inbound link means the journey is over.
        // Anything else has reached the balancer or an edge component and is
        // relayed one link closer to the users.
        if (key === route.clientInChannel) {
          this.completeRequest(request, route);
          return;
        }
        const next = route.relayBack.get(key) ?? route.clientInChannel;
        this.trace(request, 'Passed back towards the users');
        this.send(next, request, 'response', route.responseBytes);
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------ server side

  private admitAtServer(request: RequestState): void {
    const branch = this.branchOf(request);
    if (!branch) return;
    const server = this.servers.get(branch.serverId);
    if (!server) return;

    if (server.canAdmitNow()) {
      server.admit(this.now);
      request.admitted = true;
      request.admittedAt = this.now;
      this.trace(
        request,
        server.kind === 'serverless' ? 'Invocation started' : 'Admitted by server',
        server.name,
      );
      this.beginCpuSegment(request);
      return;
    }
    if (server.canQueueNow()) {
      server.queueForAdmission(request.id, this.now);
      this.trace(request, 'Waiting for a server slot', `${server.admissionQueue.length} in queue`);
      return;
    }
    // A function has no waiting line at all: over the concurrency limit is
    // refused on the spot, which is what a platform does with a 429.
    if (server.kind === 'serverless') {
      server.throttled += 1;
      server.rejected += 1;
      this.trace(request, 'Throttled', 'the function is at its concurrency limit');
      this.rejectRequest(request, 'function-throttled');
      return;
    }
    const reason: RejectionReason =
      server.admissionQueue.length >= server.queueLimit
        ? 'server-queue-full'
        : 'server-memory-full';
    server.rejected += 1;
    this.rejectRequest(request, reason);
  }

  private beginCpuSegment(request: RequestState): void {
    const branch = this.branchOf(request);
    if (!branch) return;
    const server = this.servers.get(branch.serverId);
    if (!server) return;
    if (server.hasFreeCpu) {
      this.startCpu(server, request);
    } else {
      server.queueForCpu(request.id, this.now);
      this.trace(request, 'Waiting for a CPU slot', `${server.cpuQueue.length} in queue`);
    }
  }

  private startCpu(server: ServerModel, request: RequestState): void {
    // A cold start is paid once, before the first segment: the platform has
    // to bring up an instance before the code can run at all.
    let ms = request.cpuMsPerSegment;
    if (request.coldStartMs > 0) {
      ms += request.coldStartMs;
      server.coldStarts += 1;
      this.trace(request, 'Cold start', `${request.coldStartMs} ms to bring up an instance`);
      request.coldStartMs = 0;
    }
    server.occupyCpu(this.now, ms);
    this.trace(request, 'Using CPU', `${request.cpuMsPerSegment.toFixed(2)} ms`);
    this.queue.push(this.now + ms, {
      t: 'cpuEnd',
      server: server.nodeId,
      request: request.id,
    });
  }

  private onCpuEnd(serverId: string, requestId: number): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    server.releaseCpu(this.now);

    // Hand the freed CPU slot to whoever has been waiting longest.
    const waiting = server.dequeueForCpu(this.now);
    if (waiting) {
      const next = this.requests.get(waiting.requestId);
      if (next) {
        next.waitMs += this.now - waiting.queuedAt;
        this.startCpu(server, next);
      }
    }

    const request = this.requests.get(requestId);
    if (!request) return;
    this.afterCpu(request);
  }

  /**
   * Decide what the server does next. This is the cache-aside logic:
   * check the cache, read the database on a miss, optionally write the value
   * back, then answer the client. CPU work is spread evenly across the gaps
   * between these calls.
   */
  private afterCpu(request: RequestState): void {
    if (!request.jobExecutionChecked) {
      request.jobExecutionChecked = true;
      const route = this.routes[request.routeIndex]!;
      const source = route.queueId ? this.routing.graph.nodesById.get(route.queueId) : null;
      if (source?.kind === 'queue' && this.streams.stream(`queue-failure:${source.id}`).bernoulli(source.settings.processingFailureShare)) { this.rejectRequest(request, 'worker-failed'); return; }
    }
    const branch = this.branchOf(request);
    if (!branch) return;

    if (branch.cacheId && !request.cacheChecked && branch.cacheOutChannel) {
      this.trace(request, 'Cache lookup sent');
      this.send(
        branch.cacheOutChannel,
        request,
        'cacheLookup',
        branch.cacheSettings!.lookupRequestBytes,
      );
      return;
    }
    const dependency = branch.supportCalls[request.supportIndex];
    if (dependency) { this.callSupport(dependency, request, 'branch'); return; }
    const call = branch.dataServices[request.dataIndex];
    if (call) {
      const model = this.dataServices.get(call.nodeId)!;
      request.dataOperation = model.prepare(this.now);
      this.trace(request, `Calling ${model.node.name}`, request.dataOperation.write ? 'write' : 'read');
      this.send(call.outChannel, request, 'dataOp', request.dataOperation.requestBytes);
      return;
    }
    const cacheAnswered = branch.cacheId !== null && request.cacheHit;
    if (branch.databaseId && !request.dbDone && !cacheAnswered && branch.dbOutChannel) {
      // Reads go to a replica when there is one, round-robin; writes go to
      // the primary, and are copied to every replica once it has them.
      if (!request.dbWrite && branch.replicas.length > 0) {
        const replica = branch.replicas[branch.nextReplica % branch.replicas.length]!;
        branch.nextReplica = (branch.nextReplica + 1) % branch.replicas.length;
        this.trace(request, 'Read sent to a replica', this.stations.get(replica.nodeId)?.name);
        this.send(replica.outChannel, request, 'replicaQuery', branch.databaseSettings!.queryRequestBytes);
        return;
      }
      this.trace(request, request.dbWrite ? 'Database write sent' : 'Database query sent');
      this.send(branch.dbOutChannel, request, 'dbQuery', branch.databaseSettings!.queryRequestBytes);
      return;
    }
    // A key-value read is a record lookup, so a cache hit answers it too; a
    // write goes through whatever the cache said.
    if (branch.kvId && !request.kvDone && branch.kvOutChannel && (request.kvWrite || !cacheAnswered)) {
      this.trace(request, request.kvWrite ? 'Key-value write sent' : 'Key-value read sent');
      this.send(
        branch.kvOutChannel,
        request,
        'kvOp',
        request.kvWrite ? branch.kvSettings!.itemBytes : CONTROL_BYTES,
      );
      return;
    }
    if (branch.storageId && !request.storageDone && branch.storageOutChannel) {
      this.trace(request, request.storageWrite ? 'Object upload sent' : 'Object requested');
      this.send(
        branch.storageOutChannel,
        request,
        'storageOp',
        request.storageWrite ? branch.storageSettings!.objectBytes : CONTROL_BYTES,
      );
      return;
    }
    if (
      branch.cacheId &&
      branch.cacheSettings!.populateOnMiss &&
      request.cacheChecked &&
      !request.cacheHit &&
      !request.populateDone &&
      branch.cacheOutChannel
    ) {
      this.trace(request, 'Cache write sent');
      this.send(branch.cacheOutChannel, request, 'cachePopulate', branch.cacheSettings!.populateBytes);
      return;
    }
    // The last thing before answering: hand the slow work to the queue. The
    // caller waits only for the broker to take it, not for it to be done.
    if (branch.queueId && !request.queuePublished && branch.queueOutChannel) {
      this.trace(request, 'Message published', branch.queueSettings
        ? `${branch.queueSettings.messageBytes} bytes`
        : undefined);
      this.send(
        branch.queueOutChannel,
        request,
        'queuePublish',
        branch.queueSettings?.messageBytes ?? 0,
      );
      return;
    }
    if (branch.pubsubId && !request.topicPublished && branch.pubsubOutChannel) {
      this.trace(request, 'Event published to the topic', `${branch.pubsubSettings?.messageBytes ?? 0} bytes`);
      this.send(branch.pubsubOutChannel, request, 'topicPublish', branch.pubsubSettings?.messageBytes ?? 0);
      return;
    }
    if (branch.streamId && !request.streamPublished && branch.streamOutChannel) {
      this.send(branch.streamOutChannel, request, 'streamPublish', branch.streamSettings!.messageBytes); return;
    }
    this.respond(request);
  }

  private scheduleData(nodeId: string, id: number, ms: number, waited: number): void {
    const request = this.requests.get(id);
    if (request) request.waitMs += waited;
    this.queue.push(this.now + ms, { t: 'dataEnd', nodeId, request: id });
  }

  private onDataEnd(nodeId: string, id: number): void {
    const model = this.dataServices.get(nodeId);
    const operation = model?.finish(id, this.now, (nextId, ms, waited) => this.scheduleData(nodeId, nextId, ms, waited));
    const request = this.requests.get(id);
    if (!request || !operation) return;
    const call = this.branchOf(request)?.dataServices[request.dataIndex];
    if (call) this.send(call.inChannel, request, 'dataResult', operation.responseBytes);
  }

  private respond(request: RequestState): void {
    this.emitBackground(request);
    const route = this.routes[request.routeIndex]!;
    const branch = this.branchOf(request);
    const server = branch ? this.servers.get(branch.serverId) : undefined;
    if (server) {
      server.completed += 1;
      if (request.admitted) {
        server.busyMsTotal += this.now - request.admittedAt;
        server.releaseAdmission(this.now);
        request.admitted = false;
      }
    }
    this.trace(request, 'Response sent', `${route.responseBytes} bytes`);
    this.send(
      branch ? branch.serverOutChannel : route.clientInChannel,
      request,
      'response',
      route.responseBytes,
    );
    if (server) this.promoteFromQueue(server);
  }

  /**
   * Hand waiting messages to the consumer, for as long as it has room.
   *
   * Everything else in the engine is push: a station finishes and passes the
   * request on. A queue is the other way round — the work sits still until a
   * consumer comes for it, which is exactly why a backlog can grow. Called
   * whenever either side changes: a message arrives, or the consumer finishes
   * one.
   *
   * The `inFlight` bound matters. `canAdmitNow` only counts requests the server
   * has already admitted, and a message spends a moment on the link before it
   * gets there, so without this the consumer would take more than it can hold.
   */
  private dispatchFromQueue(backlogKey: string): void {
    const backlog = this.backlogs.get(backlogKey);
    const routeIndex = this.consumerRouteByQueue.get(backlogKey);
    if (!backlog || routeIndex === undefined) return;
    const route = this.routes[routeIndex];
    const branch = route?.branches[0];
    if (!route || !branch) return;
    const worker = this.servers.get(branch.serverId);
    if (!worker) return;

    while (
      backlog.depth > 0 &&
      backlog.inFlight < worker.concurrencyLimit &&
      worker.canAdmitNow()
    ) {
      const message = backlog.take(this.now);
      if (!message) return;

      const id = this.nextRequestId;
      this.nextRequestId += 1;
      route.offered += 1;

      const shouldTrace =
        this.tracedCount < this.input.limits.maxJourneySamples &&
        (this.offered + route.offered - 1) % this.traceEvery === 0;

      const job: RequestState = {
        id,
        routeIndex, actor: `job:${id}`, supportIndex: 0, pendingSupport: null,
        branchIndex: 0,
        createdAt: this.now,
        cacheHit: false,
        cacheChecked: false,
        dbDone: false,
        dbWrite: false,
        populateDone: false,
        kvDone: false,
        kvWrite: false,
        storageDone: false,
        storageWrite: false,
        topicPublished: false, streamPublished: false, jobExecutionChecked: false,
      dataIndex: 0, dataOperation: null,
        coldStartMs: 0,
        admittedAt: 0,
        cpuMsPerSegment: 0,
        waitMs: 0,
        admitted: false,
        userIndex: -1,
        queuePublished: false,
        message,
        journey: shouldTrace ? [] : null,
      };
      if (shouldTrace) this.tracedCount += 1;
      this.requests.set(id, job);
      this.prepareForBranch(job, branch);
      this.trace(job, 'Taken from the queue', route.clientName);
      this.send(route.clientOutChannel, job, 'request', route.requestBytes);
    }
  }

  /**
   * What an edge component does with a request it has finished looking at.
   *
   * Each kind has exactly one reason of its own to stop a request, and it is
   * the whole reason the component exists on the canvas:
   *   - a CDN answers a hit itself, and the origin never hears of it;
   *   - a WAF refuses a share as malicious, and nothing behind it sees them;
   *   - a gateway refuses what is over its rate limit, rather than queueing it.
   * Everything else is forwarded one link onward.
   */
  private leaveHop(
    hop: CompiledHop,
    station: StationModel,
    request: RequestState,
    route: CompiledRoute,
  ): void {
    if (hop.cdn) {
      if (hop.stream.bernoulli(hop.cdn.hitRate)) {
        station.hits += 1;
        this.trace(request, 'Answered by the CDN', `${route.responseBytes} bytes from the edge`);
        this.send(hop.backChannel, request, 'response', route.responseBytes);
        return;
      }
      station.misses += 1;
      this.trace(request, 'CDN miss', 'forwarded to the origin');
    } else if (hop.waf) {
      if (hop.stream.bernoulli(hop.waf.blockRate)) {
        station.blocked += 1;
        this.trace(request, 'Blocked by the WAF');
        this.rejectRequest(request, 'waf-blocked');
        return;
      }
      this.trace(request, 'Passed the WAF');
    } else if (hop.gateway) {
      if (!this.gatewayAdmits(hop.nodeId, hop.gateway)) {
        station.throttled += 1;
        this.trace(request, 'Throttled by the API gateway', 'over the rate limit');
        this.rejectRequest(request, 'gateway-throttled');
        return;
      }
      this.trace(request, 'Forwarded by the API gateway');
    }
    this.send(hop.outChannel, request, 'request', route.requestBytes);
  }

  /** Take a token from the gateway's bucket, refilling it for the time elapsed. */
  private gatewayAdmits(nodeId: string, settings: ApiGatewaySettings): boolean {
    const rate = settings.rateLimitPerSecond;
    if (rate === null) return true;
    const capacity = Math.max(1, settings.burstCapacity);
    let bucket = this.buckets.get(nodeId);
    if (!bucket) {
      bucket = { tokens: capacity, refilledAt: this.now };
      this.buckets.set(nodeId, bucket);
    }
    const elapsedSeconds = (this.now - bucket.refilledAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * rate);
    bucket.refilledAt = this.now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private promoteFromQueue(server: ServerModel): void {
    while (server.canPromoteFromQueue()) {
      const waiting = server.dequeueForAdmission(this.now);
      if (!waiting) break;
      server.admit(this.now);
      const next = this.requests.get(waiting.requestId);
      if (!next) continue;
      next.waitMs += this.now - waiting.queuedAt;
      next.admitted = true;
      this.trace(next, 'Admitted by server after waiting');
      this.beginCpuSegment(next);
    }
  }

  // ----------------------------------------------------------- station side

  private serviceTimeFor(request: RequestState, op: StationOp, stationId: string): number {
    const route = this.routes[request.routeIndex];
    if (op === 'lbForward') return route?.loadBalancerSettings?.serviceTimeMs ?? 0;
    if (op === 'edgeForward') return this.edgeServiceTime(route, stationId);
    const branch = this.branchOf(request);
    switch (op) {
      case 'dbQuery':
        return branch?.databaseSettings?.queryServiceTimeMs ?? 0;
      case 'replicaQuery':
        return branch?.replicas.find((r) => r.nodeId === stationId)?.settings.queryServiceTimeMs ?? 0;
      case 'replicaApply':
        return this.stations.get(stationId)?.applyMs ?? 0;
      case 'cacheLookup':
        return branch?.cacheSettings?.lookupServiceTimeMs ?? 0;
      case 'cachePopulate':
        return branch?.cacheSettings?.populateServiceTimeMs ?? 0;
      case 'queuePublish':
        return branch?.queueSettings?.publishServiceTimeMs ?? 0;
      case 'streamPublish': return branch?.streamSettings?.publishServiceTimeMs ?? 0;
      case 'topicPublish':
        return branch?.pubsubSettings?.publishServiceTimeMs ?? 0;
      case 'kvRead':
        return branch?.kvSettings?.readServiceTimeMs ?? 0;
      case 'kvWrite':
        return branch?.kvSettings?.writeServiceTimeMs ?? 0;
      case 'storageGet':
        return branch?.storageSettings?.getServiceTimeMs ?? 0;
      case 'storagePut':
        return branch?.storageSettings?.putServiceTimeMs ?? 0;
      case 'dnsLookup':
        return route?.dns?.settings.lookupServiceTimeMs ?? 0;
      default:
        return 0;
    }
  }

  /**
   * A write reaching a replica from its primary. Nobody is waiting for it, so
   * it never rejects: a replica that cannot keep up falls behind, and how far
   * behind is the size of its line.
   */
  private replicaApply(replicaId: string, requestId: number): void {
    const station = this.stations.get(replicaId);
    if (!station) return;
    if (station.queue.length >= this.input.limits.maxPendingEvents) {
      this.stop('incomplete', 'Replication backlog reached the simulation memory limit. Reduce write load or increase replica capacity.');
      return;
    }
    if (station.hasFreeSlot) {
      station.occupy(this.now, station.applyMs);
      this.queue.push(this.now + station.applyMs, {
        t: 'serviceEnd',
        station: replicaId,
        request: requestId,
        op: 'replicaApply',
      });
      return;
    }
    station.enqueue({ requestId, op: 'replicaApply', queuedAt: this.now }, this.now);
  }

  /** An edge hop's own service time, looked up by the station it is. */
  private edgeServiceTime(route: CompiledRoute | undefined, stationId: string): number {
    const hop = route?.hops.find((h) => h.nodeId === stationId);
    if (!hop) return 0;
    return hop.cdn?.serviceTimeMs ?? hop.waf?.serviceTimeMs ?? hop.gateway?.serviceTimeMs ?? 0;
  }

  private static rejectionFor(kind: StationModel['kind']): RejectionReason {
    switch (kind) {
      case 'database':
        return 'database-queue-full';
      case 'cache':
        return 'cache-queue-full';
      case 'queue':
        return 'queue-publish-full';
      case 'dns':
        return 'dns-queue-full';
      case 'cdn':
        return 'cdn-queue-full';
      case 'waf':
        return 'waf-queue-full';
      case 'apiGateway':
        return 'gateway-queue-full';
      case 'readReplica':
        return 'replica-queue-full';
      case 'kvStore':
        return 'kv-queue-full';
      case 'objectStorage':
        return 'storage-queue-full';
      case 'eventStream': return 'stream-publish-full';
      case 'pubsub':
        return 'pubsub-publish-full';
      default:
        return 'balancer-queue-full';
    }
  }

  private static waitLabelFor(kind: StationModel['kind']): string {
    switch (kind) {
      case 'database':
        return 'Waiting for a database slot';
      case 'cache':
        return 'Waiting for a cache slot';
      case 'queue':
        return 'Waiting for the queue to accept the message';
      case 'dns':
        return 'Waiting for the DNS resolver';
      case 'cdn':
        return 'Waiting at the CDN';
      case 'waf':
        return 'Waiting at the WAF';
      case 'apiGateway':
        return 'Waiting at the API gateway';
      case 'readReplica':
        return 'Waiting for a replica slot';
      case 'kvStore':
        return 'Waiting for a key-value store slot';
      case 'objectStorage':
        return 'Waiting for an object storage slot';
      case 'eventStream': return 'Event stream';
      case 'pubsub':
        return 'Waiting for the topic to accept the event';
      default:
        return 'Waiting at the load balancer';
    }
  }

  private stationRequest(stationId: string, request: RequestState, op: StationOp): void {
    const station = this.stations.get(stationId);
    if (!station) return;
    const serviceMs = this.serviceTimeFor(request, op, stationId);

    if (station.hasFreeSlot) {
      station.occupy(this.now, serviceMs);
      this.queue.push(this.now + serviceMs, {
        t: 'serviceEnd',
        station: stationId,
        request: request.id,
        op,
      });
      return;
    }
    if (station.hasQueueRoom) {
      station.enqueue({ requestId: request.id, op, queuedAt: this.now }, this.now);
      this.trace(
        request,
        SimulationEngine.waitLabelFor(station.kind),
        `${station.queue.length} in queue`,
      );
      return;
    }
    station.rejected += 1;
    this.rejectRequest(request, SimulationEngine.rejectionFor(station.kind));
  }

  private onServiceEnd(stationId: string, requestId: number, op: StationOp): void {
    const station = this.stations.get(stationId);
    if (!station) return;
    station.release(this.now);

    // Start the next waiting job before returning this result, so the station
    // never sits idle with a non-empty queue.
    const nextJob = station.dequeue(this.now);
    if (nextJob) {
      const nextRequest = this.requests.get(nextJob.requestId);
      // A replication job outlives its request; everything else needs it.
      if (nextRequest || nextJob.op === 'replicaApply') {
        if (nextRequest) nextRequest.waitMs += this.now - nextJob.queuedAt;
        const serviceMs = nextRequest
          ? this.serviceTimeFor(nextRequest, nextJob.op, stationId)
          : station.applyMs;
        station.occupy(this.now, serviceMs);
        this.queue.push(this.now + serviceMs, {
          t: 'serviceEnd',
          station: stationId,
          request: nextJob.requestId,
          op: nextJob.op,
        });
      }
    }

    if (op === 'replicaApply') {
      station.applied += 1;
      return;
    }

    const request = this.requests.get(requestId);
    if (!request) return;
    const route = this.routes[request.routeIndex]!;

    if (op === 'dnsLookup') {
      if (route.dns) {
        this.send(route.dns.inChannel, request, 'dnsAnswer', route.dns.settings.answerBytes);
      }
      return;
    }

    if (op === 'edgeForward') {
      const hop = route.hops.find((h) => h.nodeId === stationId);
      if (!hop) return;
      if (hop.identity) { this.callSupport(hop.identity, request, 'gateway', hop.nodeId); return; }
      this.leaveHop(hop, station, request, route);
      return;
    }

    if (op === 'lbForward') {
      // The balancer has finished with it: pick a server, work out what that
      // server's path costs, and forward it.
      const index = this.chooseBranch(route);
      const branch = route.branches[index];
      if (!branch) return;
      request.branchIndex = index;
      this.prepareForBranch(request, branch);
      this.trace(
        request,
        'Forwarded by the load balancer',
        this.servers.get(branch.serverId)?.name ?? branch.serverId,
      );
      this.send(branch.serverInChannel, request, 'request', route.requestBytes);
      return;
    }

    const branch = this.branchOf(request);
    if (!branch) return;

    switch (op) {
      case 'cacheLookup': {
        if (request.cacheHit) {
          station.hits += 1;
          this.cacheHits += 1;
        } else {
          station.misses += 1;
          this.cacheMisses += 1;
        }
        // A hit returns the value; a miss returns a short negative reply,
        // modelled as the same size as the lookup key itself.
        const bytes = request.cacheHit
          ? branch.cacheSettings!.lookupResultBytes
          : branch.cacheSettings!.lookupRequestBytes;
        if (branch.cacheInChannel) this.send(branch.cacheInChannel, request, 'cacheResult', bytes);
        return;
      }
      case 'streamPublish': {
        const log = branch.streamId ? this.logs.get(branch.streamId) : null;
        if (!log) return;
        log.append(request.id, this.now); this.messagesPublished++;
        for (const b of this.backlogs.values()) if (b instanceof StreamBacklog && b.nodeId === branch.streamId) { b.changed(this.now); this.dispatchFromQueue(b.key); }
        this.scheduleJobMaintenance(branch.streamId!);
        if (branch.streamInChannel) this.send(branch.streamInChannel, request, 'streamAck', CONTROL_BYTES);
        return;
      }
      case 'queuePublish': {
        // The broker has taken the message. Whether it fits decides whether the
        // caller gets an answer at all: a full queue is refused, not silently
        // dropped, so backpressure is visible instead of hidden.
        const backlog = branch.queueId ? this.backlogs.get(branch.queueId) : undefined;
        if (!backlog) return;
        const accepted = backlog.push(
          { publishedBy: request.id, enqueuedAt: this.now },
          this.now,
        );
        if (!accepted) {
          this.trace(request, 'Queue was full');
          this.rejectRequest(request, 'queue-full');
          return;
        }
        this.messagesPublished += 1;
        if (branch.queueInChannel) this.send(branch.queueInChannel, request, 'queueAck', 0);
        this.dispatchFromQueue(branch.queueId!);
        return;
      }
      case 'dbQuery': {
        this.databaseQueries += 1;
        if (request.dbWrite) {
          station.writes += 1;
          // The write is on the primary; now it goes to every replica, and
          // nobody waits for that.
          for (const channel of branch.replicationChannels) {
            this.send(channel, request, 'replicate', branch.databaseSettings!.queryRequestBytes);
          }
        } else {
          station.reads += 1;
        }
        if (branch.dbInChannel) {
          this.send(
            branch.dbInChannel,
            request,
            'dbResult',
            branch.databaseSettings!.queryResultBytes,
          );
        }
        return;
      }
      case 'replicaQuery': {
        this.databaseQueries += 1;
        station.reads += 1;
        const replica = branch.replicas.find((r) => r.nodeId === stationId);
        if (replica) {
          this.send(replica.inChannel, request, 'dbResult', branch.databaseSettings!.queryResultBytes);
        }
        return;
      }
      case 'kvRead':
      case 'kvWrite': {
        if (op === 'kvWrite') station.writes += 1;
        else station.reads += 1;
        if (branch.kvInChannel) {
          this.send(
            branch.kvInChannel,
            request,
            'kvResult',
            op === 'kvWrite' ? CONTROL_BYTES : branch.kvSettings!.itemBytes,
          );
        }
        return;
      }
      case 'storageGet':
      case 'storagePut': {
        if (op === 'storagePut') station.writes += 1;
        else station.reads += 1;
        if (branch.storageInChannel) {
          this.send(
            branch.storageInChannel,
            request,
            'storageResult',
            op === 'storagePut' ? CONTROL_BYTES : branch.storageSettings!.objectBytes,
          );
        }
        return;
      }
      case 'topicPublish': {
        // The broker has the event. A copy goes to every subscriber's own
        // backlog; a full one drops its copy and counts it, and the publisher
        // is told nothing — which is exactly what makes a topic decoupled.
        if (branch.pubsubId) {
          for (const consumer of this.routing.consumers) {
            if (consumer.queueId !== branch.pubsubId) continue;
            const backlog = this.backlogs.get(consumer.backlogKey);
            if (!backlog) continue;
            const accepted = backlog.push({ publishedBy: request.id, enqueuedAt: this.now }, this.now);
            if (accepted) this.dispatchFromQueue(consumer.backlogKey);
            else station.dropped += 1;
          }
          this.messagesPublished += 1;
        }
        if (branch.pubsubInChannel) this.send(branch.pubsubInChannel, request, 'topicAck', 0);
        return;
      }
      case 'cachePopulate': {
        station.populates += 1;
        this.cachePopulates += 1;
        if (branch.cacheInChannel) {
          // The acknowledgement is a short reply, modelled at lookup-key size.
          this.send(
            branch.cacheInChannel,
            request,
            'cachePopulateAck',
            branch.cacheSettings!.lookupRequestBytes,
          );
        }
        return;
      }
    }
  }

  // ------------------------------------------------------- request lifecycle

  private completeRequest(request: RequestState, route: CompiledRoute): void {
    const total = this.now - request.createdAt;

    // A job is finished, not answered: nobody is waiting for it, so it does not
    // belong in the response-time figures a user would recognise. What it does
    // do is free the consumer, which is when the next message can be taken.
    if (route.kind === 'consumer' && route.queueId) {
      const backlog = route.backlogKey ? this.backlogs.get(route.backlogKey) : undefined;
      if (backlog && request.message) {
        backlog.finish(request.message.enqueuedAt, this.now, request.message);
        this.messagesProcessed += 1;
      }
      route.completed += 1;
      this.trace(request, 'Message processed', `${total.toFixed(2)} ms after publishing`);
      this.finishJourney(request, route, 'completed', total);
      this.requests.delete(request.id);
      if (route.backlogKey) this.dispatchFromQueue(route.backlogKey);
      return;
    }

    if (route.kind === 'scheduler') {
      route.completed++; route.responseStat.record(total); this.finishJourney(request, route, 'completed', total); this.requests.delete(request.id); return;
    }
    this.completed += 1;
    route.completed += 1;
    route.responseStat.record(total);
    this.responseStat.record(total);
    this.waitStat.record(request.waitMs);
    this.serviceStat.record(Math.max(0, total - request.waitMs));
    this.histogram.record(total);
    this.trace(request, 'Response received by client', `${total.toFixed(2)} ms end to end`);
    this.finishJourney(request, route, 'completed', total);
    this.scheduleThink(request, route);
    this.requests.delete(request.id);
  }

  private rejectRequest(request: RequestState, reason: RejectionReason): void {
    const route = this.routes[request.routeIndex]!;
    if (route.kind === 'client') {
      this.rejected += 1;
      this.rejectionsByReason[reason] = (this.rejectionsByReason[reason] ?? 0) + 1;
    }
    route.rejected += 1;
    const branch = this.branchOf(request);
    if (request.admitted && branch) {
      const server = this.servers.get(branch.serverId);
      if (server) {
        server.busyMsTotal += this.now - request.admittedAt;
        server.releaseAdmission(this.now);
        request.admitted = false;
        this.promoteFromQueue(server);
      }
    }
    this.trace(request, 'Rejected', REJECTION_LABELS[reason]);
    this.finishJourney(request, route, 'rejected', this.now - request.createdAt);
    // A turned-away user waits and tries again rather than vanishing, which is
    // what keeps a closed population constant under load.
    this.scheduleThink(request, route);
    this.requests.delete(request.id);
    if (route.kind === 'consumer' && route.backlogKey) {
      this.failJob(route, request);
      this.dispatchFromQueue(route.backlogKey);
    }
  }

  private scheduleSupport(nodeId: string, id: number, delay: number, waited: number): void {
    const request = this.requests.get(id); if (request) request.waitMs += waited;
    this.queue.push(this.now + delay, { t: 'supportEnd', nodeId, id });
  }
  private admitSupport(model: SupportServiceModel, id: number, caller: string, actor: string): void {
    const accepted = model.admit({ id, caller, actor, queuedAt: this.now, attempts: 0 }, this.now,
      (id, ms, wait) => this.scheduleSupport(model.node.id, id, ms, wait));
    const request = this.requests.get(id);
    if (!accepted && request) this.rejectRequest(request, 'support-queue-full');
  }
  private callSupport(call: SupportCall, request: RequestState, next: 'branch' | 'gateway', hopId?: string): void {
    const model = this.support.get(call.nodeId)!;
    request.pendingSupport = { call, next, hopId };
    const cached = model.cached(next === 'gateway' ? hopId! : this.branchOf(request)!.serverId, request.actor, this.now);
    if (cached === 'secret-expired') { this.rejectRequest(request, cached); return; }
    if (cached === 'allowed') { this.afterSupport(request); return; }
    const node = model.node;
    if ('requestBytes' in node.settings) this.send(call.outChannel, request, 'supportCall', node.settings.requestBytes);
  }
  private afterSupport(request: RequestState): void {
    const pending = request.pendingSupport; request.pendingSupport = null; if (!pending) return;
    if (pending.next === 'branch') { request.supportIndex++; this.beginCpuSegment(request); return; }
    const route = this.routes[request.routeIndex]!; const hop = route.hops.find(h => h.nodeId === pending.hopId)!;
    if (pending.next === 'gateway') this.leaveHop(hop, this.stations.get(hop.nodeId)!, request, route);
    else this.send(hop.outChannel, request, 'request', route.requestBytes);
  }
  private supportEnd(nodeId: string, id: number): void {
    const model = this.support.get(nodeId)!;
    const completed = model.finish(id, this.now, (id, ms, wait) => this.scheduleSupport(nodeId, id, ms, wait));
    if (!completed) return;
    this.scheduleJobMaintenance(nodeId);
    if (id < 0) {
      const channel = this.channels.get(completed.job.caller);
      if (channel) { channel.enqueue({ requestId: id, kind: 'supportAck', queuedAt: this.now, bytes: CONTROL_BYTES }, this.now); this.pump(channel); }
      return;
    }
    const request = this.requests.get(id); const pending = request?.pendingSupport;
    if (!request || !pending) return;
    if (pending.next === 'inline') {
      if (completed.failure) this.rejectRequest(request, completed.failure as RejectionReason); else this.afterSupport(request);
      return;
    }
    const channel = this.channels.get(pending.call.inChannel);
    if (channel) { channel.enqueue({ requestId: id, kind: 'supportReply', queuedAt: this.now, bytes: 'responseBytes' in model.node.settings ? model.node.settings.responseBytes : CONTROL_BYTES,
      ...(completed.failure ? { failure: completed.failure } : {}) }, this.now); this.pump(channel); }
  }
  private emitBackground(request: RequestState): void {
    const branch = this.branchOf(request); if (!branch) return;
    for (const call of branch.asyncCalls) {
      const model = this.support.get(call.nodeId)!; if (!model.shouldSample()) continue;
      const n = model.node; const bytes = n.kind === 'monitoring' ? n.settings.recordBytes : n.kind === 'notification' ? n.settings.payloadBytes : 0;
      const ch = this.channels.get(call.outChannel)!;
      ch.enqueue({ requestId: this.nextDetachedId--, kind: 'supportDetached', queuedAt: this.now, bytes }, this.now); this.pump(ch);
    }
  }
  private heartbeat(id: string): void {
    const model = this.support.get(id)!; const node = model.node; if (node.kind !== 'websocket') return;
    for (const [index, count] of model.heartbeat(this.now)) {
      const hop = this.routes[index]?.hops.find(h => h.nodeId === id); if (!hop) continue;
      for (const key of [hop.inChannel, hop.backChannel]) {
        const ch = this.channels.get(key)!; ch.enqueue({ requestId: this.nextDetachedId--, kind: 'heartbeat', queuedAt: this.now, bytes: count * node.settings.heartbeatBytes }, this.now); this.pump(ch);
      }
    }
    const at = this.now + node.settings.heartbeatSeconds * 1000;
    if (this.input.continuous || at < this.arrivalWindowMs) this.queue.push(at, { t: 'heartbeat', nodeId: id });
  }

  private scheduledTick(index: number): void {
    const route = this.routes[index]!;
    const settings = route.scheduler!;
    route.ticks++;
    const room = Math.max(0, Math.min(settings.maxConcurrentJobs - (route.offered - route.completed - route.rejected), this.input.limits.maxInFlightRequests - this.requests.size));
    const count = Math.min(settings.batchSize, room);
    route.skipped += settings.batchSize - count;
    for (let i = 0; i < count; i++) this.onArrival(index, -1);
    const at = (settings.startAfterSeconds + route.ticks * settings.intervalSeconds) * 1000;
    if (this.input.continuous || at < this.arrivalWindowMs) this.queue.push(at, { t: 'scheduledTick', route: index });
  }

  private failJob(route: CompiledRoute, request: RequestState): void {
    const b = this.backlogs.get(route.backlogKey!);
    if (!b || !request.message) return;
    const source = this.routing.graph.nodesById.get(route.queueId!);
    const attempts = request.message.attempts ?? 1;
    if (source?.kind === 'queue' && attempts < source.settings.maxAttempts && b instanceof QueueModel && b.reserveRetry()) {
      this.queue.push(this.now + source.settings.retryDelayMs, { t: 'retry', key: b.key, message: { ...request.message, attempts: attempts + 1 } });
      return;
    }
    b.fail(request.message);
    if (source?.kind !== 'queue') return;
    const e = (this.routing.graph.outgoing.get(source.id) ?? []).find(e => this.routing.graph.nodesById.get(e.target)?.kind === 'deadLetter');
    const ch = e ? this.channels.get(channelKey(e.id, FORWARD)) : undefined;
    if (ch) { ch.enqueue({ requestId: request.id, kind: 'deadLetter', bytes: source.settings.messageBytes, queuedAt: this.now, job: request.message }, this.now); this.pump(ch); }
  }

  private scheduleJobMaintenance(id: string): void {
    const b = this.backlogs.get(id);
    const next = this.support.get(id)?.nextMaintenance ?? this.logs.get(id)?.nextExpiryAt ?? (b instanceof DeadLetterModel ? b.nextExpiryAt : null);
    if (next === null || (!this.input.continuous && next > this.endTimeMs) || this.maintenanceAt.has(id)) return;
    this.maintenanceAt.set(id, next);
    this.queue.push(next, { t: 'jobMaintenance', nodeId: id });
  }

  private jobMaintenance(id: string): void {
    this.maintenanceAt.delete(id);
    this.logs.get(id)?.expire(this.now);
    this.support.get(id)?.maintain(this.now);
    const b = this.backlogs.get(id);
    if (b instanceof DeadLetterModel) b.expire(this.now);
    for (const group of this.backlogs.values()) if (group instanceof StreamBacklog && group.nodeId === id) group.changed(this.now);
    this.scheduleJobMaintenance(id);
  }

  private jobMetrics(): import('./types').JobServiceMetrics[] {
    const metrics: import('./types').JobServiceMetrics[] = [];
    for (const [id, log] of this.logs) {
      const groups = [...this.backlogs.values()].filter(b => b.nodeId === id);
      metrics.push({ nodeId: id, name: this.routing.graph.nodesById.get(id)!.name, kind: 'eventStream', accepted: log.published,
        completed: sum(groups.map(b => b.processed)), failed: sum(groups.map(b => b.failed + b.refused)), waiting: sum(groups.map(b => b.outstanding)),
        details: { retained: log.retained, expired: log.expired, evicted: log.evicted, groups: groups.length } });
    }
    for (const b of this.backlogs.values()) if (b instanceof DeadLetterModel) metrics.push({ nodeId: b.nodeId, name: b.name, kind: 'deadLetter',
      accepted: b.enqueued, completed: b.processed, failed: b.failed + b.refused, waiting: b.outstanding, details: { expired: b.expired, refused: b.refused } });
    for (const route of this.routes) if (route.scheduler) metrics.push({ nodeId: route.clientId, name: route.clientName, kind: 'scheduler', accepted: route.offered,
      completed: route.completed, failed: route.rejected, waiting: route.offered - route.completed - route.rejected,
      details: { ticks: route.ticks, skipped: route.skipped } });
    return metrics;
  }

  private trace(request: RequestState, label: string, detail?: string): void {
    if (!request.journey || request.journey.length >= 64) return;
    request.journey.push(detail ? { atMs: this.now, label, detail } : { atMs: this.now, label });
  }

  private finishJourney(
    request: RequestState,
    route: CompiledRoute,
    outcome: RequestJourney['outcome'],
    totalMs: number | null,
  ): void {
    if (!request.journey) return;
    this.journeys.push({
      requestId: request.id,
      clientName: route.clientName,
      startMs: request.createdAt,
      endMs: outcome === 'unfinished' ? null : this.now,
      outcome,
      totalMs,
      waitMs: request.waitMs,
      steps: request.journey,
    });
  }

  // ----------------------------------------------------------------- result

  result(): SimulationResult {
    const doc = this.input.document;
    if (this.status === 'invalid') {
      return this.emptyResult();
    }

    // For a run that finished, the measurement interval covers at least the
    // configured arrival window, so a slow trickle of traffic is not reported
    // as a high rate just because the last event happened early.
    //
    // For a run that was cut short (cancelled, or stopped at an execution
    // limit) the window never elapsed, so the honest denominator is the
    // simulated time actually reached. Using the configured window there would
    // divide the work done by time that never happened.
    const finishedNormally = this.finished && this.status === 'completed';
    const simulatedMs = finishedNormally
      ? Math.max(this.now, this.arrivalWindowMs)
      : Math.max(this.now, 0);
    const seconds = simulatedMs / 1000;

    const unfinishedByRoute = new Map<number, number>();
    const journeys = this.journeys.map(j => ({ ...j, steps: j.steps.map(s => ({ ...s })) }));
    const activeFunctionMs = new Map<string, number>();
    for (const request of this.requests.values()) {
      const route = this.routes[request.routeIndex]!;
      if (request.journey) journeys.push({
        requestId: request.id, clientName: route.clientName, startMs: request.createdAt,
        endMs: null, outcome: 'unfinished', totalMs: null, waitMs: request.waitMs,
        steps: request.journey.map(s => ({ ...s })),
      });
      const branch = this.branchOf(request);
      if (request.admitted && branch) activeFunctionMs.set(branch.serverId,
        (activeFunctionMs.get(branch.serverId) ?? 0) + this.now - request.admittedAt);
      unfinishedByRoute.set(
        request.routeIndex,
        (unfinishedByRoute.get(request.routeIndex) ?? 0) + 1,
      );
    }
    const unfinished = this.routes.filter(r => r.kind === 'client')
      .reduce((n, r) => n + (unfinishedByRoute.get(r.index) ?? 0), 0);

    const arrivalSeconds = (this.input.continuous ? simulatedMs : Math.min(simulatedMs, this.arrivalWindowMs)) / 1000;
    const clients: ClientMetrics[] = this.routes.filter(r => r.kind === 'client').map((route) => ({
      nodeId: route.clientId,
      name: route.clientName,
      mode: route.clientMode,
      offeredRatePerSecond: route.ratePerSecond,
      achievedRatePerSecond: arrivalSeconds > 0 ? route.offered / arrivalSeconds : 0,
      offered: route.offered,
      completed: route.completed,
      rejected: route.rejected,
      unfinished: unfinishedByRoute.get(route.index) ?? 0,
      meanResponseMs: route.responseStat.mean,
    }));

    const servers: ServerMetrics[] = [...this.servers.values()].map((s) => ({
      nodeId: s.nodeId,
      name: s.name,
      kind: s.kind,
      admitted: s.admitted,
      completed: s.completed,
      rejected: s.rejected,
      cpuUtilisation: s.cpuSlots > 0 ? s.cpuBusyAcc.timeAverage(simulatedMs) / s.cpuSlots : 0,
      cpuSlots: s.cpuSlots,
      busySlotsAverage: s.cpuBusyAcc.timeAverage(simulatedMs),
      concurrencyAverage: s.concurrencyAcc.timeAverage(simulatedMs),
      concurrencyPeak: s.concurrencyAcc.peak,
      concurrencyLimit: s.concurrencyLimit,
      admissionQueueAverage: s.admissionQueueAcc.timeAverage(simulatedMs),
      admissionQueuePeak: s.admissionQueueAcc.peak,
      cpuQueueAverage: s.cpuQueueAcc.timeAverage(simulatedMs),
      cpuQueuePeak: s.cpuQueueAcc.peak,
      peakMemoryMb: s.memoryAcc.peak,
      memoryLimitMb: s.ramMb,
      cpuServiceMsTotal: s.cpuServiceMsTotal,
      admissionWaitMsTotal: s.admissionWaitMsTotal,
      cpuWaitMsTotal: s.cpuWaitMsTotal,
      ...(s.kind === 'serverless'
        ? { coldStarts: s.coldStarts, throttled: s.throttled, busyMsTotal: s.busyMsTotal + (activeFunctionMs.get(s.nodeId) ?? 0) }
        : {}),
    }));

    const stations: StationMetrics[] = [...this.stations.values()].map((st) => {
      const base: StationMetrics = {
        nodeId: st.nodeId,
        name: st.name,
        kind: st.kind,
        operations: st.operations,
        rejected: st.rejected,
        utilisation: st.slots > 0 ? st.busyAcc.timeAverage(simulatedMs) / st.slots : 0,
        slots: st.slots,
        queueAverage: st.queueAcc.timeAverage(simulatedMs),
        queuePeak: st.queueAcc.peak,
        serviceMsTotal: st.serviceMsTotal,
        waitMsTotal: st.waitMsTotal,
      };
      if (st.kind === 'cache' || st.kind === 'cdn') {
        const lookups = st.hits + st.misses;
        base.hits = st.hits;
        base.misses = st.misses;
        base.populates = st.populates;
        base.achievedHitRate = lookups > 0 ? st.hits / lookups : 0;
      }
      if (st.kind === 'waf') base.blocked = st.blocked;
      if (st.kind === 'apiGateway') base.throttled = st.throttled;
      if (st.kind === 'database' || st.kind === 'kvStore' || st.kind === 'objectStorage') {
        base.reads = st.reads;
        base.writes = st.writes;
      }
      if (st.kind === 'readReplica') {
        base.reads = st.reads;
        base.applied = st.applied;
      }
      if (st.kind === 'pubsub') base.dropped = st.dropped;
      return base;
    });

    const links: LinkMetrics[] = [...this.channels.values()]
      .map((c) => {
        const edge = doc.edges.find((e) => e.id === c.edgeId);
        return {
          channelKey: c.key,
          edgeId: c.edgeId,
          fromId: c.fromId,
          toId: c.toId,
          fromName: this.routing.graph.nodesById.get(c.fromId)?.name ?? c.fromId,
          toName: this.routing.graph.nodesById.get(c.toId)?.name ?? c.toId,
          messages: c.messages,
          bytes: c.bytes,
          utilisation: c.busyAcc.timeAverage(simulatedMs),
          queueAverage: c.queueAcc.timeAverage(simulatedMs),
          queuePeak: c.queueAcc.peak,
          transmissionMsTotal: c.transmissionMsTotal,
          waitMsTotal: c.waitMsTotal,
          bandwidthMbps: edge?.settings.bandwidthMbps ?? 0,
          propagationDelayMs: edge?.settings.propagationDelayMs ?? 0,
        };
      })
      .filter((l) => l.messages > 0 || l.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);

    const clientIds = new Set(
      doc.nodes.filter((n) => n.kind === 'client').map((n) => n.id),
    );
    let bytesTotal = 0;
    let bytesEgress = 0;
    const egressByNodeId: Record<string, number> = {};
    for (const c of this.channels.values()) {
      bytesTotal += c.bytes;
      if (clientIds.has(c.toId)) {
        bytesEgress += c.bytes;
        egressByNodeId[c.fromId] = (egressByNodeId[c.fromId] ?? 0) + c.bytes;
      }
    }

    const dataServices = [...this.dataServices.values()].map((s) => s.snapshot(simulatedMs));
    const waitByStageMs: Record<WaitStage, number> = {
      serverAdmission: sum(servers.map((s) => s.admissionWaitMsTotal)),
      serverCpu: sum(servers.map((s) => s.cpuWaitMsTotal)),
      balancer: sum(stations.filter((s) => s.kind === 'loadBalancer').map((s) => s.waitMsTotal)),
      database: sum(stations.filter((s) => s.kind === 'database').map((s) => s.waitMsTotal)) + sum(dataServices.map((s) => s.waitMsTotal)),
      cache: sum(stations.filter((s) => s.kind === 'cache').map((s) => s.waitMsTotal)),
      queue: sum(stations.filter((s) => s.kind === 'queue').map((s) => s.waitMsTotal)),
      edge: sum(
        stations
          .filter((s) => s.kind === 'cdn' || s.kind === 'waf' || s.kind === 'apiGateway')
          .map((s) => s.waitMsTotal),
      ),
      dns: sum(stations.filter((s) => s.kind === 'dns').map((s) => s.waitMsTotal)),
      replica: sum(stations.filter((s) => s.kind === 'readReplica').map((s) => s.waitMsTotal)),
      kv: sum(stations.filter((s) => s.kind === 'kvStore').map((s) => s.waitMsTotal)),
      storage: sum(stations.filter((s) => s.kind === 'objectStorage').map((s) => s.waitMsTotal)),
      pubsub: sum(stations.filter((s) => s.kind === 'pubsub').map((s) => s.waitMsTotal)),
      network: sum([...this.channels.values()].map((c) => c.waitMsTotal)),
    };

    // A queue's own figures: what went in, what came out, and — the number that
    // makes an asynchronous design worth drawing — what is still waiting.
    const queues: QueueMetrics[] = [...this.backlogs.values()].map((backlog) => {
      const routeIndex = this.consumerRouteByQueue.get(backlog.key);
      const consumerBranch =
        routeIndex !== undefined ? this.routes[routeIndex]?.branches[0] : undefined;
      const consumer = consumerBranch ? this.servers.get(consumerBranch.serverId) : undefined;
      return {
        nodeId: backlog.nodeId,
        name: backlog.name,
        consumerId: consumer?.nodeId ?? null,
        consumerName: consumer?.name ?? null,
        enqueued: backlog.enqueued,
        processed: backlog.processed,
        failed: backlog.failed,
        kind: this.routing.graph.nodesById.get(backlog.nodeId)!.kind as QueueMetrics['kind'],
        retries: backlog instanceof QueueModel ? backlog.retries : 0, retrying: backlog instanceof QueueModel ? backlog.retrying : 0, expired: backlog instanceof DeadLetterModel ? backlog.expired : 0,
        refused: backlog.refused,
        outstanding: backlog.outstanding,
        maxDepth: backlog.maxDepth,
        depthAverage: backlog.depthAcc.timeAverage(simulatedMs),
        depthPeak: backlog.depthAcc.peak,
        backlogWaitMsTotal: backlog.backlogWaitMsTotal,
        meanLatencyMs: backlog.latency.mean,
      };
    });

    // Consumer routes carry jobs, not traffic a user offered.
    const offeredRate = sum(
      this.routes.filter((r) => r.kind === 'client').map((r) => r.ratePerSecond),
    );

    const result: SimulationResult = {
      engineVersion: ENGINE_VERSION,
      seed: doc.workload.seed,
      status: this.finished ? this.status : 'running',
      statusReason: this.statusReason,
      simulatedMs,
      arrivalWindowMs: this.arrivalWindowMs,
      drainMs: this.drainMs,
      eventsProcessed: this.eventsProcessed,
      offered: this.offered,
      completed: this.completed,
      rejected: this.rejected,
      unfinished,
      rejectionsByReason: { ...this.rejectionsByReason },
      offeredRatePerSecond: offeredRate,
      arrivalPattern: doc.workload.arrivalPattern,
      queues,
      messagesPublished: this.messagesPublished,
      messagesProcessed: this.messagesProcessed,
      throughputPerSecond: seconds > 0 ? this.completed / seconds : 0,
      throughputWindowMs: simulatedMs,
      responseTime: {
        meanMs: this.responseStat.mean,
        minMs: this.responseStat.count > 0 ? this.responseStat.min : 0,
        maxMs: this.responseStat.count > 0 ? this.responseStat.max : 0,
        p95: this.histogram.quantile(0.95),
      },
      meanServiceMs: this.serviceStat.mean,
      meanWaitMs: this.waitStat.mean,
      waitByStageMs,
      clients,
      servers,
      stations,
      dataServices,
      jobServices: this.jobMetrics(),
      supportServices: [...this.support.values()].map(s => s.snapshot(simulatedMs)),
      links,
      databaseQueries: this.databaseQueries,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cachePopulates: this.cachePopulates,
      bytesTransferred: bytesTotal,
      bytesEgressToClients: bytesEgress,
      journeys,
      usage: {
        measuredSeconds: seconds,
        egressBytes: bytesEgress,
        totalBytes: bytesTotal,
        completedRequests: this.completed,
        egressByNodeId,
        // What each metered component handled: messages for a queue, and
        // requests seen for the components in front — every request they
        // looked at, whether they answered it, refused it, or passed it on.
        requestsByNodeId: Object.fromEntries([
          ...dataServices.map((s) => [s.nodeId, s.reads + s.writes] as const),
          ...[...this.support.values()].map(s => [s.node.id, s.details.attempts ?? 0] as const),
          ...this.routes.filter(r => r.scheduler).map(r => [r.clientId, r.offered] as const),
          ...[...this.backlogs.values()]
            .filter((b) => b.key === b.nodeId)
            .map((b) => [b.nodeId, b.enqueued] as const),
          // A topic bills each publish once, however many subscribers copy it.
          ...[...this.stations.values()]
            .filter((st) => st.kind === 'pubsub' || st.kind === 'eventStream')
            .map((st) => [st.nodeId, st.operations] as const),
          ...[...this.stations.values()]
            .filter(
              (st) =>
                st.kind === 'dns' ||
                st.kind === 'cdn' ||
                st.kind === 'waf' ||
                st.kind === 'apiGateway' ||
                st.kind === 'kvStore' ||
                st.kind === 'objectStorage',
            )
            .map((st) => [st.nodeId, st.operations] as const),
          ...[...this.servers.values()]
            .filter((s) => s.kind === 'serverless')
            .map((s) => [s.nodeId, s.admitted] as const),
        ]),
        scannedGbByNodeId: Object.fromEntries(dataServices.filter((s) => s.kind === 'warehouse').map((s) => [s.nodeId, s.details.scannedGb ?? 0])),
        writesByNodeId: Object.fromEntries([
          ...dataServices.map((s) => [s.nodeId, s.writes] as const),
          ...[...this.stations.values()]
            .filter((st) => st.kind === 'kvStore' || st.kind === 'objectStorage')
            .map((st) => [st.nodeId, st.writes] as const),
        ]),
        busyMsByNodeId: Object.fromEntries(
          [...this.servers.values()]
            .filter((s) => s.kind === 'serverless')
            .map((s) => [s.nodeId, s.busyMsTotal + (activeFunctionMs.get(s.nodeId) ?? 0)] as const),
        ),
      },
      assumptions: this.buildAssumptions(),
      findings: [],
      issues: this.routing.issues,
    };
    result.findings = buildFindings(result);
    return result;
  }

  private emptyResult(): SimulationResult {
    const doc = this.input.document;
    const empty = { count: 0, sum: 0, mean: 0, min: 0, max: 0 };
    void empty;
    return {
      engineVersion: ENGINE_VERSION,
      seed: doc.workload.seed,
      status: 'invalid',
      statusReason: this.statusReason,
      simulatedMs: 0,
      arrivalWindowMs: this.arrivalWindowMs,
      drainMs: this.drainMs,
      eventsProcessed: 0,
      offered: 0,
      completed: 0,
      rejected: 0,
      unfinished: 0,
      rejectionsByReason: {},
      offeredRatePerSecond: 0,
      arrivalPattern: doc.workload.arrivalPattern,
      throughputPerSecond: 0,
      throughputWindowMs: 0,
      responseTime: {
        meanMs: 0,
        minMs: 0,
        maxMs: 0,
        p95: {
          value: 0,
          lowerBound: 0,
          upperBound: 0,
          relativePrecision: 0.15,
          sampleCount: 0,
        },
      },
      meanServiceMs: 0,
      meanWaitMs: 0,
      waitByStageMs: {
        balancer: 0,
        serverAdmission: 0,
        serverCpu: 0,
        database: 0,
        cache: 0,
        queue: 0,
        edge: 0,
        dns: 0,
        replica: 0,
        kv: 0,
        storage: 0,
        pubsub: 0,
        network: 0,
      },
      clients: [],
      servers: [],
      stations: [],
      queues: [],
      links: [],
      messagesPublished: 0,
      messagesProcessed: 0,
      databaseQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cachePopulates: 0,
      bytesTransferred: 0,
      bytesEgressToClients: 0,
      journeys: [],
      usage: {
        measuredSeconds: 0,
        egressBytes: 0,
        totalBytes: 0,
        completedRequests: 0,
        egressByNodeId: {},
        requestsByNodeId: {},
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
      assumptions: this.buildAssumptions(),
      findings: [],
      issues: this.routing.issues,
    };
  }

  private buildAssumptions(): string[] {
    const list = [
      'One user action produces exactly one request.',
      'Traffic is generated at a constant rate and does not wait for earlier responses to complete. Individual user sessions are not modelled.',
      'CPU work per request is spread evenly across the compute segments between downstream calls, so the total CPU cost per request is unchanged by how many calls it makes.',
      'A request waiting on a database or cache releases its CPU slot but keeps its application concurrency slot and its memory.',
      'Network links transfer one message at a time in each direction: transfer time is message bits divided by bandwidth, plus the one-way propagation delay. There is no congestion control and no packet-level behaviour.',
      'Queued requests are charged the configured per-queued-request memory. A request is rejected if admitting or queueing it would exceed the server memory budget.',
    ];
    if (this.routes.some((r) => r.loadBalancerId)) {
      list.push(
        'A load balancer forwards requests; it never computes an answer. Its service time and concurrency limit are charged once, on the way in, and the response passes back through it without queueing again.',
        'Requests are spread across servers by the configured policy alone. Health checks, connection reuse, sticky sessions and retries are not modelled.',
      );
    }
    const hasCache = this.routes.some((r) => r.branches.some((b) => b.cacheId));
    if (hasCache) {
      list.push(
        'Cache hits are sampled from the configured hit rate using a dedicated random stream. Populating the cache does not change the hit rate in this version.',
        'The server waits for the cache write to be acknowledged before answering the client.',
        'A cache miss returns a short negative reply, modelled at the same size as the lookup key.',
      );
    }
    const hasDb = this.routes.some((r) => r.branches.some((b) => b.databaseId));
    if (hasDb) {
      list.push(
        'One database read happens per uncached request or cache miss. Stored data size affects storage cost only; it does not change query service time.',
      );
    }
    return list;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * How much of the configured rate is offered at one point in the run.
 *
 * `ramp` and `burst` vary the rate and keep the spacing even at whatever rate is
 * current, which is an approximation: it reads the rate at the moment a request
 * is created rather than integrating across the interval. For a burst, which is
 * piecewise constant, the difference only ever shows at an edge; for a ramp it
 * is a first-order approximation and the gentler the ramp the better it holds.
 * Neither draws a random number, so both stay reproducible without a seed.
 */
export function arrivalRateMultiplier(
  workload: Workload,
  atMs: number,
  windowMs: number,
): number {
  const options = workload.arrivalOptions;
  switch (workload.arrivalPattern) {
    case 'ramp': {
      if (windowMs <= 0) return options.rampStartMultiplier;
      const through = Math.min(1, Math.max(0, atMs / windowMs));
      return (
        options.rampStartMultiplier +
        (options.rampEndMultiplier - options.rampStartMultiplier) * through
      );
    }
    case 'burst': {
      const periodMs = options.burstPeriodSeconds * 1000;
      if (periodMs <= 0) return options.burstMultiplier;
      // A burst longer than its own period is a permanently raised rate.
      const durationMs = Math.min(options.burstDurationSeconds * 1000, periodMs);
      return atMs % periodMs < durationMs ? options.burstMultiplier : 1;
    }
    // Poisson varies the spacing, not the rate.
    case 'constant':
    case 'poisson':
    default:
      return 1;
  }
}

/**
 * The average multiplier across the whole window.
 *
 * Used for the two places that need to guess a total before the run: how many
 * requests to expect (which sets the journey-sampling stride) and the estimate
 * printed beside the offered rate.
 */
export function meanArrivalMultiplier(workload: Workload): number {
  const options = workload.arrivalOptions;
  switch (workload.arrivalPattern) {
    case 'ramp':
      return (options.rampStartMultiplier + options.rampEndMultiplier) / 2;
    case 'burst': {
      if (options.burstPeriodSeconds <= 0) return options.burstMultiplier;
      const duty = Math.min(
        1,
        Math.max(0, options.burstDurationSeconds / options.burstPeriodSeconds),
      );
      return options.burstMultiplier * duty + (1 - duty);
    }
    case 'constant':
    case 'poisson':
    default:
      return 1;
  }
}

export function clientRequestRate(client: ClientNode): number {
  const s = client.settings;
  // Closed mode is checked first: there is no configured rate to override.
  if (s.mode === 'closed') {
    // A steady state, not a setting. Each user sends again one think time after
    // its answer arrives, so this is where the rate settles if answers are
    // instant. It is not a hard cap: nobody has thought yet at the start of a
    // run, so a short one offers more. The real figure is measured during the
    // run and reported separately.
    const thinkSeconds = s.thinkTimeMs / 1000;
    return thinkSeconds > 0 ? s.activeUsers / thinkSeconds : 0;
  }
  if (s.requestRateOverridePerSecond !== null && s.requestRateOverridePerSecond >= 0) {
    return s.requestRateOverridePerSecond;
  }
  return (s.activeUsers * s.actionsPerUserPerMinute) / 60;
}

function countDownstreamCalls(branch: CompiledBranch, request: RequestState): number {
  const cacheHit = branch.cacheId !== null && request.cacheHit;
  let calls = branch.dataServices.length + branch.supportCalls.length;
  if (branch.cacheId) {
    calls += 1; // the lookup
    if (!cacheHit) {
      if (branch.databaseId) calls += 1;
      if (branch.cacheSettings?.populateOnMiss) calls += 1;
    }
  } else if (branch.databaseId) {
    calls += 1;
  }
  // A key-value read is answered by a cache hit; a write is not.
  if (branch.kvId && (request.kvWrite || !cacheHit)) calls += 1;
  if (branch.storageId) calls += 1;
  // Publishing is a call like any other: the server waits for the broker to
  // acknowledge before it carries on, so it splits the CPU work once more.
  if (branch.queueId) calls += 1;
  if (branch.pubsubId) calls += 1;
  if (branch.streamId) calls += 1;
  return calls;
}

/**
 * Turn measured numbers into plain-language observations.
 *
 * Every finding must be traceable to a metric that is also displayed. No
 * finding claims a benefit from a change that was not actually simulated.
 */
export function buildFindings(result: SimulationResult): Finding[] {
  const findings: Finding[] = [];

  if (result.status === 'incomplete') {
    findings.push({
      id: 'run-incomplete',
      severity: 'warning',
      title: 'This run did not cover the whole configured duration',
      detail: result.statusReason ?? 'A simulation execution limit was reached.',
    });
  }

  const stages = Object.entries(result.waitByStageMs) as [WaitStage, number][];
  const totalWait = stages.reduce((acc, [, v]) => acc + v, 0);
  const worst = stages.slice().sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 0 && totalWait > 0) {
    const share = worst[1] / totalWait;
    findings.push({
      id: 'wait-hotspot',
      severity: share > 0.6 ? 'warning' : 'info',
      title: `Most waiting happened ${WAIT_STAGE_LABELS[worst[0]]}`,
      detail: `${(share * 100).toFixed(0)}% of all measured waiting time (${worst[1].toFixed(0)} ms of ${totalWait.toFixed(0)} ms) was spent ${WAIT_STAGE_LABELS[worst[0]]}.`,
    });
  } else if (result.completed > 0) {
    findings.push({
      id: 'no-waiting',
      severity: 'info',
      title: 'No request had to wait',
      detail:
        'No request spent measurable time in a queue. Response time is made up entirely of service and network time.',
    });
  }

  // A backlog is not a request waiting, so none of the figures above see it.
  // Saying "nothing had to wait" while a queue is filling would be the single
  // most misleading sentence Aparecium could print.
  for (const queue of result.queues) {
    if (queue.refused > 0) {
      findings.push({
        id: `queue-refused-${queue.nodeId}`,
        severity: 'warning',
        title: `"${queue.name}" refused ${queue.refused} of ${queue.enqueued + queue.refused} messages`,
        detail: `The backlog reached its limit of ${queue.maxDepth}, so those publishes failed and the requests behind them were rejected. ${queue.consumerName ? `"${queue.consumerName}" finished ${queue.processed}.` : ''} Either the consumer needs more capacity or the queue needs more room — but a deeper queue only delays the same problem.`,
      });
    } else if (queue.outstanding > 0) {
      const share = queue.enqueued > 0 ? queue.outstanding / queue.enqueued : 0;
      findings.push({
        id: `queue-backlog-${queue.nodeId}`,
        severity: share >= 0.1 ? 'warning' : 'info',
        title: `"${queue.name}" still had ${queue.outstanding} messages waiting when the run ended`,
        detail: `${queue.enqueued} were published and ${queue.processed} were finished${queue.consumerName ? ` by "${queue.consumerName}"` : ''}, leaving ${queue.outstanding}. The backlog peaked at ${Math.round(queue.depthPeak)}. Requests were answered without waiting for any of this, which is the point of a queue — but work that is still waiting is not work that is done.`,
      });
    } else if (queue.enqueued > 0) {
      findings.push({
        id: `queue-kept-up-${queue.nodeId}`,
        severity: 'info',
        title: `"${queue.name}" kept up`,
        detail: `All ${queue.enqueued} messages were finished${queue.consumerName ? ` by "${queue.consumerName}"` : ''} within the run, taking ${queue.meanLatencyMs.toFixed(0)} ms each on average from being published to being done. The backlog peaked at ${Math.round(queue.depthPeak)}.`,
      });
    }
  }

  for (const server of result.servers) {
    if (server.cpuUtilisation >= 0.85) {
      findings.push({
        id: `cpu-busy-${server.nodeId}`,
        severity: 'warning',
        title: `"${server.name}" CPU was busy ${(server.cpuUtilisation * 100).toFixed(0)}% of the time`,
        detail: `Averaged over the measured interval, ${server.busySlotsAverage.toFixed(2)} of ${server.cpuSlots} CPU slots were in use. The CPU waiting queue peaked at ${server.cpuQueuePeak}.`,
      });
    }
    if (server.peakMemoryMb >= server.memoryLimitMb * 0.9) {
      findings.push({
        id: `memory-tight-${server.nodeId}`,
        severity: 'warning',
        title: `"${server.name}" came close to its memory budget`,
        detail: `Modelled peak memory was ${server.peakMemoryMb.toFixed(0)} MB of ${server.memoryLimitMb.toFixed(0)} MB.`,
      });
    }
  }

  for (const station of result.stations) {
    if (station.utilisation >= 0.85) {
      findings.push({
        id: `station-busy-${station.nodeId}`,
        severity: 'warning',
        title: `"${station.name}" was busy ${(station.utilisation * 100).toFixed(0)}% of the time`,
        detail: `Its ${station.slots} slot(s) served ${station.operations} operations; the waiting queue peaked at ${station.queuePeak}.`,
      });
    }
  }

  for (const link of result.links) {
    if (link.utilisation >= 0.8) {
      findings.push({
        id: `link-busy-${link.channelKey}`,
        severity: 'warning',
        title: `The link ${link.fromName} to ${link.toName} was transmitting ${(link.utilisation * 100).toFixed(0)}% of the time`,
        detail: `${(link.bytes / 1e6).toFixed(2)} MB moved at ${link.bandwidthMbps} Mbps. Messages waited ${link.waitMsTotal.toFixed(0)} ms in total for the link to be free.`,
      });
    }
  }

  if (result.rejected > 0) {
    const parts = Object.entries(result.rejectionsByReason).map(
      ([reason, count]) => `${count} x ${REJECTION_LABELS[reason as RejectionReason]}`,
    );
    findings.push({
      id: 'rejections',
      severity: 'warning',
      title: `${result.rejected} requests were rejected`,
      detail: parts.join('; ') + '.',
    });
  }

  if (result.unfinished > 0) {
    findings.push({
      id: 'unfinished',
      severity: result.status === 'running' ? 'info' : 'warning',
      title: `${result.unfinished} requests ${result.status === 'running' ? 'are in flight' : 'were still in the system when the run stopped'}`,
      detail: result.status === 'running'
        ? 'These requests are still being processed. They have not failed.'
        : 'These requests had not finished at the time of this snapshot.',
    });
  }

  const cache = result.stations.find((s) => s.kind === 'cache');
  if (cache && cache.achievedHitRate !== undefined && (cache.hits ?? 0) + (cache.misses ?? 0) > 0) {
    findings.push({
      id: 'cache-hit-rate',
      severity: 'info',
      title: `"${cache.name}" served ${cache.hits} hits and ${cache.misses} misses`,
      detail: `That is an observed hit rate of ${(cache.achievedHitRate * 100).toFixed(1)}%, sampled from the configured rate. ${result.databaseQueries} database queries were issued.`,
    });
  }

  // ---- Edge components: each one's own number ---------------------------
  // A CDN is judged by what it kept off the origin, a WAF by what it turned
  // away, a gateway by what it refused, a DNS by how many had to ask. None of
  // these is a fault; they are the reason the component is on the canvas.
  for (const cdn of result.stations.filter((s) => s.kind === 'cdn')) {
    const seen = (cdn.hits ?? 0) + (cdn.misses ?? 0);
    if (seen === 0) continue;
    findings.push({
      id: `cdn-hit-rate:${cdn.nodeId}`,
      severity: 'info',
      title: `"${cdn.name}" answered ${cdn.hits} of ${seen} requests at the edge`,
      detail: `That is an observed hit rate of ${((cdn.achievedHitRate ?? 0) * 100).toFixed(1)}%, sampled from the configured rate. Only the ${cdn.misses} misses reached the origin, so everything behind the CDN saw that much load.`,
    });
  }
  for (const waf of result.stations.filter((s) => s.kind === 'waf')) {
    if (waf.operations === 0) continue;
    findings.push({
      id: `waf-blocked:${waf.nodeId}`,
      severity: 'info',
      title: `"${waf.name}" blocked ${waf.blocked ?? 0} of ${waf.operations} requests`,
      detail:
        (waf.blocked ?? 0) > 0
          ? 'Blocked requests count as rejected, under their own reason, and never reached anything behind the firewall. The share is the configured assumption, sampled with the run seed.'
          : 'Nothing was blocked: the configured block share is zero, or too small to show in a run this short.',
    });
  }
  for (const gateway of result.stations.filter((s) => s.kind === 'apiGateway')) {
    const throttled = gateway.throttled ?? 0;
    if (throttled === 0) continue;
    findings.push({
      id: `gateway-throttled:${gateway.nodeId}`,
      severity: 'warning',
      title: `"${gateway.name}" refused ${throttled} requests over its rate limit`,
      detail: `${gateway.operations - throttled} were forwarded. The limit protected everything behind the gateway from the excess, but those users were turned away: raise the limit or the burst allowance if the load is legitimate, or add capacity behind it and then raise the limit.`,
    });
  }
  for (const replica of result.stations.filter((s) => s.kind === 'readReplica')) {
    if (replica.operations === 0 && (replica.applied ?? 0) === 0) continue;
    findings.push({
      id: `replica:${replica.nodeId}`,
      severity: replica.queuePeak > replica.slots ? 'warning' : 'info',
      title: `"${replica.name}" answered ${replica.reads ?? 0} reads and applied ${replica.applied ?? 0} writes`,
      detail: `Every write that reached the primary was copied here and took the replica's own time to apply, so a replica adds read capacity and none for writes. Its line peaked at ${Math.round(replica.queuePeak)}${replica.queuePeak > replica.slots ? ' — reads and replication were competing for the same slots, which is how a replica falls behind' : ''}.`,
    });
  }
  for (const fn of (result.servers ?? []).filter((s) => s.kind === 'serverless')) {
    if (fn.admitted === 0 && (fn.throttled ?? 0) === 0) continue;
    const seconds = (fn.busyMsTotal ?? 0) / 1000;
    findings.push({
      id: `function:${fn.nodeId}`,
      severity: (fn.throttled ?? 0) > 0 ? 'warning' : 'info',
      title: `"${fn.name}" ran ${fn.admitted} invocations, ${fn.coldStarts ?? 0} of them from cold`,
      detail: `Invocations were alive for ${seconds.toFixed(1)} seconds in total — the time billed, waiting on stores included — and peaked at ${fn.concurrencyPeak} at once.${(fn.throttled ?? 0) > 0 ? ` ${fn.throttled} were refused at the concurrency limit of ${fn.concurrencyLimit}: a function never queues, so the limit is the whole capacity.` : ''}`,
    });
  }
  for (const topic of result.stations.filter((s) => s.kind === 'pubsub')) {
    if (topic.operations === 0) continue;
    const subscriptions = result.queues.filter((q) => q.nodeId === topic.nodeId);
    findings.push({
      id: `topic:${topic.nodeId}`,
      severity: (topic.dropped ?? 0) > 0 ? 'warning' : 'info',
      title: `"${topic.name}" delivered ${topic.operations} events to ${subscriptions.length} listener${subscriptions.length === 1 ? '' : 's'}`,
      detail:
        (topic.dropped ?? 0) > 0
          ? `${topic.dropped} copies were dropped because a subscription was full. The publisher was never told: a topic decouples the two, so a slow listener loses events rather than slowing the publisher.`
          : 'Each listener got its own copy and worked through it at its own pace; the publisher waited only for the broker to take the event.',
    });
  }
  for (const dns of result.stations.filter((s) => s.kind === 'dns')) {
    if (dns.operations === 0) continue;
    findings.push({
      id: `dns-lookups:${dns.nodeId}`,
      severity: 'info',
      title: `"${dns.name}" answered ${dns.operations} lookups`,
      detail: `Only requests without a cached answer ask the resolver: the configured share, sampled with the run seed. Each lookup added ${dns.operations > 0 ? (dns.serviceMsTotal / dns.operations).toFixed(1) : '0'} ms on average before the request set off.`,
    });
  }

  return findings;
}

export function runSimulation(
  document: ArchitectureDocument,
  limits = DEFAULT_LIMITS,
): SimulationResult {
  return new SimulationEngine({ document, limits }).runToCompletion();
}
