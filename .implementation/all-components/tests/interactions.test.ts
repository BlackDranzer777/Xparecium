import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import {
  DEFAULT_CLOUD_PROFILE_BY_KIND,
  DEFAULT_KV_STORE_SETTINGS,
  DEFAULT_OBJECT_STORAGE_SETTINGS,
  DEFAULT_PUBSUB_SETTINGS,
  DEFAULT_READ_REPLICA_SETTINGS,
  DEFAULT_SERVERLESS_SETTINGS,
} from '../src/domain/defaults';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation } from '../src/simulation/engine';
import { validateAndResolve } from '../src/simulation/routing';
import type { SimulationResult } from '../src/simulation/types';
import type { ArchEdge, ArchNode, ArchitectureDocument, ClientSettings, ServerSettings } from '../src/domain/types';
import {
  apiGateway,
  cache,
  cdn,
  client,
  database,
  dns,
  doc,
  edge,
  loadBalancer,
  queue,
  server,
  waf,
  INSTANT,
} from './helpers';

/**
 * All ten components on one canvas, and the question of whether they agree.
 *
 * Every component is tested alone elsewhere. What can only go wrong together
 * is the hand-off: a response that has to find its way back through four hops
 * to a user who is waiting to send the next request; a queue behind servers
 * that are behind a gateway; a cost sheet that has to count what each of them
 * actually did. So these tests build the whole thing and reconcile the counts
 * end to end: nothing lost, nothing counted twice.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);

const SERVER: Partial<ServerSettings> = {
  profile: 'custom',
  cpuSlots: 4,
  cpuMsPerRequest: 5,
  concurrencyLimit: 10_000,
  ramMb: 1_000_000,
  baselineMemoryMb: 0,
  memoryPerRequestMb: 1,
  memoryPerQueuedRequestMb: 0,
  queueLimit: 100_000,
};

/**
 * Users (+DNS) -> CDN -> WAF -> Gateway -> LB -> 2 servers, each with a cache,
 * a database and a queue; one worker drains the queue and writes to the database.
 */
function everything(
  clientOverrides: Partial<ClientSettings> = {},
  options: { order?: ('cdn' | 'waf' | 'gw')[]; hitRate?: number; blockRate?: number; limit?: number | null; cpuMs?: number } = {},
): ArchitectureDocument {
  const order = options.order ?? ['cdn', 'waf', 'gw'];
  const SERVER_HERE = { ...SERVER, cpuMsPerRequest: options.cpuMs ?? SERVER.cpuMsPerRequest };
  const nodes: ArchNode[] = [
    client('c1', { requestRateOverridePerSecond: 20, requestBytes: 500, responseBytes: 5000, ...clientOverrides }),
    dns('dns', { lookupShare: 0.1, lookupServiceTimeMs: 2 }),
    cdn('cdn', { hitRate: options.hitRate ?? 0.5, serviceTimeMs: 1 }),
    waf('waf', { blockRate: options.blockRate ?? 0.1, serviceTimeMs: 1 }),
    apiGateway('gw', { rateLimitPerSecond: options.limit ?? null, burstCapacity: 10, serviceTimeMs: 1 }),
    loadBalancer('lb', { serviceTimeMs: 1 }),
    server('s1', SERVER_HERE),
    server('s2', SERVER_HERE),
    cache('cache', { hitRate: 0.5, lookupServiceTimeMs: 1, populateOnMiss: true }),
    database('db', { queryServiceTimeMs: 3 }),
    queue('q', { publishServiceTimeMs: 1 }),
    server('w1', { ...SERVER, cpuMsPerRequest: 2 }),
  ];
  const path = ['c1', ...order, 'lb'];
  const edges: ArchEdge[] = [edge('c1', 'dns', INSTANT)];
  for (let i = 0; i < path.length - 1; i += 1) edges.push(edge(path[i]!, path[i + 1]!, INSTANT));
  for (const s of ['s1', 's2']) {
    edges.push(edge('lb', s, INSTANT), edge(s, 'cache', INSTANT), edge(s, 'db', INSTANT), edge(s, 'q', INSTANT));
  }
  edges.push(edge('q', 'w1', INSTANT), edge('w1', 'db', INSTANT));
  return doc(nodes, edges, { durationSeconds: 30, drainSeconds: 20, seed: 3 });
}

