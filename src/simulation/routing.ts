import { DEPENDENCY_SUPPORT, ASYNC_SUPPORT } from '../domain/support-services';
import { DATA_KINDS, isDataKind } from '../domain/data-services';
/**
 * Turning a drawing into a runnable route.
 *
 * On the canvas a connection only means "these two *can* talk". It never means
 * "send everything to everyone". This module walks the graph, decides whether
 * each group of users has one unambiguous operation path, and explains in plain
 * language when it does not.
 *
 * Representation at runtime:
 *   - a Map from component id to component (O(1) lookup),
 *   - adjacency lists in both directions (O(1) neighbour listing),
 *   - a breadth-first walk from the clients for reachability.
 */
import { COMPUTE_KINDS, EDGE_KINDS } from '../domain/types';
import type {
  ComputeKind, EdgeKind, ArchEdge, ArchNode, ArchitectureDocument, ComponentKind } from '../domain/types';
import { COMPONENT_LABELS } from '../domain/defaults';

export interface ArchitectureGraph {
  nodesById: Map<string, ArchNode>;
  outgoing: Map<string, ArchEdge[]>;
  incoming: Map<string, ArchEdge[]>;
  edges: ArchEdge[];
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  hint?: string;
  nodeIds?: string[];
  edgeIds?: string[];
}

/** A read replica a server reads from, and the link the primary replicates over. */
export interface ReplicaLink {
  replicaId: string;
  /** Server -> replica: the read query and its result. */
  serverReplicaEdgeId: string;
  /** Database -> replica: each write, applied a moment after it lands on the primary. */
  replicationEdgeId: string;
}

/**
 * One compute node on a route — an Application Server or a Serverless
 * Function — with whatever it can call behind it.
 */
export interface ServerBranch {
  supportCalls: { nodeId: string; edgeId: string }[];
  asyncCalls: { nodeId: string; edgeId: string }[];
  streamId: string | null;
  serverStreamEdgeId: string | null;
  dataServices: { nodeId: string; edgeId: string }[];
  serverId: string;
  computeKind: ComputeKind;
  cacheId: string | null;
  databaseId: string | null;
  /** The queue this server publishes to, if any. */
  queueId: string | null;
  /** The topic this server publishes to, if any. */
  pubsubId: string | null;
  kvStoreId: string | null;
  objectStorageId: string | null;
  /** Read replicas of this server's database that it reads from. */
  replicas: ReplicaLink[];
  /** Link from whatever sends to this server (the client, or the balancer). */
  inboundEdgeId: string;
  serverCacheEdgeId: string | null;
  serverDatabaseEdgeId: string | null;
  serverQueueEdgeId: string | null;
  serverPubSubEdgeId: string | null;
  serverKvStoreEdgeId: string | null;
  serverObjectStorageEdgeId: string | null;
}

/**
 * A queue and the one server that works through it.
 *
 * The consumer is an ordinary Application Server, resolved with exactly the
 * same rules as one serving users, so a worker gets its own cache and database
 * for nothing. What it does not get is a client: its work arrives from the
 * queue and ends when it is done.
 */
export interface QueueConsumer {
  /** The queue or topic the messages come from. */
  queueId: string;
  /**
   * One backlog per consumer. A queue has one consumer, so its backlog is
   * keyed by the queue alone; a topic keeps a backlog per subscriber.
   */
  backlogKey: string;
  /** Link from the queue or topic to the server that drains it. */
  deliveryEdgeId: string;
  branch: ServerBranch;
}

/**
 * One component in the path between the users and the entry point.
 *
 * A CDN, a WAF or an API gateway: each forwards what it lets through to the
 * next thing, and each has one reason of its own to stop a request — a cache
 * hit, a block, a rate limit. They may appear in any order and any number.
 */
export interface EdgeHop {
  nodeId: string;
  kind: EdgeKind;
  /** The link into this hop: from the users, or from the hop before it. */
  inboundEdgeId: string;
}

/** One unambiguous operation path, resolved from the graph. */
export interface ClientRoute {
  clientId: string;
  /** Null when the users talk to a single server directly. */
  loadBalancerId: string | null;
  /** The link out of the client: to the first edge hop, the balancer, or the server. */
  clientEdgeId: string;
  /** Edge components between the users and the entry point, in path order. */
  edgeChain: EdgeHop[];
  /** The link into the entry point. The client's own link when the chain is empty. */
  entryEdgeId: string;
  /**
   * DNS beside the path, if the users are connected to one. Requests do not
   * flow through it; a share of them consult it before setting off.
   */
  dnsId: string | null;
  dnsEdgeId: string | null;
  /** One entry when there is no balancer; one per server behind a balancer. */
  branches: ServerBranch[];
}

