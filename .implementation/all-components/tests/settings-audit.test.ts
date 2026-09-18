import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { estimateCost } from '../src/pricing/pricing';
import {
  DEFAULT_KV_STORE_SETTINGS,
  DEFAULT_OBJECT_STORAGE_SETTINGS,
  DEFAULT_PUBSUB_SETTINGS,
  DEFAULT_READ_REPLICA_SETTINGS,
  DEFAULT_SERVERLESS_SETTINGS,
  SERVER_HARDWARE_PROFILES,
} from '../src/domain/defaults';
import { runSimulation } from '../src/simulation/engine';
import type { SimulationResult } from '../src/simulation/types';
import type {
  ApiGatewaySettings,
  ArchEdge,
  ArchNode,
  CacheSettings,
  CdnSettings,
  ClientSettings,
  DatabaseSettings,
  DnsSettings,
  KvStoreSettings,
  LinkSettings,
  LoadBalancerSettings,
  ObjectStorageSettings,
  PubSubSettings,
  QueueSettings,
  ReadReplicaSettings,
  ServerSettings,
  ServerlessSettings,
  WafSettings,
  Workload,
} from '../src/domain/types';
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
 * Every setting on every component, held to one question: does changing it
 * change a run in the direction its label promises?
 *
 * A setting that exists in the form but does nothing is worse than no setting,
 * because it teaches a false cause. So each one here has a baseline, a change,
 * and one measurable consequence. Settings that are documented as affecting
 * cost only are held to the cost estimate instead.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);

/** A server with nothing in the way: plenty of everything, 5 ms of CPU. */
const OPEN_SERVER: Partial<ServerSettings> = {
  profile: 'custom',
  cpuSlots: 8,
  cpuMsPerRequest: 5,
  concurrencyLimit: 10_000,
  ramMb: 1_000_000,
  baselineMemoryMb: 0,
  memoryPerRequestMb: 1,
  memoryPerQueuedRequestMb: 0,
  queueLimit: 100_000,
};

/** Users sending 20 requests a second, with nothing on the wire. */
const OPEN_CLIENT: Partial<ClientSettings> = {
  requestRateOverridePerSecond: 20,
  requestBytes: 0,
  responseBytes: 0,
};

interface Parts {
  client?: Partial<ClientSettings>;
  dns?: Partial<DnsSettings>;
  cdn?: Partial<CdnSettings>;
  waf?: Partial<WafSettings>;
  gateway?: Partial<ApiGatewaySettings>;
  lb?: Partial<LoadBalancerSettings>;
  servers?: number;
  server?: Partial<ServerSettings>;
  /** Overrides for the second server and beyond, when they should differ. */
  otherServers?: Partial<ServerSettings>;
  db?: Partial<DatabaseSettings>;
  cache?: Partial<CacheSettings>;
  queue?: Partial<QueueSettings>;
  worker?: Partial<ServerSettings>;
  link?: LinkSettings;
  workload?: Partial<Workload>;
}

/**
 * Assemble a design from the parts named. The path is always
 * Users [-> DNS beside] -> [CDN] -> [WAF] -> [Gateway] -> (LB -> N servers | server),
 * and each server gets the cache, database and queue that were asked for.
 */
function design(parts: Parts) {
  const link = parts.link ?? INSTANT;
  const nodes: ArchNode[] = [client('c1', { ...OPEN_CLIENT, ...parts.client })];
  const edges: ArchEdge[] = [];
  if (parts.dns) {
    nodes.push(dns('dns', parts.dns));
    edges.push(edge('c1', 'dns', link));
  }
  const chain: string[] = ['c1'];
  if (parts.cdn) {
    nodes.push(cdn('cdn', parts.cdn));
    chain.push('cdn');
  }
  if (parts.waf) {
    nodes.push(waf('waf', parts.waf));
    chain.push('waf');
  }
  if (parts.gateway) {
    nodes.push(apiGateway('gw', parts.gateway));
    chain.push('gw');
  }
  const serverIds: string[] = [];
  const count = parts.servers ?? 1;
  for (let i = 1; i <= count; i += 1) {
    const id = `s${i}`;
    nodes.push(server(id, { ...OPEN_SERVER, ...parts.server, ...(i > 1 ? parts.otherServers : {}) }));
    serverIds.push(id);
  }
  if (parts.lb || count > 1) {
    nodes.push(loadBalancer('lb', parts.lb));
    chain.push('lb');
    for (let i = 0; i < chain.length - 1; i += 1) edges.push(edge(chain[i]!, chain[i + 1]!, link));
    for (const id of serverIds) edges.push(edge('lb', id, link));
  } else {
    chain.push('s1');
    for (let i = 0; i < chain.length - 1; i += 1) edges.push(edge(chain[i]!, chain[i + 1]!, link));
  }
  if (parts.db) nodes.push(database('db', parts.db));
  if (parts.cache) nodes.push(cache('cache', parts.cache));
  if (parts.queue) {
    nodes.push(queue('q', parts.queue));
    nodes.push(server('w1', { ...OPEN_SERVER, ...parts.worker }));
    edges.push(edge('q', 'w1', link));
    if (parts.db) edges.push(edge('w1', 'db', link));
  }
  for (const id of serverIds) {
    if (parts.cache) edges.push(edge(id, 'cache', link));
    if (parts.db) edges.push(edge(id, 'db', link));
    if (parts.queue) edges.push(edge(id, 'q', link));
  }
  return doc(nodes, edges, { durationSeconds: 30, drainSeconds: 10, seed: 7, ...parts.workload });
}

const run = (parts: Parts): SimulationResult => runSimulation(design(parts));
const mean = (r: SimulationResult) => r.responseTime.meanMs;
const station = (r: SimulationResult, kind: string) => r.stations.find((s) => s.kind === kind)!;
const linkBytes = (r: SimulationResult, from: string, to: string) =>
  r.links.filter((l) => l.fromId === from && l.toId === to).reduce((n, l) => n + l.bytes, 0);

/** A run that must be clean before a setting is allowed to make it dirty. */
function expectClean(r: SimulationResult) {
  expect(r.status).toBe('completed');
  expect(r.rejected).toBe(0);
  expect(r.unfinished).toBe(0);
}