const station = (r: SimulationResult, kind: string) => r.stations.find((s) => s.kind === kind)!;
const served = (r: SimulationResult) => r.servers.filter((s) => s.nodeId !== 'w1').reduce((n, s) => n + s.completed, 0);

describe('all ten components together', () => {
  it('is a valid design with one route per group of users', () => {
    const resolved = validateAndResolve(everything());
    expect(resolved.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(resolved.routes).toHaveLength(1);
    const route = resolved.routes[0]!;
    expect(route.edgeChain.map((h) => h.kind)).toEqual(['cdn', 'waf', 'apiGateway']);
    expect(route.dnsId).toBe('dns');
    expect(route.loadBalancerId).toBe('lb');
    expect(route.branches).toHaveLength(2);
  });

  it('accounts for every request exactly once, front to back', () => {
    const r = runSimulation(everything());
    const cdnS = station(r, 'cdn');
    const wafS = station(r, 'waf');
    const gwS = station(r, 'apiGateway');
    const lbS = station(r, 'loadBalancer');
    const cacheS = station(r, 'cache');
    const dbS = station(r, 'database');

    expect(r.status).toBe('completed');
    expect(r.offered).toBe(600);
    expect(r.unfinished).toBe(0);

    // The front: every request through the CDN, only misses onward, only the
    // allowed ones through the gateway, all of those to the balancer.
    expect(cdnS.operations).toBe(600);
    expect(cdnS.hits! + cdnS.misses!).toBe(600);
    expect(wafS.operations).toBe(cdnS.misses);
    expect(gwS.operations).toBe(wafS.operations - wafS.blocked!);
    expect(gwS.throttled).toBe(0);
    expect(lbS.operations).toBe(gwS.operations);

    // The back: the balancer's requests are the servers' requests; each one
    // looked in the cache, went to the database on a miss, and published one
    // message that the worker then did, writing to the database itself.
    expect(served(r)).toBe(lbS.operations);
    expect(r.servers.map((s) => s.nodeId).sort()).toEqual(['s1', 's2', 'w1']);
    expect(r.servers.find((s) => s.nodeId === 's1')!.completed).toBeGreaterThan(0);
    expect(r.servers.find((s) => s.nodeId === 's2')!.completed).toBeGreaterThan(0);
    expect(cacheS.hits! + cacheS.misses!).toBe(served(r));
    expect(r.messagesPublished).toBe(served(r));
    expect(r.messagesProcessed).toBe(r.messagesPublished);
    expect(r.queues[0]!.outstanding).toBe(0);
    expect(dbS.operations).toBe(cacheS.misses! + r.messagesProcessed);

    // Nothing lost: hits + blocks + served = everything offered.
    expect(cdnS.hits! + wafS.blocked! + served(r)).toBe(600);
    expect(r.completed).toBe(cdnS.hits! + served(r));
    expect(r.rejected).toBe(wafS.blocked);
    expect(r.rejectionsByReason).toEqual({ 'waf-blocked': wafS.blocked });

    // Beside the path: about a tenth asked the DNS first.
    expect(station(r, 'dns').operations).toBeGreaterThan(30);
    expect(station(r, 'dns').operations).toBeLessThan(90);
  });

  it('sends every response back through the chain, so bytes to users leave the CDN', () => {
    const r = runSimulation(everything());
    const toUsers = r.links.filter((l) => l.toId === 'c1');
    // Two links end at the users: the DNS answer and the CDN's responses.
    expect(toUsers.map((l) => l.fromId).sort()).toEqual(['cdn', 'dns']);
    const responses = toUsers.find((l) => l.fromId === 'cdn')!;
    expect(responses.messages).toBe(r.completed);
    expect(responses.bytes).toBe(r.completed * 5000);
    expect(r.usage.egressByNodeId['cdn']).toBe(responses.bytes);
    expect(r.usage.egressByNodeId['lb']).toBeUndefined();
    // And the origin's answers came back one hop at a time, never skipping one.
    for (const [from, to] of [['lb', 'gw'], ['gw', 'waf'], ['waf', 'cdn']]) {
      const back = r.links.find((l) => l.fromId === from && l.toId === to)!;
      expect(back.messages).toBe(served(r));
    }
  });

  it('keeps closed-loop users going: each answer, back through four hops, releases the next request', () => {
    const r = runSimulation(everything({ requestRateOverridePerSecond: null, mode: 'closed', activeUsers: 20, thinkTimeMs: 200 }));
    // If any response failed to reach its user, that user would never send
    // again and the run would stall at one request per user.
    expect(r.offered).toBeGreaterThan(20 * 50);
    expect(r.unfinished).toBe(0);
    expect(r.clients[0]!.mode).toBe('closed');
    expect(r.completed + r.rejected).toBe(r.offered);
  });

  it('works in any order of edge components', () => {
    for (const order of [['waf', 'cdn', 'gw'], ['gw', 'waf', 'cdn'], ['cdn', 'gw', 'waf']] as const) {
      const r = runSimulation(everything({}, { order: [...order] }));
      const chain = validateAndResolve(everything({}, { order: [...order] })).routes[0]!.edgeChain.map((h) => h.nodeId);
      expect(chain).toEqual([...order]);
      expect(r.status).toBe('completed');
      expect(r.unfinished).toBe(0);
      expect(station(r, 'cdn').hits! + station(r, 'waf').blocked! + served(r)).toBe(600);
      expect(r.completed + r.rejected).toBe(600);
    }
  });

  it('lets the gateway shield everything behind it from a burst', () => {
    // Ten times the load for two seconds in every ten, on servers doing 40 ms
    // of work each: without a limit the servers pile up; with one, they do not.
    const burst = {
      ...everything().workload,
      arrivalPattern: 'burst' as const,
      arrivalOptions: { rampStartMultiplier: 1, rampEndMultiplier: 1, burstPeriodSeconds: 10, burstDurationSeconds: 2, burstMultiplier: 10 },
    };
    const shape = (limit: number | null) => ({ ...everything({}, { hitRate: 0, blockRate: 0, limit, cpuMs: 40 }), workload: burst });
    const open = runSimulation(shape(null));
    const limited = runSimulation(shape(30));
    expect(station(open, 'apiGateway').throttled).toBe(0);
    expect(station(limited, 'apiGateway').throttled).toBeGreaterThan(0);
    const peak = (r: SimulationResult) => Math.max(...r.servers.filter((s) => s.nodeId !== 'w1').map((s) => s.concurrencyPeak));
    expect(peak(limited)).toBeLessThan(peak(open));
    // What the gateway refused never became a message either.
    expect(limited.messagesPublished).toBe(served(limited));
  });

  it('shares one edge between two groups of users', () => {
    const d = everything();
    d.nodes.push(client('c2', { requestRateOverridePerSecond: 10, requestBytes: 500, responseBytes: 5000 }));
    d.edges.push(edge('c2', 'cdn', INSTANT));
    const r = runSimulation(d);
    expect(r.offered).toBe(900);
    expect(station(r, 'cdn').operations).toBe(900);
    // User traffic and background jobs are reported separately.
    const users = r.clients;
    expect(users.map((c) => c.offered).sort((a, b) => a - b)).toEqual([300, 600]);
    expect(users.every((c) => c.completed > 0)).toBe(true);
    expect(r.clients.some((c) => c.nodeId === 'q')).toBe(false);
    expect(r.queues.find((q) => q.nodeId === 'q')!.enqueued).toBe(r.messagesPublished);
    expect(r.unfinished).toBe(0);
  });

  it('prices every component from what the run measured', () => {
    const d = everything();
    for (const node of d.nodes) node.cloud = { profileId: DEFAULT_CLOUD_PROFILE_BY_KIND[node.kind] };
    const r = runSimulation(d);
    const estimate = estimateCost({ document: d, catalog, usage: r.usage });

    // Every priceable component has at least one line, and none is unpriced.
    const kinds = new Set(estimate.lines.map((l) => l.componentKind));
    expect([...kinds].sort()).toEqual(['apiGateway', 'cache', 'cdn', 'database', 'dns', 'loadBalancer', 'queue', 'server', 'waf']);
    expect(estimate.unpricedLineCount).toBe(0);
    expect(estimate.lines.every((l) => l.verified)).toBe(true);
    expect(Number(estimate.totalMonthly)).toBeGreaterThan(0);

    // Metered lines are built from each component's own count.
    const requestsLine = (id: string) => estimate.lines.find((l) => l.nodeId === id && l.chargeType === 'requests')!;
    const perMonth = (count: number, perOp = 1) => (count * perOp / r.usage.measuredSeconds) * 730 * 3600 / 1_000_000;
    expect(Number(requestsLine('cdn').quantity)).toBeCloseTo(perMonth(station(r, 'cdn').operations), 6);
    expect(Number(requestsLine('waf').quantity)).toBeCloseTo(perMonth(station(r, 'waf').operations), 6);
    expect(Number(requestsLine('gw').quantity)).toBeCloseTo(perMonth(station(r, 'apiGateway').operations), 6);
    expect(Number(requestsLine('dns').quantity)).toBeCloseTo(perMonth(station(r, 'dns').operations), 6);
    expect(Number(requestsLine('q').quantity)).toBeCloseTo(perMonth(r.messagesPublished, 3), 6);

    // Bytes to users are the CDN's egress line, and nothing else's.
    const egressLines = estimate.lines.filter((l) => l.chargeType === 'egress' && Number(l.quantity) > 0);
    expect(egressLines.map((l) => l.nodeId)).toEqual(['cdn']);
  });
});

// =============================================================================
// All fifteen: the ten above, plus a serverless function beside the server, a
// read replica, a key-value store, object storage, and a topic with two
// listeners — one a server, one a function.
// =============================================================================

function raw<K extends ArchNode['kind']>(id: string, kind: K, settings: unknown): ArchNode {
  return { id, name: id, kind, position: { x: 0, y: 0 }, cloud: { profileId: null }, settings } as ArchNode;
}

function fifteen(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    client('c1', { requestRateOverridePerSecond: 20, requestBytes: 500, responseBytes: 5000 }),
    dns('dns', { lookupShare: 0.1, lookupServiceTimeMs: 2 }),
    cdn('cdn', { hitRate: 0.5, serviceTimeMs: 1 }),
    waf('waf', { blockRate: 0.1, serviceTimeMs: 1 }),
    apiGateway('gw', { rateLimitPerSecond: null, serviceTimeMs: 1 }),
    loadBalancer('lb', { serviceTimeMs: 1 }),
    server('s1', SERVER),
    raw('f1', 'serverless', { ...DEFAULT_SERVERLESS_SETTINGS, cpuMsPerRequest: 5, coldStartShare: 0.1, coldStartMs: 50 }),
    cache('cache', { hitRate: 0.5, lookupServiceTimeMs: 1, populateOnMiss: true }),
    database('db', { queryServiceTimeMs: 3, readShare: 0.8 }),
    raw('r1', 'readReplica', { ...DEFAULT_READ_REPLICA_SETTINGS, queryServiceTimeMs: 3 }),
    raw('kv', 'kvStore', { ...DEFAULT_KV_STORE_SETTINGS, readShare: 0.7 }),
    raw('os', 'objectStorage', { ...DEFAULT_OBJECT_STORAGE_SETTINGS, writeShare: 0.2, objectBytes: 10_000 }),
    queue('q', { publishServiceTimeMs: 1 }),
    server('w1', { ...SERVER, cpuMsPerRequest: 2 }),
    raw('t', 'pubsub', { ...DEFAULT_PUBSUB_SETTINGS, publishServiceTimeMs: 1 }),
    server('l1', { ...SERVER, cpuMsPerRequest: 2 }),
    raw('l2', 'serverless', { ...DEFAULT_SERVERLESS_SETTINGS, cpuMsPerRequest: 2, coldStartShare: 0 }),
  ];
  const edges: ArchEdge[] = [
    edge('c1', 'dns', INSTANT),
    edge('c1', 'cdn', INSTANT), edge('cdn', 'waf', INSTANT), edge('waf', 'gw', INSTANT), edge('gw', 'lb', INSTANT),
    edge('lb', 's1', INSTANT), edge('lb', 'f1', INSTANT),
    edge('db', 'r1', INSTANT),
    edge('q', 'w1', INSTANT), edge('w1', 'db', INSTANT),
    edge('t', 'l1', INSTANT), edge('t', 'l2', INSTANT),
  ];
  for (const compute of ['s1', 'f1']) {
    for (const target of ['cache', 'db', 'r1', 'kv', 'os', 'q', 't']) edges.push(edge(compute, target, INSTANT));
  }
  return doc(nodes, edges, { durationSeconds: 30, drainSeconds: 20, seed: 5 });
}