export interface RoutingResult {
  graph: ArchitectureGraph;
  routes: ClientRoute[];
  /** One per queue that has work published to it and a consumer behind it. */
  consumers: QueueConsumer[];
  issues: ValidationIssue[];
  /** Components reachable from at least one client. */
  reachable: Set<string>;
  hasErrors: boolean;
}

export function buildGraph(doc: ArchitectureDocument): ArchitectureGraph {
  const nodesById = new Map<string, ArchNode>();
  for (const node of doc.nodes) nodesById.set(node.id, node);

  const outgoing = new Map<string, ArchEdge[]>();
  const incoming = new Map<string, ArchEdge[]>();
  for (const node of doc.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of doc.edges) {
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
  }
  return { nodesById, outgoing, incoming, edges: doc.edges };
}

function kindOf(graph: ArchitectureGraph, id: string): ComponentKind | null {
  return graph.nodesById.get(id)?.kind ?? null;
}

function nameOf(graph: ArchitectureGraph, id: string): string {
  return graph.nodesById.get(id)?.name ?? id;
}

function kindLabel(graph: ArchitectureGraph, id: string): string {
  const kind = kindOf(graph, id);
  return kind ? COMPONENT_LABELS[kind] : 'component';
}

function isCompute(kind: ComponentKind | null): kind is ComputeKind {
  return kind !== null && (COMPUTE_KINDS as readonly string[]).includes(kind);
}

/** What a server may call, and how many of each. */
const SERVER_TARGETS: Partial<Record<ComponentKind, number>> = {
  identity: 1, discovery: 1, secrets: 1, notification: 1, monitoring: 1,
  eventStream: 1,
  documentDb: 1,
  wideColumn: 1,
  searchIndex: 1,
  warehouse: 1,
  timeSeries: 1,

  database: 1,
  cache: 1,
  queue: 1,
  pubsub: 1,
  kvStore: 1,
  objectStorage: 1,
  readReplica: Number.POSITIVE_INFINITY,
};

/**
 * Breadth-first search from every client along outgoing connections.
 * Anything not visited is provisioned but carries no traffic.
 */
function computeReachable(graph: ArchitectureGraph, clientIds: string[]): Set<string> {
  const seen = new Set<string>(clientIds);
  const queue: string[] = [...clientIds];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head]!;
    head += 1;
    for (const edge of graph.outgoing.get(current) ?? []) {
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return seen;
}

/**
 * Resolve what one application server can call. Returns null (and pushes an
 * issue) when the server's own connections are ambiguous.
 */