// ---------------------------------------------------------------- Users

describe('Users', () => {
  it('activeUsers: more users, more requests', () => {
    const few = run({ client: { requestRateOverridePerSecond: null, activeUsers: 60, actionsPerUserPerMinute: 10 } });
    const many = run({ client: { requestRateOverridePerSecond: null, activeUsers: 120, actionsPerUserPerMinute: 10 } });
    expect(few.offered).toBe(300); // 60 users x 10/min = 10/s x 30 s
    expect(many.offered).toBe(600);
  });

  it('actionsPerUserPerMinute: busier users, more requests', () => {
    const slow = run({ client: { requestRateOverridePerSecond: null, activeUsers: 60, actionsPerUserPerMinute: 10 } });
    const fast = run({ client: { requestRateOverridePerSecond: null, activeUsers: 60, actionsPerUserPerMinute: 20 } });
    expect(fast.offered).toBe(slow.offered * 2);
  });

  it('requestRateOverridePerSecond: replaces the users x actions sum', () => {
    const r = run({ client: { activeUsers: 1, actionsPerUserPerMinute: 1, requestRateOverridePerSecond: 20 } });
    expect(r.offered).toBe(600);
  });

  it('mode: closed users wait for their answer, so they send fewer requests', () => {
    const open = run({ client: { requestRateOverridePerSecond: null, activeUsers: 10, actionsPerUserPerMinute: 60, mode: 'open' } });
    const closed = run({ client: { requestRateOverridePerSecond: null, activeUsers: 10, actionsPerUserPerMinute: 60, mode: 'closed', thinkTimeMs: 1000 } });
    // Open: 10 users x 1/s for 30 s = 300. Closed: at most one request in
    // flight per user, so ~10 users / (1 s think + 5 ms) over 30 s ≈ 300 too,
    // but staggered starts and think-time draws make it differ; what must
    // hold is that it is bounded by the population.
    expect(open.offered).toBe(300);
    expect(closed.clients[0]!.mode).toBe('closed');
    expect(closed.offered).toBeLessThanOrEqual(10 * 31);
    expect(closed.offered).toBeGreaterThan(200);
  });

  it('thinkTimeMs: closed users who think longer send fewer requests', () => {
    const quick = run({ client: { requestRateOverridePerSecond: null, activeUsers: 10, mode: 'closed', thinkTimeMs: 500 } });
    const slow = run({ client: { requestRateOverridePerSecond: null, activeUsers: 10, mode: 'closed', thinkTimeMs: 2000 } });
    expect(slow.offered).toBeLessThan(quick.offered);
  });

  it('requestBytes: bigger requests, more bytes on the wire and longer on a slow link', () => {
    // 100,000 bytes at 100 Mbps is 8 ms per request: 16% of the link at 20/s.
    const link: LinkSettings = { propagationDelayMs: 0, bandwidthMbps: 100 };
    const small = run({ client: { requestBytes: 1_000 }, link });
    const big = run({ client: { requestBytes: 100_000 }, link });
    expectClean(big);
    expect(linkBytes(big, 'c1', 's1')).toBe(100 * linkBytes(small, 'c1', 's1'));
    expect(mean(big)).toBeGreaterThan(mean(small));
  });

  it('responseBytes: bigger responses, more bytes back to users', () => {
    const small = run({ client: { responseBytes: 1_000 } });
    const big = run({ client: { responseBytes: 50_000 } });
    expect(big.bytesEgressToClients).toBe(50 * small.bytesEgressToClients);
    expect(big.usage.egressByNodeId['s1']).toBe(50 * small.usage.egressByNodeId['s1']!);
  });
});

// ---------------------------------------------------------- Load Balancer