describe('all fifteen components together', () => {
  it('is a valid design', () => {
    const resolved = validateAndResolve(fifteen());
    expect(resolved.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(resolved.routes).toHaveLength(1);
    expect(resolved.routes[0]!.branches.map((b) => b.computeKind).sort()).toEqual(['server', 'serverless']);
    expect(resolved.routes[0]!.branches.every((b) => b.replicas.length === 1 && b.kvStoreId && b.objectStorageId && b.queueId && b.pubsubId)).toBe(true);
    // A queue's one consumer, and the topic's two.
    expect(resolved.consumers.map((c) => `${c.queueId}->${c.branch.serverId}`).sort()).toEqual(['q->w1', 't->l1', 't->l2']);
  });

  it('accounts for every request and every copy, front to back', () => {
    const r = runSimulation(fifteen());
    const st = (id: string) => r.stations.find((s) => s.nodeId === id)!;
    const sv = (id: string) => r.servers.find((s) => s.nodeId === id)!;
    expect(r.status).toBe('completed');
    expect(r.unfinished).toBe(0);
    expect(r.offered).toBe(600);

    // Front: the same reconciliation as with ten.
    const reachedOrigin = st('gw').operations;
    expect(reachedOrigin).toBe(st('cdn').misses! - st('waf').blocked!);
    const served = sv('s1').completed + sv('f1').completed;
    expect(served).toBe(reachedOrigin);
    expect(sv('s1').completed).toBeGreaterThan(0);
    expect(sv('f1').completed).toBeGreaterThan(0);
    expect(sv('f1').kind).toBe('serverless');
    expect(sv('f1').throttled).toBe(0);

    // Stores: each request served did one cache lookup and one object
    // operation; a key-value read only on a cache miss, a write regardless;
    // and on a miss a database read, from the replica, or a write, on the
    // primary. The worker's jobs also query the database.
    expect(st('cache').hits! + st('cache').misses!).toBe(served);
    expect(st('os').operations).toBe(served);
    expect(st('kv').writes! + st('kv').reads!).toBeLessThanOrEqual(served);
    expect(st('kv').reads).toBeLessThanOrEqual(st('cache').misses!);
    expect(st('r1').reads).toBeGreaterThan(0);
    expect(st('db').writes).toBeGreaterThan(0);
    expect(st('r1').applied).toBe(st('db').writes);
    expect(st('r1').reads! + st('db').operations).toBe(st('cache').misses! + sv('w1').completed);

    // Messaging: one message per served request on the queue, one event per
    // served request on the topic, delivered to both listeners.
    expect(r.messagesPublished).toBe(served * 2);
    expect(r.queues.find((q) => q.nodeId === 'q')!.processed).toBe(served);
    expect(sv('w1').completed).toBe(served);
    for (const listener of ['l1', 'l2']) {
      expect(r.queues.find((q) => q.consumerId === listener)!.processed).toBe(served);
      expect(sv(listener).completed).toBe(served);
    }
    expect(st('t').dropped).toBe(0);

    // Nothing lost, nothing counted twice.
    expect(st('cdn').hits! + st('waf').blocked! + served).toBe(600);
    expect(r.completed + r.rejected).toBe(600);
    expect(r.rejectionsByReason).toEqual({ 'waf-blocked': st('waf').blocked });
  });

  it('prices all fourteen priceable kinds from the run, with the two-rate stores split', () => {
    const d = fifteen();
    for (const node of d.nodes) node.cloud = { profileId: DEFAULT_CLOUD_PROFILE_BY_KIND[node.kind] };
    const r = runSimulation(d);
    const estimate = estimateCost({ document: d, catalog, usage: r.usage });
    expect(estimate.unpricedLineCount).toBe(0);
    expect(estimate.lines.every((l) => l.verified)).toBe(true);
    const kinds = new Set(estimate.lines.map((l) => l.componentKind));
    expect([...kinds].sort()).toEqual([
      'apiGateway', 'cache', 'cdn', 'database', 'dns', 'kvStore', 'loadBalancer',
      'objectStorage', 'pubsub', 'queue', 'readReplica', 'server', 'serverless', 'waf',
    ]);
    const types = (id: string) => estimate.lines.filter((l) => l.nodeId === id).map((l) => l.chargeType).sort();
    expect(types('kv')).toEqual(['requests', 'storage', 'writes']);
    expect(types('os')).toEqual(['requests', 'storage', 'writes']);
    expect(types('f1')).toEqual(['duration', 'requests']);
    expect(types('r1')).toEqual(['compute', 'storage']);
    expect(types('t')).toEqual(['requests']);
    expect(Number(estimate.totalMonthly)).toBeGreaterThan(0);
  });
});