function resolveServerBranch(
  graph: ArchitectureGraph,
  serverId: string,
  inboundEdgeId: string,
  issues: ValidationIssue[],
): ServerBranch | null {
  const out = (graph.outgoing.get(serverId) ?? []).filter((e) =>
    graph.nodesById.has(e.target),
  );
  const ofKind = (kind: ComponentKind) => out.filter((e) => kindOf(graph, e.target) === kind);
  const dbEdges = ofKind('database');
  const cacheEdges = ofKind('cache');
  const queueEdges = ofKind('queue');
  const pubsubEdges = ofKind('pubsub');
  const kvEdges = ofKind('kvStore');
  const storageEdges = ofKind('objectStorage');
  const replicaEdges = ofKind('readReplica');
  const otherEdges = out.filter((e) => {
    const kind = kindOf(graph, e.target);
    return kind === null || SERVER_TARGETS[kind] === undefined;
  });

  let ok = true;
  if (otherEdges.length > 0) {
    issues.push({
      severity: 'error',
      code: 'route/server-unsupported-target',
      message: `"${nameOf(graph, serverId)}" is connected to ${otherEdges
        .map((e) => `"${nameOf(graph, e.target)}"`)
        .join(', ')}, which this version cannot call from a server.`,
      hint: 'A server may call a Cache, a Database, a Read Replica, a Key-Value Store and Object Storage, and publish to a Message Queue or a Pub/Sub Topic. Server-to-server calls are not modelled yet.',
      nodeIds: [serverId],
      edgeIds: otherEdges.map((e) => e.id),
    });
    ok = false;
  }
  for (const [kind, edges, what] of [
    ['pubsub', pubsubEdges, 'topics'],
    ['kvStore', kvEdges, 'key-value stores'],
    ['objectStorage', storageEdges, 'object stores'],
  ] as const) {
    if (edges.length > 1) {
      issues.push({
        severity: 'error',
        code: `route/server-multiple-${kind}`,
        message: `"${nameOf(graph, serverId)}" is connected to ${edges.length} ${what}.`,
        hint: `This version uses exactly one ${COMPONENT_LABELS[kind]} per server. Remove the extra connection.`,
        nodeIds: [serverId],
        edgeIds: edges.map((e) => e.id),
      });
      ok = false;
    }
  }
  // A replica is a copy of *this server's* database, so the two connections —
  // server reads from it, database replicates to it — have to agree.
  const replicas: ReplicaLink[] = [];
  for (const edge of replicaEdges) {
    const sources = (graph.incoming.get(edge.target) ?? []).filter(
      (e) => kindOf(graph, e.source) === 'database',
    );
    if (sources.length !== 1) {
      issues.push({
        severity: 'error',
        code: 'route/replica-source',
        message:
          sources.length === 0
            ? `"${nameOf(graph, edge.target)}" is not a copy of any database.`
            : `"${nameOf(graph, edge.target)}" is connected from ${sources.length} databases.`,
        hint: 'A Read Replica copies exactly one Database. Connect that database to the replica, so the arrow shows what it copies.',
        nodeIds: [edge.target],
        edgeIds: sources.map((e) => e.id),
      });
      ok = false;
      continue;
    }
    const source = sources[0]!;
    if (dbEdges.length === 1 && source.source !== dbEdges[0]!.target) {
      issues.push({
        severity: 'error',
        code: 'route/replica-mismatch',
        message: `"${nameOf(graph, serverId)}" reads from "${nameOf(graph, edge.target)}", which copies "${nameOf(graph, source.source)}", not the database the server writes to.`,
        hint: 'A server reads from replicas of its own database. Connect the replica to that database, or the server to the other one.',
        nodeIds: [serverId, edge.target],
        edgeIds: [edge.id],
      });
      ok = false;
      continue;
    }
    if (dbEdges.length === 0) {
      issues.push({
        severity: 'error',
        code: 'route/replica-without-database',
        message: `"${nameOf(graph, serverId)}" reads from a replica but is not connected to the database it copies.`,
        hint: 'Writes have to go somewhere. Connect the server to the Database as well.',
        nodeIds: [serverId, edge.target],
        edgeIds: [edge.id],
      });
      ok = false;
      continue;
    }
    replicas.push({ replicaId: edge.target, serverReplicaEdgeId: edge.id, replicationEdgeId: source.id });
  }
  if (queueEdges.length > 1) {
    issues.push({
      severity: 'error',
      code: 'route/server-multiple-queues',
      message: `"${nameOf(graph, serverId)}" publishes to ${queueEdges.length} queues.`,
      hint: 'This version publishes to exactly one queue per server. Remove the extra connection.',
      nodeIds: [serverId],
      edgeIds: queueEdges.map((e) => e.id),
    });
    ok = false;
  }
  if (dbEdges.length > 1) {
    issues.push({
      severity: 'error',
      code: 'route/server-multiple-databases',
      message: `"${nameOf(graph, serverId)}" is connected to ${dbEdges.length} databases.`,
      hint: 'This version reads from exactly one database per server. Remove the extra connection.',
      nodeIds: [serverId],
      edgeIds: dbEdges.map((e) => e.id),
    });
    ok = false;
  }
  if (cacheEdges.length > 1) {
    issues.push({
      severity: 'error',
      code: 'route/server-multiple-caches',
      message: `"${nameOf(graph, serverId)}" is connected to ${cacheEdges.length} caches.`,
      hint: 'This version checks exactly one cache per server. Remove the extra connection.',
      nodeIds: [serverId],
      edgeIds: cacheEdges.map((e) => e.id),
    });
    ok = false;
  }
  if (!ok) return null;

  return {
    serverId,
    computeKind: kindOf(graph, serverId) === 'serverless' ? 'serverless' : 'server',
    cacheId: cacheEdges[0]?.target ?? null,
    databaseId: dbEdges[0]?.target ?? null,
    queueId: queueEdges[0]?.target ?? null,
    pubsubId: pubsubEdges[0]?.target ?? null,
    kvStoreId: kvEdges[0]?.target ?? null,
    objectStorageId: storageEdges[0]?.target ?? null,
    replicas,
    inboundEdgeId,
    serverCacheEdgeId: cacheEdges[0]?.id ?? null,
    serverDatabaseEdgeId: dbEdges[0]?.id ?? null,
    serverQueueEdgeId: queueEdges[0]?.id ?? null,
    serverPubSubEdgeId: pubsubEdges[0]?.id ?? null,
    serverKvStoreEdgeId: kvEdges[0]?.id ?? null,
    serverObjectStorageEdgeId: storageEdges[0]?.id ?? null,
    streamId: ofKind('eventStream')[0]?.target ?? null,
    serverStreamEdgeId: ofKind('eventStream')[0]?.id ?? null,
    supportCalls: DEPENDENCY_SUPPORT.flatMap(kind => ofKind(kind).map(e => ({ nodeId: e.target, edgeId: e.id }))),
    asyncCalls: ASYNC_SUPPORT.flatMap(kind => ofKind(kind).map(e => ({ nodeId: e.target, edgeId: e.id }))),
    dataServices: out.filter((e) => isDataKind(kindOf(graph, e.target) ?? "")).map((e) => ({ nodeId: e.target, edgeId: e.id })),
  };
}