describe('Load Balancer', () => {
  const base: Parts = { lb: { maxConcurrentRequests: 1000, serviceTimeMs: 1, queueLimit: 1000 }, servers: 2 };

  it('serviceTimeMs: slower forwarding, slower responses', () => {
    const quick = run(base);
    const slow = run({ ...base, lb: { ...base.lb, serviceTimeMs: 20 } });
    expectClean(quick);
    expect(mean(slow)).toBeCloseTo(mean(quick) + 19, 3);
  });

  it('maxConcurrentRequests: one slot with 100 ms of work at 20/s cannot keep up', () => {
    const wide = run({ ...base, lb: { ...base.lb, serviceTimeMs: 100 } });
    const narrow = run({ ...base, lb: { ...base.lb, serviceTimeMs: 100, maxConcurrentRequests: 1 } });
    expect(station(wide, 'loadBalancer').queuePeak).toBe(0);
    expect(station(narrow, 'loadBalancer').queuePeak).toBeGreaterThan(0);
    expect(mean(narrow)).toBeGreaterThan(mean(wide));
  });

  it('queueLimit: no room to wait means rejections at the balancer', () => {
    const r = run({ ...base, lb: { serviceTimeMs: 100, maxConcurrentRequests: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['balancer-queue-full']).toBeGreaterThan(0);
  });

  it('policy: least-busy sends more to the faster server; round-robin splits evenly', () => {
    const uneven: Parts = {
      ...base,
      server: { cpuMsPerRequest: 5 },
      otherServers: { cpuMsPerRequest: 200, cpuSlots: 1 },
    };
    const rr = run({ ...uneven, lb: { ...base.lb, policy: 'round-robin' } });
    const lb = run({ ...uneven, lb: { ...base.lb, policy: 'least-busy' } });
    const admitted = (r: SimulationResult) => r.servers.map((s) => s.admitted);
    expect(admitted(rr)).toEqual([300, 300]);
    expect(admitted(lb)[0]).toBeGreaterThan(admitted(lb)[1]!);
  });
});

// ------------------------------------------------------------ Application Server

describe('Application Server', () => {
  it('profile: a named size carries its hardware', () => {
    // The form applies the size; the engine only ever sees the fields. This
    // holds the catalog to its own labels so the form cannot drift from them.
    const small = SERVER_HARDWARE_PROFILES.find((p) => p.id === 'small')!;
    const xlarge = SERVER_HARDWARE_PROFILES.find((p) => p.id === 'xlarge')!;
    expect(small.cpuSlots).toBeLessThan(xlarge.cpuSlots);
    expect(small.ramMb).toBeLessThan(xlarge.ramMb);
    const a = run({ server: { cpuSlots: small.cpuSlots, cpuMsPerRequest: 60 } });
    const b = run({ server: { cpuSlots: xlarge.cpuSlots, cpuMsPerRequest: 60 } });
    expect(mean(b)).toBeLessThan(mean(a));
  });

  it('cpuSlots: more slots, less waiting for CPU', () => {
    const one = run({ server: { cpuSlots: 1, cpuMsPerRequest: 60 } }); // 120% busy
    const four = run({ server: { cpuSlots: 4, cpuMsPerRequest: 60 } });
    expect(one.waitByStageMs.serverCpu).toBeGreaterThan(0);
    expect(four.waitByStageMs.serverCpu).toBe(0);
    expect(mean(four)).toBeLessThan(mean(one));
  });

  it('cpuMsPerRequest: more work per request, slower responses', () => {
    const light = run({ server: { cpuMsPerRequest: 5 } });
    const heavy = run({ server: { cpuMsPerRequest: 25 } });
    expect(mean(heavy)).toBeCloseTo(mean(light) + 20, 3);
  });

  it('concurrencyLimit: one request held open at a time makes the rest wait for admission', () => {
    const wide = run({ server: { cpuMsPerRequest: 100 } });
    const narrow = run({ server: { cpuMsPerRequest: 100, concurrencyLimit: 1 } });
    expect(wide.waitByStageMs.serverAdmission).toBe(0);
    expect(narrow.waitByStageMs.serverAdmission).toBeGreaterThan(0);
  });

  // Memory works like a second concurrency limit: a request that does not fit
  // waits for admission, and is refused only when the waiting line itself
  // would not fit in memory. So each memory setting is held to both.
  const MEM: Partial<ServerSettings> = { cpuMsPerRequest: 100, memoryPerQueuedRequestMb: 10 };

  it('ramMb: too little memory makes requests wait, then turns them away', () => {
    const roomy = run({ server: { ...MEM, ramMb: 10_000, memoryPerRequestMb: 50 } });
    const tight = run({ server: { ...MEM, ramMb: 60, memoryPerRequestMb: 50 } });
    expectClean(roomy);
    expect(tight.waitByStageMs.serverAdmission).toBeGreaterThan(0);
    expect(tight.rejectionsByReason['server-memory-full']).toBeGreaterThan(0);
  });

  it('baselineMemoryMb: the process itself takes room away from requests', () => {
    const light = run({ server: { ...MEM, ramMb: 400, baselineMemoryMb: 0, memoryPerRequestMb: 50 } });
    const heavy = run({ server: { ...MEM, ramMb: 400, baselineMemoryMb: 330, memoryPerRequestMb: 50 } });
    expectClean(light);
    expect(heavy.rejectionsByReason['server-memory-full']).toBeGreaterThan(0);
  });

  it('memoryPerRequestMb: fatter requests fill memory sooner', () => {
    const thin = run({ server: { ...MEM, ramMb: 400, memoryPerRequestMb: 1 } });
    const fat = run({ server: { ...MEM, ramMb: 400, memoryPerRequestMb: 300 } });
    expectClean(thin);
    expect(fat.rejectionsByReason['server-memory-full']).toBeGreaterThan(0);
  });

  it('memoryPerQueuedRequestMb: waiting requests can fill memory too', () => {
    const queued: Partial<ServerSettings> = { concurrencyLimit: 1, cpuMsPerRequest: 100, ramMb: 200, memoryPerRequestMb: 1 };
    const free = run({ server: { ...queued, memoryPerQueuedRequestMb: 0 } });
    const costly = run({ server: { ...queued, memoryPerQueuedRequestMb: 100 } });
    expect(free.rejectionsByReason['server-memory-full']).toBeUndefined();
    expect(costly.rejectionsByReason['server-memory-full']).toBeGreaterThan(0);
    expect(costly.servers[0]!.peakMemoryMb).toBeGreaterThan(free.servers[0]!.peakMemoryMb);
  });

  it('queueLimit: no room to wait for admission means rejections at the server', () => {
    const r = run({ server: { concurrencyLimit: 1, cpuMsPerRequest: 100, queueLimit: 0 } });
    expect(r.rejectionsByReason['server-queue-full']).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ Database

describe('Database', () => {
  const base: Parts = { db: { queryServiceTimeMs: 5, maxConcurrentQueries: 100, queueLimit: 1000, queryRequestBytes: 0, queryResultBytes: 0 } };

  it('queryServiceTimeMs: slower queries, slower responses', () => {
    const quick = run(base);
    const slow = run({ db: { ...base.db, queryServiceTimeMs: 25 } });
    expect(slow.databaseQueries).toBe(600);
    expect(mean(slow)).toBeCloseTo(mean(quick) + 20, 3);
  });

  it('maxConcurrentQueries: one slot with 100 ms queries at 20/s builds a queue', () => {
    const wide = run({ db: { ...base.db, queryServiceTimeMs: 100 } });
    const narrow = run({ db: { ...base.db, queryServiceTimeMs: 100, maxConcurrentQueries: 1 } });
    expect(wide.waitByStageMs.database).toBe(0);
    expect(narrow.waitByStageMs.database).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the database', () => {
    const r = run({ db: { ...base.db, queryServiceTimeMs: 100, maxConcurrentQueries: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['database-queue-full']).toBeGreaterThan(0);
  });

  it('queryRequestBytes and queryResultBytes: bytes on the server-database links', () => {
    const r = run({ db: { ...base.db, queryRequestBytes: 100, queryResultBytes: 1000 } });
    expect(linkBytes(r, 's1', 'db')).toBe(600 * 100);
    expect(linkBytes(r, 'db', 's1')).toBe(600 * 1000);
  });

  it('dataSizeGb: cost only — more data, a bigger storage line, and no change to the run', () => {
    const small = design({ db: { ...base.db, dataSizeGb: 10 } });
    const big = design({ db: { ...base.db, dataSizeGb: 1000 } });
    expect(runSimulation(small).responseTime).toEqual(runSimulation(big).responseTime);
    const priced = (d: typeof small) => {
      const node = d.nodes.find((n) => n.kind === 'database')!;
      node.cloud = { profileId: 'aws.rds.m7g-large-postgres.us-east-1' };
      return estimateCost({ document: d, catalog, usage: null }).lines.find((l) => l.chargeType === 'storage')!;
    };
    expect(Number(priced(big).monthly)).toBeCloseTo(100 * Number(priced(small).monthly), 6);
  });
});

// --------------------------------------------------------------------- Cache

describe('Cache', () => {
  const base: Parts = {
    db: { queryServiceTimeMs: 20, maxConcurrentQueries: 100, queueLimit: 1000, queryRequestBytes: 0, queryResultBytes: 0 },
    cache: { hitRate: 0.5, lookupServiceTimeMs: 1, maxConcurrentLookups: 100, queueLimit: 1000, populateOnMiss: false, lookupRequestBytes: 0, lookupResultBytes: 0, populateBytes: 0 },
  };

  it('hitRate: every hit is a query the database never sees', () => {
    const all = run({ ...base, cache: { ...base.cache, hitRate: 1 } });
    const none = run({ ...base, cache: { ...base.cache, hitRate: 0 } });
    expect(all.cacheHits).toBe(600);
    expect(all.databaseQueries).toBe(0);
    expect(none.cacheMisses).toBe(600);
    expect(none.databaseQueries).toBe(600);
    expect(mean(all)).toBeLessThan(mean(none));
  });

  it('lookupServiceTimeMs: slower lookups, slower responses', () => {
    const quick = run({ ...base, cache: { ...base.cache, hitRate: 1 } });
    const slow = run({ ...base, cache: { ...base.cache, hitRate: 1, lookupServiceTimeMs: 11 } });
    expect(mean(slow)).toBeCloseTo(mean(quick) + 10, 3);
  });

  it('maxConcurrentLookups: one slot with 100 ms lookups builds a queue', () => {
    const narrow = run({ ...base, cache: { ...base.cache, hitRate: 1, lookupServiceTimeMs: 100, maxConcurrentLookups: 1 } });
    expect(narrow.waitByStageMs.cache).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the cache', () => {
    const r = run({ ...base, cache: { ...base.cache, hitRate: 1, lookupServiceTimeMs: 100, maxConcurrentLookups: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['cache-queue-full']).toBeGreaterThan(0);
  });

  it('populateOnMiss and populateServiceTimeMs: a miss writes back, and the write takes time', () => {
    const off = run({ ...base, cache: { ...base.cache, hitRate: 0, populateOnMiss: false } });
    const on = run({ ...base, cache: { ...base.cache, hitRate: 0, populateOnMiss: true, populateServiceTimeMs: 3 } });
    const slower = run({ ...base, cache: { ...base.cache, hitRate: 0, populateOnMiss: true, populateServiceTimeMs: 13 } });
    expect(off.cachePopulates).toBe(0);
    expect(on.cachePopulates).toBe(600);
    expect(mean(on)).toBeCloseTo(mean(off) + 3, 3);
    expect(mean(slower)).toBeCloseTo(mean(on) + 10, 3);
  });

  it('lookupRequestBytes, lookupResultBytes, populateBytes: bytes on the server-cache links', () => {
    const r = run({ ...base, cache: { ...base.cache, hitRate: 1, lookupRequestBytes: 10, lookupResultBytes: 100 } });
    expect(linkBytes(r, 's1', 'cache')).toBe(600 * 10);
    expect(linkBytes(r, 'cache', 's1')).toBe(600 * 100);
    const w = run({ ...base, cache: { ...base.cache, hitRate: 0, populateOnMiss: true, lookupRequestBytes: 0, lookupResultBytes: 0, populateBytes: 1000 } });
    expect(linkBytes(w, 's1', 'cache')).toBe(600 * 1000);
  });

  it('capacityGb: changes nothing in a run, and nothing on a cloud-priced cache either', () => {
    // Recorded, not fixed: the label says "used for configuration and pricing",
    // but no priced cache profile carries a storage charge, so the number has
    // no effect anywhere unless the profile is self-managed. See decisions 054.
    const small = design({ ...base, cache: { ...base.cache, capacityGb: 1 } });
    const big = design({ ...base, cache: { ...base.cache, capacityGb: 1000 } });
    expect(runSimulation(small).responseTime).toEqual(runSimulation(big).responseTime);
    const total = (d: typeof small) => {
      const node = d.nodes.find((n) => n.kind === 'cache')!;
      node.cloud = { profileId: 'aws.elasticache.r7g-large-redis.us-east-1' };
      return estimateCost({ document: d, catalog, usage: null }).lines.filter((l) => l.nodeId === 'cache').map((l) => l.monthly);
    };
    expect(total(big)).toEqual(total(small));
  });
});

// ------------------------------------------------------------- Message Queue

describe('Message Queue', () => {
  const base: Parts = {
    queue: { maxDepth: 10_000, publishServiceTimeMs: 1, maxConcurrentPublishes: 100, publishQueueLimit: 1000, messageBytes: 0 },
    worker: { cpuMsPerRequest: 5 },
  };

  it('publishServiceTimeMs: the caller waits for the acknowledgement, and only that', () => {
    const quick = run(base);
    const slow = run({ ...base, queue: { ...base.queue, publishServiceTimeMs: 11 } });
    expect(quick.messagesPublished).toBe(600);
    expect(mean(slow)).toBeCloseTo(mean(quick) + 10, 3);
  });

  it('maxConcurrentPublishes: one slot with 100 ms publishes builds a queue at the broker', () => {
    const narrow = run({ ...base, queue: { ...base.queue, publishServiceTimeMs: 100, maxConcurrentPublishes: 1 } });
    expect(narrow.waitByStageMs.queue).toBeGreaterThan(0);
  });

  it('publishQueueLimit: no room to wait means the publish fails', () => {
    const r = run({ ...base, queue: { ...base.queue, publishServiceTimeMs: 100, maxConcurrentPublishes: 1, publishQueueLimit: 0 } });
    expect(r.rejectionsByReason['queue-publish-full']).toBeGreaterThan(0);
  });

  it('maxDepth: a slow worker fills the backlog, and a full backlog refuses publishes', () => {
    const slowWorker: Partial<ServerSettings> = { cpuSlots: 1, concurrencyLimit: 1, cpuMsPerRequest: 500 };
    const deep = run({ ...base, worker: slowWorker, queue: { ...base.queue, maxDepth: 10_000 } });
    const shallow = run({ ...base, worker: slowWorker, queue: { ...base.queue, maxDepth: 5 } });
    expect(deep.queues[0]!.outstanding).toBeGreaterThan(5);
    expect(deep.queues[0]!.refused).toBe(0);
    expect(shallow.queues[0]!.refused).toBeGreaterThan(0);
    expect(shallow.rejectionsByReason['queue-full']).toBe(shallow.queues[0]!.refused);
  });

  it('messageBytes: bytes on the server-queue link', () => {
    const r = run({ ...base, queue: { ...base.queue, messageBytes: 250 } });
    expect(linkBytes(r, 's1', 'q')).toBe(600 * 250);
  });
});

// ------------------------------------------------------------------------ DNS

describe('DNS', () => {
  const base: Parts = { dns: { lookupShare: 1, lookupServiceTimeMs: 5, maxConcurrentLookups: 100, queueLimit: 1000, queryBytes: 0, answerBytes: 0 } };

  it('lookupShare: the share of requests that ask first', () => {
    const none = run({ dns: { ...base.dns, lookupShare: 0 } });
    const all = run(base);
    expect(station(none, 'dns').operations).toBe(0);
    expect(station(all, 'dns').operations).toBe(600);
    expect(mean(all)).toBeCloseTo(mean(none) + 5, 3);
  });

  it('lookupServiceTimeMs: slower answers, later starts', () => {
    const quick = run(base);
    const slow = run({ dns: { ...base.dns, lookupServiceTimeMs: 25 } });
    expect(mean(slow)).toBeCloseTo(mean(quick) + 20, 3);
  });

  it('maxConcurrentLookups: one slot with 100 ms lookups builds a queue', () => {
    const narrow = run({ dns: { ...base.dns, lookupServiceTimeMs: 100, maxConcurrentLookups: 1 } });
    expect(narrow.waitByStageMs.dns).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the resolver', () => {
    const r = run({ dns: { ...base.dns, lookupServiceTimeMs: 100, maxConcurrentLookups: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['dns-queue-full']).toBeGreaterThan(0);
  });

  it('queryBytes and answerBytes: bytes on the users-DNS links', () => {
    const r = run({ dns: { ...base.dns, queryBytes: 80, answerBytes: 160 } });
    expect(linkBytes(r, 'c1', 'dns')).toBe(600 * 80);
    expect(linkBytes(r, 'dns', 'c1')).toBe(600 * 160);
  });
});

// ------------------------------------------------------------------------ CDN

describe('CDN', () => {
  const base: Parts = { cdn: { hitRate: 0.5, serviceTimeMs: 1, maxConcurrentRequests: 100, queueLimit: 1000 } };

  it('hitRate: hits never reach the server', () => {
    const all = run({ cdn: { ...base.cdn, hitRate: 1 } });
    const none = run({ cdn: { ...base.cdn, hitRate: 0 } });
    expect(station(all, 'cdn').hits).toBe(600);
    expect(all.servers[0]!.completed).toBe(0);
    expect(station(none, 'cdn').misses).toBe(600);
    expect(none.servers[0]!.completed).toBe(600);
  });

  it('serviceTimeMs: paid on every request, hit or miss', () => {
    const quick = run({ cdn: { ...base.cdn, hitRate: 0 } });
    const slow = run({ cdn: { ...base.cdn, hitRate: 0, serviceTimeMs: 11 } });
    expect(mean(slow)).toBeCloseTo(mean(quick) + 10, 3);
  });

  it('maxConcurrentRequests: one slot with 100 ms of work builds a queue', () => {
    const narrow = run({ cdn: { ...base.cdn, serviceTimeMs: 100, maxConcurrentRequests: 1 } });
    expect(narrow.waitByStageMs.edge).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the CDN', () => {
    const r = run({ cdn: { ...base.cdn, serviceTimeMs: 100, maxConcurrentRequests: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['cdn-queue-full']).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------ WAF

describe('WAF', () => {
  const base: Parts = { waf: { blockRate: 0, serviceTimeMs: 1, maxConcurrentRequests: 100, queueLimit: 1000 } };

  it('blockRate: blocked requests are rejected and never reach the server', () => {
    const none = run(base);
    const all = run({ waf: { ...base.waf, blockRate: 1 } });
    expectClean(none);
    expect(station(all, 'waf').blocked).toBe(600);
    expect(all.rejectionsByReason['waf-blocked']).toBe(600);
    expect(all.servers[0]!.completed).toBe(0);
  });

  it('serviceTimeMs: paid on every request', () => {
    const quick = run(base);
    const slow = run({ waf: { ...base.waf, serviceTimeMs: 11 } });
    expect(mean(slow)).toBeCloseTo(mean(quick) + 10, 3);
  });

  it('maxConcurrentRequests: one slot with 100 ms of inspection builds a queue', () => {
    const narrow = run({ waf: { ...base.waf, serviceTimeMs: 100, maxConcurrentRequests: 1 } });
    expect(narrow.waitByStageMs.edge).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the WAF', () => {
    const r = run({ waf: { ...base.waf, serviceTimeMs: 100, maxConcurrentRequests: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['waf-queue-full']).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- API Gateway

describe('API Gateway', () => {
  const base: Parts = { gateway: { rateLimitPerSecond: null, burstCapacity: 1, serviceTimeMs: 1, maxConcurrentRequests: 100, queueLimit: 1000 } };

  it('rateLimitPerSecond: null lets everything through; a limit refuses the excess', () => {
    const open = run(base);
    const limited = run({ gateway: { ...base.gateway, rateLimitPerSecond: 10 } });
    expectClean(open);
    // 20/s offered, 10/s allowed, over 30 s: about half refused, none queued.
    expect(station(limited, 'apiGateway').throttled).toBeGreaterThan(250);
    expect(station(limited, 'apiGateway').throttled).toBeLessThan(350);
    expect(limited.rejectionsByReason['gateway-throttled']).toBe(station(limited, 'apiGateway').throttled);
    expect(station(limited, 'apiGateway').queuePeak).toBe(0);
  });

  it('burstCapacity: a bigger allowance absorbs a burst that a small one refuses', () => {
    // Bursty arrivals at the same average rate: 5x for 2 s in every 10 s.
    const bursty: Partial<Workload> = {
      arrivalPattern: 'burst',
      arrivalOptions: { rampStartMultiplier: 1, rampEndMultiplier: 1, burstPeriodSeconds: 10, burstDurationSeconds: 2, burstMultiplier: 5 },
    };
    const small = run({ gateway: { ...base.gateway, rateLimitPerSecond: 25, burstCapacity: 1 }, workload: bursty });
    const big = run({ gateway: { ...base.gateway, rateLimitPerSecond: 25, burstCapacity: 500 }, workload: bursty });
    expect(station(small, 'apiGateway').throttled).toBeGreaterThan(0);
    expect(station(big, 'apiGateway').throttled).toBeLessThan(station(small, 'apiGateway').throttled!);
  });

  it('serviceTimeMs: paid on every request', () => {
    const quick = run(base);
    const slow = run({ gateway: { ...base.gateway, serviceTimeMs: 11 } });
    expect(mean(slow)).toBeCloseTo(mean(quick) + 10, 3);
  });

  it('maxConcurrentRequests: one slot with 100 ms of work builds a queue', () => {
    const narrow = run({ gateway: { ...base.gateway, serviceTimeMs: 100, maxConcurrentRequests: 1 } });
    expect(narrow.waitByStageMs.edge).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the gateway', () => {
    const r = run({ gateway: { ...base.gateway, serviceTimeMs: 100, maxConcurrentRequests: 1, queueLimit: 0 } });
    expect(r.rejectionsByReason['gateway-queue-full']).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------- Network

describe('Network connection', () => {
  it('propagationDelayMs: paid once each way', () => {
    const none = run({ link: INSTANT });
    const far = run({ link: { propagationDelayMs: 40, bandwidthMbps: 1_000_000 } });
    expect(mean(far)).toBeCloseTo(mean(none) + 80, 3);
  });

  it('bandwidthMbps: a slower link takes longer to carry the same bytes', () => {
    const fast = run({ client: { requestBytes: 125_000 }, link: { propagationDelayMs: 0, bandwidthMbps: 1000 } });
    const slow = run({ client: { requestBytes: 125_000 }, link: { propagationDelayMs: 0, bandwidthMbps: 100 } });
    // 125,000 bytes = 1 Mbit: 1 ms at 1 Gbps, 10 ms at 100 Mbps.
    expect(mean(slow)).toBeCloseTo(mean(fast) + 9, 3);
  });
});

// ------------------------------------------------------------------ Workload

describe('Workload', () => {
  it('durationSeconds: a longer window offers more requests', () => {
    expect(run({ workload: { durationSeconds: 60 } }).offered).toBe(2 * run({}).offered);
  });

  it('drainSeconds: with no time to finish, slow work is left unfinished', () => {
    const slow: Partial<ServerSettings> = { cpuSlots: 1, cpuMsPerRequest: 100 }; // 200% busy
    const drained = run({ server: slow, workload: { drainSeconds: 120 } });
    const cut = run({ server: slow, workload: { drainSeconds: 0 } });
    expect(drained.unfinished).toBe(0);
    expect(cut.unfinished).toBeGreaterThan(0);
  });

  it('seed: changes every random draw, and nothing else', () => {
    const a = run({ cdn: { hitRate: 0.5 }, workload: { seed: 1 } });
    const b = run({ cdn: { hitRate: 0.5 }, workload: { seed: 2 } });
    const again = run({ cdn: { hitRate: 0.5 }, workload: { seed: 1 } });
    expect(station(a, 'cdn').hits).not.toBe(station(b, 'cdn').hits);
    expect(again.responseTime).toEqual(a.responseTime);
  });

  it('arrivalPattern and arrivalOptions: each shape is its own timing at the same average', () => {
    const opts = { rampStartMultiplier: 0.2, rampEndMultiplier: 1.8, burstPeriodSeconds: 10, burstDurationSeconds: 2, burstMultiplier: 5 };
    // 40 ms of work at one request every 50 ms: never two at once when the
    // spacing is even, and more than one as soon as it is not.
    const slow: Partial<ServerSettings> = { cpuMsPerRequest: 40 };
    const constant = run({ server: slow, workload: { arrivalPattern: 'constant', arrivalOptions: opts } });
    const poisson = run({ server: slow, workload: { arrivalPattern: 'poisson', arrivalOptions: opts } });
    const ramp = run({ server: slow, workload: { arrivalPattern: 'ramp', arrivalOptions: opts } });
    const burst = run({ server: slow, workload: { arrivalPattern: 'burst', arrivalOptions: opts } });
    // Same load on average, so the same count; different spacing, so
    // different peaks in a server narrow enough to notice.
    for (const r of [constant, poisson, ramp, burst]) expect(r.offered).toBeGreaterThan(550);
    const peaks = [constant, poisson, ramp, burst].map((r) => r.servers[0]!.concurrencyPeak);
    expect(new Set(peaks).size).toBeGreaterThan(1);
    expect(ramp.arrivalPattern).toBe('ramp');
    expect(burst.servers[0]!.concurrencyPeak).toBeGreaterThan(constant.servers[0]!.concurrencyPeak);
  });
});

// =============================================================================
// The second five: serverless function, read replica, key-value store, object
// storage, pub/sub topic — and the database's read share that replicas need.
// Built with a small builder of their own, because their wiring differs.
// =============================================================================

function raw<K extends ArchNode['kind']>(id: string, kind: K, settings: unknown): ArchNode {
  return { id, name: id, kind, position: { x: 0, y: 0 }, cloud: { profileId: null }, settings } as ArchNode;
}
const wire = (nodes: ArchNode[], links: [string, string][], workload: Partial<Workload> = {}) =>
  doc(nodes, links.map(([a, b]) => edge(a, b, INSTANT)), { durationSeconds: 30, drainSeconds: 10, seed: 7, ...workload });
const go = (nodes: ArchNode[], links: [string, string][], workload: Partial<Workload> = {}) =>
  runSimulation(wire(nodes, links, workload));
const byId = (r: SimulationResult, id: string) => r.stations.find((s) => s.nodeId === id)!;
const openUsers = () => client('c1', { ...OPEN_CLIENT });
const openServer = (id = 's1') => server(id, OPEN_SERVER);
const bare = (o: Partial<DatabaseSettings> = {}) =>
  database('db', { queryServiceTimeMs: 10, maxConcurrentQueries: 100, queueLimit: 1000, queryRequestBytes: 0, queryResultBytes: 0, ...o });

describe('Database, read share', () => {
  it('readShare: with a replica connected, the share that reads leaves the primary', () => {
    const links: [string, string][] = [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']];
    const allWrite = go([openUsers(), openServer(), bare({ readShare: 0 }), raw('r1', 'readReplica', DEFAULT_READ_REPLICA_SETTINGS)], links);
    const allRead = go([openUsers(), openServer(), bare({ readShare: 1 }), raw('r1', 'readReplica', DEFAULT_READ_REPLICA_SETTINGS)], links);
    expect(byId(allWrite, 'db').writes).toBe(600);
    expect(byId(allWrite, 'r1').reads).toBe(0);
    expect(byId(allRead, 'db').operations).toBe(0);
    expect(byId(allRead, 'r1').reads).toBe(600);
  });
});

describe('Serverless Function', () => {
  const f = (o: Partial<ServerlessSettings> = {}) =>
    raw('f1', 'serverless', { ...DEFAULT_SERVERLESS_SETTINGS, cpuMsPerRequest: 5, coldStartShare: 0, ...o });
  const alone = (o: Partial<ServerlessSettings> = {}) => go([openUsers(), f(o)], [['c1', 'f1']]);

  it('cpuMsPerRequest: more work per invocation, slower responses', () => {
    expect(mean(alone({ cpuMsPerRequest: 25 }))).toBeCloseTo(mean(alone()) + 20, 3);
  });

  it('memoryMb: cost only, double the memory is double the gigabyte-seconds', () => {
    const cost = (memoryMb: number) => {
      const d = wire([openUsers(), f({ memoryMb })], [['c1', 'f1']]);
      d.nodes[1]!.cloud = { profileId: 'aws.lambda.us-east-1' };
      const r = runSimulation(d);
      return { r, line: estimateCost({ document: d, catalog, usage: r.usage }).lines.find((l) => l.chargeType === 'duration')! };
    };
    const small = cost(512);
    const big = cost(1024);
    expect(small.r.responseTime).toEqual(big.r.responseTime);
    expect(Number(big.line.quantity)).toBeCloseTo(2 * Number(small.line.quantity), 1);
  });

  it('maxConcurrentInvocations: over the limit is refused, never queued', () => {
    const r = alone({ cpuMsPerRequest: 200, maxConcurrentInvocations: 2 });
    expect(r.rejectionsByReason['function-throttled']).toBe(300);
    expect(r.servers[0]!.admissionQueuePeak).toBe(0);
  });

  it('coldStartShare and coldStartMs: the share that starts cold pays the cold start', () => {
    expect(alone({ coldStartShare: 0, coldStartMs: 300 }).servers[0]!.coldStarts).toBe(0);
    const all = alone({ coldStartShare: 1, coldStartMs: 300 });
    expect(all.servers[0]!.coldStarts).toBe(600);
    expect(mean(all)).toBeCloseTo(mean(alone()) + 300, 3);
    expect(mean(alone({ coldStartShare: 1, coldStartMs: 100 }))).toBeCloseTo(mean(alone()) + 100, 3);
  });
});

describe('Read Replica', () => {
  const links: [string, string][] = [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']];
  const rep = (o: Partial<ReadReplicaSettings> = {}) =>
    raw('r1', 'readReplica', { ...DEFAULT_READ_REPLICA_SETTINGS, queryServiceTimeMs: 10, maxConcurrentQueries: 100, queueLimit: 1000, applyServiceTimeMs: 0, ...o });
  const reads = (o: Partial<ReadReplicaSettings> = {}, readShare = 1) => go([openUsers(), openServer(), bare({ readShare }), rep(o)], links);

  it('queryServiceTimeMs: slower reads, slower responses', () => {
    expect(mean(reads({ queryServiceTimeMs: 30 }))).toBeCloseTo(mean(reads()) + 20, 3);
  });

  it('maxConcurrentQueries: one slot with 100 ms reads builds a line', () => {
    expect(reads({ queryServiceTimeMs: 100, maxConcurrentQueries: 1 }).waitByStageMs.replica).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejected reads', () => {
    expect(reads({ queryServiceTimeMs: 100, maxConcurrentQueries: 1, queueLimit: 0 }).rejectionsByReason['replica-queue-full']).toBeGreaterThan(0);
  });

  it('applyServiceTimeMs: applying writes takes slots away from reads', () => {
    const quick = reads({ maxConcurrentQueries: 1, applyServiceTimeMs: 0 }, 0.5);
    const slow = reads({ maxConcurrentQueries: 1, applyServiceTimeMs: 100 }, 0.5);
    expect(quick.waitByStageMs.replica).toBe(0);
    expect(slow.waitByStageMs.replica).toBeGreaterThan(0);
  });
});

describe('Key-Value Store', () => {
  const store = (o: Partial<KvStoreSettings> = {}) =>
    raw('kv', 'kvStore', { ...DEFAULT_KV_STORE_SETTINGS, readServiceTimeMs: 2, writeServiceTimeMs: 4, readShare: 1, itemBytes: 0, ...o });
  const via = (o: Partial<KvStoreSettings> = {}) => go([openUsers(), openServer(), store(o)], [['c1', 's1'], ['s1', 'kv']]);

  it('readShare: the split between reads and writes', () => {
    expect(byId(via({ readShare: 1 }), 'kv').reads).toBe(600);
    expect(byId(via({ readShare: 0 }), 'kv').writes).toBe(600);
  });

  it('readServiceTimeMs and writeServiceTimeMs: each kind at its own pace', () => {
    expect(mean(via({ readShare: 1, readServiceTimeMs: 12 }))).toBeCloseTo(mean(via({ readShare: 1 })) + 10, 3);
    expect(mean(via({ readShare: 0, writeServiceTimeMs: 14 }))).toBeCloseTo(mean(via({ readShare: 0 })) + 10, 3);
  });

  it('maxConcurrentRequests: one slot with 100 ms operations builds a line', () => {
    expect(via({ readServiceTimeMs: 100, maxConcurrentRequests: 1 }).waitByStageMs.kv).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the store', () => {
    expect(via({ readServiceTimeMs: 100, maxConcurrentRequests: 1, queueLimit: 0 }).rejectionsByReason['kv-queue-full']).toBeGreaterThan(0);
  });

  it('itemBytes: the record on the wire', () => {
    expect(linkBytes(via({ readShare: 1, itemBytes: 500 }), 'kv', 's1')).toBe(600 * 500);
  });

  it('storedGb: cost only, the storage line scales with it', () => {
    const cost = (storedGb: number) => {
      const d = wire([openUsers(), openServer(), store({ storedGb })], [['c1', 's1'], ['s1', 'kv']]);
      d.nodes[2]!.cloud = { profileId: 'aws.dynamodb.on-demand.us-east-1' };
      return Number(estimateCost({ document: d, catalog, usage: null }).lines.find((l) => l.chargeType === 'storage')!.monthly);
    };
    expect(cost(1000)).toBeCloseTo(10 * cost(100), 6);
  });
});

describe('Object Storage', () => {
  const bucket = (o: Partial<ObjectStorageSettings> = {}) =>
    raw('os', 'objectStorage', { ...DEFAULT_OBJECT_STORAGE_SETTINGS, getServiceTimeMs: 15, putServiceTimeMs: 30, writeShare: 0, objectBytes: 0, ...o });
  const via = (o: Partial<ObjectStorageSettings> = {}) => go([openUsers(), openServer(), bucket(o)], [['c1', 's1'], ['s1', 'os']]);

  it('writeShare: the split between reads and writes', () => {
    expect(byId(via({ writeShare: 0 }), 'os').reads).toBe(600);
    expect(byId(via({ writeShare: 1 }), 'os').writes).toBe(600);
  });

  it('getServiceTimeMs and putServiceTimeMs: each kind at its own pace', () => {
    expect(mean(via({ writeShare: 0, getServiceTimeMs: 25 }))).toBeCloseTo(mean(via({ writeShare: 0 })) + 10, 3);
    expect(mean(via({ writeShare: 1, putServiceTimeMs: 40 }))).toBeCloseTo(mean(via({ writeShare: 1 })) + 10, 3);
  });

  it('objectBytes: the object on the wire', () => {
    expect(linkBytes(via({ writeShare: 0, objectBytes: 20_000 }), 'os', 's1')).toBe(600 * 20_000);
    expect(linkBytes(via({ writeShare: 1, objectBytes: 20_000 }), 's1', 'os')).toBe(600 * 20_000);
  });

  it('maxConcurrentRequests: one slot with 100 ms reads builds a line', () => {
    expect(via({ getServiceTimeMs: 100, maxConcurrentRequests: 1 }).waitByStageMs.storage).toBeGreaterThan(0);
  });

  it('queueLimit: no room to wait means rejections at the bucket', () => {
    expect(via({ getServiceTimeMs: 100, maxConcurrentRequests: 1, queueLimit: 0 }).rejectionsByReason['storage-queue-full']).toBeGreaterThan(0);
  });

  it('storedGb: cost only, the storage line scales with it', () => {
    const cost = (storedGb: number) => {
      const d = wire([openUsers(), openServer(), bucket({ storedGb })], [['c1', 's1'], ['s1', 'os']]);
      d.nodes[2]!.cloud = { profileId: 'aws.s3.standard.us-east-1' };
      return Number(estimateCost({ document: d, catalog, usage: null }).lines.find((l) => l.chargeType === 'storage')!.monthly);
    };
    expect(cost(1000)).toBeCloseTo(10 * cost(100), 6);
  });
});

describe('Pub/Sub Topic', () => {
  const t = (o: Partial<PubSubSettings> = {}) =>
    raw('t', 'pubsub', { ...DEFAULT_PUBSUB_SETTINGS, publishServiceTimeMs: 1, maxConcurrentPublishes: 100, publishQueueLimit: 1000, messageBytes: 0, ...o });
  const slow: Partial<ServerSettings> = { ...OPEN_SERVER, cpuSlots: 1, concurrencyLimit: 1, cpuMsPerRequest: 500 };
  const via = (o: Partial<PubSubSettings> = {}, listener: Partial<ServerSettings> = OPEN_SERVER) =>
    go([openUsers(), openServer(), t(o), server('w1', listener)], [['c1', 's1'], ['s1', 't'], ['t', 'w1']]);

  it('publishServiceTimeMs: the publisher waits for the broker, and only that', () => {
    expect(mean(via({ publishServiceTimeMs: 11 }))).toBeCloseTo(mean(via()) + 10, 3);
  });

  it('maxConcurrentPublishes: one slot with 100 ms publishes builds a line', () => {
    expect(via({ publishServiceTimeMs: 100, maxConcurrentPublishes: 1 }).waitByStageMs.pubsub).toBeGreaterThan(0);
  });

  it('publishQueueLimit: no room to wait means the publish fails', () => {
    expect(via({ publishServiceTimeMs: 100, maxConcurrentPublishes: 1, publishQueueLimit: 0 }).rejectionsByReason['pubsub-publish-full']).toBeGreaterThan(0);
  });

  it('messageBytes: the event on the wire, to the topic and on to each listener', () => {
    const r = via({ messageBytes: 300 });
    expect(linkBytes(r, 's1', 't')).toBe(600 * 300);
    expect(linkBytes(r, 't', 'w1')).toBe(600 * 300);
  });

  it('maxDepth: a full listener drops its copies, and the publisher never knows', () => {
    const deep = via({ maxDepth: 100_000 }, slow);
    const shallow = via({ maxDepth: 5 }, slow);
    expect(byId(deep, 't').dropped).toBe(0);
    expect(byId(shallow, 't').dropped).toBeGreaterThan(0);
    expect(shallow.rejected).toBe(0);
  });
});