/**
 * Resolve the server behind a queue.
 *
 * A queue is only useful with something draining it, and the thing draining it
 * is an ordinary Application Server — so this hands straight back to
 * `resolveServerBranch` and the consumer inherits every rule about caches and
 * databases that a user-facing server follows.
 */
function resolveConsumers(
  graph: ArchitectureGraph,
  sourceId: string,
  issues: ValidationIssue[],
): QueueConsumer[] | null {
  const source = graph.nodesById.get(sourceId)!;
  const isTopic = source.kind === 'pubsub' || source.kind === 'eventStream';
  const label = isTopic ? 'topic' : 'queue';
  const out = (graph.outgoing.get(sourceId) ?? []).filter((e) => graph.nodesById.has(e.target));
  const serverEdges = out.filter((e) => isCompute(kindOf(graph, e.target)));
  const deadLetters = source.kind === 'queue' ? out.filter((e) => kindOf(graph, e.target) === 'deadLetter') : [];
  if (deadLetters.length > 1) {
    issues.push({ severity: 'error', code: 'route/dlq-ambiguous', message: 'A Message Queue can send exhausted jobs to one Dead-letter queue.', nodeIds: [sourceId], edgeIds: deadLetters.map((e) => e.id) });
    return null;
  }
  const otherEdges = out.filter((e) => !isCompute(kindOf(graph, e.target)) && !deadLetters.includes(e));

  if (otherEdges.length > 0) {
    issues.push({
      severity: 'error',
      code: 'route/queue-unsupported-consumer',
      message: `"${nameOf(graph, sourceId)}" is connected to ${otherEdges
        .map((e) => `"${nameOf(graph, e.target)}"`)
        .join(', ')}, which cannot consume from a ${label}.`,
      hint: `Only an Application Server or a Serverless Function can work through a ${label}. Connect one behind it.`,
      nodeIds: [sourceId],
      edgeIds: otherEdges.map((e) => e.id),
    });
    return null;
  }
  if (serverEdges.length === 0 && (source.kind === 'eventStream' || (source.kind === 'deadLetter' && !source.settings.replayEnabled))) return [];
  if (serverEdges.length === 0) {
    issues.push({
      severity: 'error',
      code: 'route/queue-no-consumer',
      message: `"${nameOf(graph, sourceId)}" has nothing consuming from it.`,
      hint: `Messages published here would never be processed. Connect an Application Server or a Serverless Function behind the ${label}.`,
      nodeIds: [sourceId],
    });
    return null;
  }
  if (!isTopic && serverEdges.length > 1) {
    issues.push({
      severity: 'error',
      code: 'route/queue-multiple-consumers',
      message: `"${nameOf(graph, sourceId)}" has ${serverEdges.length} consumers.`,
      hint: 'This version drains a queue with exactly one consumer. Remove the extra connection, or use a Pub/Sub Topic to give every listener its own copy.',
      nodeIds: [sourceId],
      edgeIds: serverEdges.map((e) => e.id),
    });
    return null;
  }

  const consumers: QueueConsumer[] = [];
  for (const deliveryEdge of serverEdges) {
    const branch = resolveServerBranch(graph, deliveryEdge.target, deliveryEdge.id, issues);
    if (!branch) return null;

    // A consumer that publishes back into its own queue or topic would feed
    // itself for ever. The resolver has never needed a cycle check before,
    // because a server could not reach another server at all until queues.
    for (const next of [branch.queueId, branch.pubsubId, branch.streamId]) {
      if (next !== null && reachesQueue(graph, next, sourceId)) {
        issues.push({
          severity: 'error',
          code: 'route/queue-cycle',
          message: `"${nameOf(graph, branch.serverId)}" publishes back into a ${label} it consumes from.`,
          hint: 'Work would be created faster than it could ever be finished. Break the loop.',
          nodeIds: [sourceId, branch.serverId],
        });
        return null;
      }
    }
    consumers.push({
      queueId: sourceId,
      backlogKey: isTopic ? `${sourceId}|${deliveryEdge.target}` : sourceId,
      deliveryEdgeId: deliveryEdge.id,
      branch,
    });
  }
  return consumers;
}

/**
 * Whether following queue -> consumer -> queue (or topic -> subscriber ->
 * topic) from `from` ever reaches `target`. Depth-first, because a topic fans
 * out to several consumers.
 */
function reachesQueue(graph: ArchitectureGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const consumer of graph.outgoing.get(current) ?? []) {
      if (kindOf(graph, consumer.target) === 'deadLetter') stack.push(consumer.target);
      if (!isCompute(kindOf(graph, consumer.target))) continue;
      for (const next of graph.outgoing.get(consumer.target) ?? []) {
        const kind = kindOf(graph, next.target);
        if (kind === 'queue' || kind === 'pubsub' || kind === 'eventStream') stack.push(next.target);
      }
    }
  }
  return false;
}

export function validateAndResolve(doc: ArchitectureDocument): RoutingResult {
  const graph = buildGraph(doc);
  const issues: ValidationIssue[] = [];
  const routes: ClientRoute[] = [];

  // ---- Structural checks on the edges themselves -------------------------
  const seenPairs = new Set<string>();
  for (const edge of doc.edges) {
    if (!graph.nodesById.has(edge.source) || !graph.nodesById.has(edge.target)) {
      issues.push({
        severity: 'error',
        code: 'edge/dangling',
        message: `A connection refers to a component that is not on the canvas.`,
        hint: 'Delete the connection, or re-add the missing component.',
        edgeIds: [edge.id],
      });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({
        severity: 'error',
        code: 'edge/self-loop',
        message: `"${nameOf(graph, edge.source)}" is connected to itself.`,
        hint: 'A component cannot call itself in this version.',
        edgeIds: [edge.id],
      });
    }
    const pair = `${edge.source}->${edge.target}`;
    if (seenPairs.has(pair)) {
      issues.push({
        severity: 'error',
        code: 'edge/duplicate',
        message: `There is more than one connection from "${nameOf(graph, edge.source)}" to "${nameOf(graph, edge.target)}".`,
        hint: 'Aparecium cannot tell which link a message should use. Delete one of them.',
        edgeIds: [edge.id],
      });
    }
    seenPairs.add(pair);
  }

  // ---- Components that never initiate calls in this version --------------
  // A database is the one exception: it replicates to its read replicas.
  const LEAF_KINDS: ComponentKind[] = [...DATA_KINDS, ...DEPENDENCY_SUPPORT, ...ASYNC_SUPPORT, 'cache', 'dns', 'readReplica', 'kvStore', 'objectStorage'];
  for (const node of doc.nodes) {
    const out = graph.outgoing.get(node.id) ?? [];
    const wrong =
      node.kind === 'database'
        ? out.filter((e) => kindOf(graph, e.target) !== 'readReplica')
        : LEAF_KINDS.includes(node.kind)
          ? out
          : [];
    if (wrong.length > 0) {
      issues.push({
        severity: 'error',
        code: 'topology/leaf-outgoing',
        message: `"${node.name}" has an outgoing connection.`,
        hint:
          node.kind === 'database'
            ? 'A database only answers calls, and replicates to its Read Replicas. Reverse the connection so the caller reaches it.'
            : 'This component only answers calls; it never starts one. Reverse the connection so the caller reaches it.',
        nodeIds: [node.id],
        edgeIds: wrong.map((e) => e.id),
      });
    }
  }

  const clients = doc.nodes.filter((n) => n.kind === 'client');
  if (clients.length === 0 && !doc.nodes.some((n) => n.kind === 'scheduler')) {
    issues.push({
      severity: 'error',
      code: 'topology/no-client',
      message: 'There are no Users on the canvas, so no traffic can be generated.',
      hint: 'Add a Users component and connect it to a Load Balancer or an Application Server.',
    });
  }

  // ---- One unambiguous path per group of users ---------------------------
  for (const client of clients) {
    const allOut = (graph.outgoing.get(client.id) ?? []).filter((e) =>
      graph.nodesById.has(e.target),
    );
    // DNS is consulted, not traversed: a link to it is beside the path.
    const dnsEdges = allOut.filter((e) => kindOf(graph, e.target) === 'dns');
    const out = allOut.filter((e) => kindOf(graph, e.target) !== 'dns');
    if (dnsEdges.length > 1) {
      issues.push({
        severity: 'error',
        code: 'route/dns-ambiguous',
        message: `"${client.name}" is connected to ${dnsEdges.length} DNS components.`,
        hint: 'A group of users resolves names through one DNS. Remove the extra connection.',
        nodeIds: [client.id],
        edgeIds: dnsEdges.map((e) => e.id),
      });
      continue;
    }
    const dnsEdge = dnsEdges[0] ?? null;
    if (out.length === 0) {
      issues.push({
        severity: 'error',
        code: 'route/client-unconnected',
        message: `"${client.name}" is not connected to anything.`,
        hint: 'Drag a connection from the users to a Load Balancer or an Application Server.',
        nodeIds: [client.id],
      });
      continue;
    }
    if (out.length > 1) {
      issues.push({
        severity: 'error',
        code: 'route/client-ambiguous',
        message: `"${client.name}" has ${out.length} outgoing connections, so Aparecium cannot tell where a request should go.`,
        hint: 'This version supports exactly one entry point per group of users. Keep one connection, or put a Load Balancer in front to fan out.',
        nodeIds: [client.id],
        edgeIds: out.map((e) => e.id),
      });
      continue;
    }

    const clientEdge = out[0]!;

    // ---- Walk the edge chain to the entry point ---------------------------
    // Each hop forwards to exactly one thing: another hop, the balancer, or
    // a server. The walk stops at the first thing that is not a hop.
    const edgeChain: EdgeHop[] = [];
    let entryEdge = clientEdge;
    let chainOk = true;
    const visited = new Set<string>();
    while ((EDGE_KINDS as readonly string[]).includes(kindOf(graph, entryEdge.target) ?? '')) {
      const hopId = entryEdge.target;
      if (visited.has(hopId)) {
        issues.push({
          severity: 'error',
          code: 'route/edge-cycle',
          message: `"${nameOf(graph, hopId)}" is reached twice on the way from "${client.name}" to a server.`,
          hint: 'The connections in front of your servers form a loop. Break it.',
          nodeIds: [hopId],
        });
        chainOk = false;
        break;
      }
      visited.add(hopId);
      edgeChain.push({
        nodeId: hopId,
        kind: kindOf(graph, hopId) as EdgeKind,
        inboundEdgeId: entryEdge.id,
      });
      const allHopOut = (graph.outgoing.get(hopId) ?? []).filter(e => graph.nodesById.has(e.target));
      const identities = kindOf(graph, hopId) === 'apiGateway' ? allHopOut.filter(e => kindOf(graph, e.target) === 'identity') : [];
      if (identities.length > 1) { issues.push({ severity: 'error', code: 'route/gateway-identity', message: 'Connect one Identity service to this gateway.', nodeIds: [hopId] }); chainOk = false; break; }
      const hopOut = allHopOut.filter(e => !identities.includes(e));
      if (hopOut.length === 0) {
        issues.push({
          severity: 'error',
          code: 'route/edge-unconnected',
          message: `"${nameOf(graph, hopId)}" forwards to nothing.`,
          hint: 'Connect it onward — to the next edge component, a Load Balancer, or an Application Server.',
          nodeIds: [hopId],
        });
        chainOk = false;
        break;
      }
      if (hopOut.length > 1) {
        issues.push({
          severity: 'error',
          code: 'route/edge-ambiguous',
          message: `"${nameOf(graph, hopId)}" forwards to ${hopOut.length} things, so Aparecium cannot tell where a request should go.`,
          hint: 'An edge component forwards to exactly one thing. Put a Load Balancer behind it to fan out.',
          nodeIds: [hopId],
          edgeIds: hopOut.map((e) => e.id),
        });
        chainOk = false;
        break;
      }
      entryEdge = hopOut[0]!;
    }
    if (!chainOk) continue;

    const entryId = entryEdge.target;
    const entryKind = kindOf(graph, entryId);
    const dnsId = dnsEdge ? dnsEdge.target : null;
    const dnsEdgeId = dnsEdge ? dnsEdge.id : null;

    // ---- Entry point is a load balancer ---------------------------------
    if (entryKind === 'loadBalancer') {
      const lbOut = (graph.outgoing.get(entryId) ?? []).filter((e) =>
        graph.nodesById.has(e.target),
      );
      const serverEdges = lbOut.filter((e) => isCompute(kindOf(graph, e.target)));
      const wrongEdges = lbOut.filter((e) => !isCompute(kindOf(graph, e.target)));

      if (wrongEdges.length > 0) {
        issues.push({
          severity: 'error',
          code: 'route/balancer-unsupported-target',
          message: `"${nameOf(graph, entryId)}" is connected to ${wrongEdges
            .map((e) => `"${nameOf(graph, e.target)}"`)
            .join(', ')}, which is not an Application Server or a Serverless Function.`,
          hint: 'A Load Balancer spreads requests across Application Servers and Serverless Functions only. Connect the database or cache to the servers instead.',
          nodeIds: [entryId],
          edgeIds: wrongEdges.map((e) => e.id),
        });
        continue;
      }
      if (serverEdges.length === 0) {
        issues.push({
          severity: 'error',
          code: 'route/balancer-empty',
          message: `"${nameOf(graph, entryId)}" has no Application Servers behind it.`,
          hint: 'Connect the load balancer to at least one Application Server, or send the users straight to a server.',
          nodeIds: [entryId],
        });
        continue;
      }

      const branches: ServerBranch[] = [];
      let allOk = true;
      for (const edge of serverEdges) {
        const branch = resolveServerBranch(graph, edge.target, edge.id, issues);
        if (!branch) allOk = false;
        else branches.push(branch);
      }
      if (!allOk) continue;

      routes.push({
        clientId: client.id,
        loadBalancerId: entryId,
        clientEdgeId: clientEdge.id,
        edgeChain,
        entryEdgeId: entryEdge.id,
        dnsId,
        dnsEdgeId,
        branches,
      });
      continue;
    }

    // ---- Entry point is a single server or function ----------------------
    if (!isCompute(entryKind)) {
      const last = edgeChain.at(-1);
      issues.push({
        severity: 'error',
        code: 'route/client-target',
        message: last
          ? `"${nameOf(graph, last.nodeId)}" forwards to "${nameOf(graph, entryId)}", which is a ${kindLabel(graph, entryId)}.`
          : `"${client.name}" is connected directly to "${nameOf(graph, entryId)}", which is a ${kindLabel(graph, entryId)}.`,
        hint: 'Requests must end up at a Load Balancer, an Application Server or a Serverless Function. Put one in between.',
        nodeIds: [last ? last.nodeId : client.id, entryId],
        edgeIds: [entryEdge.id],
      });
      continue;
    }

    const branch = resolveServerBranch(graph, entryId, entryEdge.id, issues);
    if (!branch) continue;

    routes.push({
      clientId: client.id,
      loadBalancerId: null,
      clientEdgeId: clientEdge.id,
      edgeChain,
      entryEdgeId: entryEdge.id,
      dnsId,
      dnsEdgeId,
      branches: [branch],
    });
  }

  // Scheduled work has its own source and totals; it invokes one compute node.
  for (const scheduler of doc.nodes.filter((n) => n.kind === 'scheduler')) {
    const out = graph.outgoing.get(scheduler.id) ?? [];
    const first = out[0];
    if (out.length !== 1 || !first || !isCompute(kindOf(graph, first.target))) {
      issues.push({ severity: 'error', code: 'route/scheduler-target', message: `"${scheduler.name}" needs one connection to an Application Server or Function.`, nodeIds: [scheduler.id], edgeIds: out.map((e) => e.id) });
      continue;
    }
    const branch = resolveServerBranch(graph, first.target, first.id, issues);
    if (branch) routes.push({ clientId: scheduler.id, loadBalancerId: null, clientEdgeId: first.id,
      edgeChain: [], entryEdgeId: first.id, dnsId: null, dnsEdgeId: null, branches: [branch] });
  }
  for (const node of doc.nodes.filter((n) => n.kind === 'deadLetter')) {
    const bad = (graph.incoming.get(node.id) ?? []).filter((e) => kindOf(graph, e.source) !== 'queue');
    if (bad.length) issues.push({ severity: 'error', code: 'route/dlq-source', message: 'A Dead-letter queue receives exhausted jobs from a Message Queue.', nodeIds: [node.id], edgeIds: bad.map((e) => e.id) });
  }

  // ---- Balancers nobody sends to ----------------------------------------
  for (const node of doc.nodes) {
    if (node.kind !== 'loadBalancer') continue;
    const usedByARoute = routes.some((r) => r.loadBalancerId === node.id);
    const incoming = (graph.incoming.get(node.id) ?? []).length;
    if (!usedByARoute && incoming === 0) {
      issues.push({
        severity: 'warning',
        code: 'topology/balancer-no-traffic',
        message: `"${node.name}" has nothing sending traffic to it.`,
        hint: 'Connect a Users component to it. It is still provisioned, so its fixed costs are still included.',
        nodeIds: [node.id],
      });
    }
  }

  // ---- Reachability: provisioned but idle components ---------------------
  const reachable = computeReachable(
    graph,
    routes.map((r) => r.clientId),
  );
  for (const node of doc.nodes) {
    if (node.kind === 'client') continue;
    if (!reachable.has(node.id)) {
      issues.push({
        severity: 'warning',
        code: 'topology/unreachable',
        message: `"${node.name}" is not on any user's path, so it will handle no traffic.`,
        hint: 'It is still provisioned, so its fixed costs are still included in the estimate.',
        nodeIds: [node.id],
      });
    }
  }

  // ---- Assumptions the user should see, surfaced as warnings -------------
  for (const route of routes) {
    for (const branch of route.branches) {
      if (branch.cacheId && !branch.databaseId) {
        issues.push({
          severity: 'warning',
          code: 'route/cache-without-database',
          message: `"${nameOf(graph, branch.serverId)}" has a cache but no database.`,
          hint: 'A cache miss will be answered by the server itself, with no database read.',
          nodeIds: [branch.serverId, branch.cacheId],
        });
      }
      if (!branch.cacheId && !branch.databaseId && !branch.kvStoreId && !branch.objectStorageId && !branch.dataServices.length && !branch.supportCalls.length && !branch.asyncCalls.length && !branch.queueId && !branch.pubsubId && !branch.streamId) {
        issues.push({
          severity: 'warning',
          code: 'route/compute-only',
          message: `"${nameOf(graph, branch.serverId)}" has no database or cache.`,
          hint: 'Every request is answered from CPU work alone.',
          nodeIds: [branch.serverId],
        });
      }
    }
  }

  // ---- Queues, and the servers that drain them ---------------------------
  // Resolved from the queues the routes actually publish to, so a queue nobody
  // publishes to is left alone with the unreachable warning it already has.
  // A consumer may publish onward to another queue or topic, so the set is
  // walked until nothing new is published to.
  const consumers: QueueConsumer[] = [];
  const publishedTo: string[] = [];
  const noted = new Set<string>();
  const note = (branch: ServerBranch) => {
    for (const id of [branch.queueId, branch.pubsubId, branch.streamId]) {
      if (id && !noted.has(id)) {
        noted.add(id);
        publishedTo.push(id);
      }
    }
  };
  for (const route of routes) for (const branch of route.branches) note(branch);
  for (let i = 0; i < publishedTo.length; i += 1) {
    const sourceId = publishedTo[i]!;
    for (const e of graph.outgoing.get(sourceId) ?? []) {
      if (kindOf(graph, e.target) === 'deadLetter' && !noted.has(e.target)) { noted.add(e.target); publishedTo.push(e.target); }
    }
    const found = resolveConsumers(graph, sourceId, issues);
    if (!found) continue;
    for (const consumer of found) {
      consumers.push(consumer);
      // The consumer and everything it calls are on a user's path, by way of
      // the queue, so they are not unreachable.
      const b = consumer.branch;
      for (const id of [b.serverId, b.cacheId, b.databaseId, b.kvStoreId, b.objectStorageId, b.queueId, b.pubsubId]) {
        if (id) reachable.add(id);
      }
      for (const r of b.replicas) reachable.add(r.replicaId);
      note(b);
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return { graph, routes, consumers, issues, reachable, hasErrors };
}
