import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import {
  DEFAULT_KV_STORE_SETTINGS,
  DEFAULT_OBJECT_STORAGE_SETTINGS,
  DEFAULT_PUBSUB_SETTINGS,
  DEFAULT_READ_REPLICA_SETTINGS,
  DEFAULT_SERVERLESS_SETTINGS,
} from '../src/domain/defaults';
import type {
  ArchNode,
  KvStoreSettings,
  ObjectStorageSettings,
  PubSubSettings,
  ReadReplicaSettings,
  ServerSettings,
  ServerlessSettings,
} from '../src/domain/types';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation } from '../src/simulation/engine';
import { validateAndResolve } from '../src/simulation/routing';
import type { SimulationResult } from '../src/simulation/types';
import { cache, client, database, doc, edge, loadBalancer, queue, server, INSTANT } from './helpers';

/**
 * Five more components, each held to the one thing it is for.
 *
 * A serverless function runs your code with nothing provisioned and is billed
 * by the millisecond alive. A read replica takes reads off the primary and
 * applies every write anyway. A key-value store and object storage bill reads
 * and writes apart. A topic hands every listener its own copy and never makes
 * the publisher wait for any of them.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);

function node<K extends ArchNode['kind']>(id: string, kind: K, settings: unknown): ArchNode {
  return { id, name: id, kind, position: { x: 0, y: 0 }, cloud: { profileId: null }, settings } as ArchNode;
}
const fn = (id: string, o: Partial<ServerlessSettings> = {}) =>
  node(id, 'serverless', { ...DEFAULT_SERVERLESS_SETTINGS, coldStartShare: 0, ...o });
const replica = (id: string, o: Partial<ReadReplicaSettings> = {}) =>
  node(id, 'readReplica', { ...DEFAULT_READ_REPLICA_SETTINGS, ...o });
const kv = (id: string, o: Partial<KvStoreSettings> = {}) =>
  node(id, 'kvStore', { ...DEFAULT_KV_STORE_SETTINGS, itemBytes: 0, ...o });
const storage = (id: string, o: Partial<ObjectStorageSettings> = {}) =>
  node(id, 'objectStorage', { ...DEFAULT_OBJECT_STORAGE_SETTINGS, objectBytes: 0, ...o });
const topic = (id: string, o: Partial<PubSubSettings> = {}) =>
  node(id, 'pubsub', { ...DEFAULT_PUBSUB_SETTINGS, messageBytes: 0, ...o });

const OPEN: Partial<ServerSettings> = {
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
const users = () => client('c1', { requestRateOverridePerSecond: 20, requestBytes: 0, responseBytes: 0 });
const db = (o = {}) =>
  database('db', { queryServiceTimeMs: 10, queryRequestBytes: 0, queryResultBytes: 0, maxConcurrentQueries: 100, ...o });
const WORKLOAD = { durationSeconds: 30, drainSeconds: 10, seed: 7 };
const build = (nodes: ArchNode[], links: [string, string][]) =>
  doc(nodes, links.map(([a, b]) => edge(a, b, INSTANT)), WORKLOAD);
const run = (nodes: ArchNode[], links: [string, string][]) => runSimulation(build(nodes, links));
const errors = (nodes: ArchNode[], links: [string, string][]) =>
  validateAndResolve(build(nodes, links)).issues.filter((i) => i.severity === 'error').map((i) => i.code);
const station = (r: SimulationResult, id: string) => r.stations.find((s) => s.nodeId === id)!;
const mean = (r: SimulationResult) => r.responseTime.meanMs;
const priced = (nodes: ArchNode[], links: [string, string][], profiles: Record<string, string>) => {
  const d = build(nodes, links);
  for (const n of d.nodes) if (profiles[n.id]) n.cloud = { profileId: profiles[n.id]! };
  const r = runSimulation(d);
  return { r, estimate: estimateCost({ document: d, catalog, usage: r.usage }) };
};

// --------------------------------------------------------- Serverless Function

describe('Serverless Function', () => {
  it('runs code like a server, with a CPU slot for every invocation', () => {
    // 200 ms of work at 20 a second: a one-slot server queues, a function does not.
    const one = run([users(), server('s1', { ...OPEN, cpuSlots: 1, cpuMsPerRequest: 200 })], [['c1', 's1']]);
    const f = run([users(), fn('f1', { cpuMsPerRequest: 200 })], [['c1', 'f1']]);
    expect(one.waitByStageMs.serverCpu).toBeGreaterThan(0);
    expect(f.waitByStageMs.serverCpu).toBe(0);
    expect(mean(f)).toBe(200);
    expect(f.servers[0]!.kind).toBe('serverless');
    expect(f.servers[0]!.completed).toBe(600);
  });

  it('pays a cold start on the share of invocations that find no warm instance', () => {
    const warm = run([users(), fn('f1', { cpuMsPerRequest: 5, coldStartShare: 0, coldStartMs: 300 })], [['c1', 'f1']]);
    const cold = run([users(), fn('f1', { cpuMsPerRequest: 5, coldStartShare: 1, coldStartMs: 300 })], [['c1', 'f1']]);
    expect(warm.servers[0]!.coldStarts).toBe(0);
    expect(mean(warm)).toBe(5);
    expect(cold.servers[0]!.coldStarts).toBe(600);
    expect(mean(cold)).toBe(305);
  });

  it('refuses over its concurrency limit instead of queueing', () => {
    // Two at a time, 200 ms each: 10 a second served, the other 10 refused.
    const r = run([users(), fn('f1', { cpuMsPerRequest: 200, maxConcurrentInvocations: 2 })], [['c1', 'f1']]);
    expect(r.servers[0]!.throttled).toBe(300);
    expect(r.rejectionsByReason['function-throttled']).toBe(300);
    expect(r.servers[0]!.admissionQueuePeak).toBe(0);
    expect(r.servers[0]!.concurrencyPeak).toBe(2);
    expect(r.completed).toBe(300);
  });

  it('is billed for the time alive, waiting on the database included', () => {
    // 5 ms of CPU plus 10 ms waiting for the database: 15 ms alive each.
    const { r, estimate } = priced([users(), fn('f1', { cpuMsPerRequest: 5, memoryMb: 1024 }), db()], [['c1', 'f1'], ['f1', 'db']], { f1: 'aws.lambda.us-east-1' });
    expect(r.servers[0]!.busyMsTotal).toBe(600 * 15);
    expect(r.usage.busyMsByNodeId['f1']).toBe(9000);
    expect(r.usage.requestsByNodeId['f1']).toBe(600);
    const duration = estimate.lines.find((l) => l.nodeId === 'f1' && l.chargeType === 'duration')!;
    const requests = estimate.lines.find((l) => l.nodeId === 'f1' && l.chargeType === 'requests')!;
    // 9 GB-seconds over the measured window, scaled to a 730-hour month.
    const gbSeconds = (9 / r.usage.measuredSeconds) * 730 * 3600;
    expect(Number(duration.quantity)).toBeCloseTo(gbSeconds, 1);
    expect(Number(duration.monthly)).toBeCloseTo(gbSeconds * 0.0000166667, 2);
    expect(Number(requests.quantity)).toBeCloseTo((600 / r.usage.measuredSeconds) * 730 * 3600 / 1e6, 6);
    expect(estimate.lines.filter((l) => l.nodeId === 'f1').every((l) => l.verified)).toBe(true);
    expect(estimate.lines.some((l) => l.nodeId === 'f1' && l.chargeType === 'compute')).toBe(false);
  });

  it('can sit behind a load balancer and drain a queue', () => {
    const r = run(
      [users(), loadBalancer('lb'), fn('f1'), server('s2', OPEN), queue('q', { messageBytes: 0 }), fn('w1')],
      [['c1', 'lb'], ['lb', 'f1'], ['lb', 's2'], ['f1', 'q'], ['s2', 'q'], ['q', 'w1']],
    );
    expect(r.status).toBe('completed');
    expect(r.servers.find((s) => s.nodeId === 'f1')!.completed).toBe(300);
    expect(r.servers.find((s) => s.nodeId === 's2')!.completed).toBe(300);
    expect(r.messagesProcessed).toBe(600);
    expect(r.servers.find((s) => s.nodeId === 'w1')!.completed).toBe(600);
  });
});

// --------------------------------------------------------------- Read Replica

describe('Read Replica', () => {
  const wired: [string, string][] = [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['db', 'r2'], ['s1', 'r1'], ['s1', 'r2']];

  it('takes the reads, round-robin, and leaves every write on the primary', () => {
    const r = run([users(), server('s1', OPEN), db({ readShare: 0.8 }), replica('r1'), replica('r2')], wired);
    const primary = station(r, 'db');
    const r1 = station(r, 'r1');
    const r2 = station(r, 'r2');
    expect(primary.reads).toBe(0);
    expect(primary.writes).toBeGreaterThan(90);
    expect(primary.writes).toBeLessThan(150);
    expect(r1.reads! + r2.reads!).toBe(600 - primary.writes!);
    expect(Math.abs(r1.reads! - r2.reads!)).toBeLessThanOrEqual(1);
    expect(r.databaseQueries).toBe(600);
  });

  it('applies every write, on every replica, and nobody waits for it', () => {
    const r = run([users(), server('s1', OPEN), db({ readShare: 0.5 }), replica('r1', { queryServiceTimeMs: 10 }), replica('r2', { queryServiceTimeMs: 10 })], wired);
    const writes = station(r, 'db').writes!;
    expect(station(r, 'r1').applied).toBe(writes);
    expect(station(r, 'r2').applied).toBe(writes);
    // The writer's own response never included the copy: 5 ms CPU + 10 ms query.
    expect(mean(r)).toBeCloseTo(5 + 10, 1);
  });

  it('spends its slots on writes too, so replicas scale reads and not writes', () => {
    // One slot, 10 ms reads, and 100 ms to apply each of ~50% writes: reads wait.
    const light = run([users(), server('s1', OPEN), db({ readShare: 0.5 }), replica('r1', { maxConcurrentQueries: 1, applyServiceTimeMs: 0 })], [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']]);
    const heavy = run([users(), server('s1', OPEN), db({ readShare: 0.5 }), replica('r1', { maxConcurrentQueries: 1, applyServiceTimeMs: 100 })], [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']]);
    expect(light.waitByStageMs.replica).toBe(0);
    expect(heavy.waitByStageMs.replica).toBeGreaterThan(0);
    expect(mean(heavy)).toBeGreaterThan(mean(light));
  });

  it('turns reads away when its line is full, but never a write being applied', () => {
    const r = run([users(), server('s1', OPEN), db({ readShare: 0.5 }), replica('r1', { maxConcurrentQueries: 1, applyServiceTimeMs: 100, queueLimit: 0 })], [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']]);
    expect(r.rejectionsByReason['replica-queue-full']).toBeGreaterThan(0);
    expect(station(r, 'r1').applied).toBe(station(r, 'db').writes);
  });

  it('receives every write to the primary, even from a server that never reads from it', () => {
    // A worker behind a queue writes to the database and reads from no
    // replica. Replication is the database's business, not the caller's, so
    // the replica still applies those writes. Caught by the fifteen-component
    // reconciliation before it was a rule.
    const r = run(
      [users(), server('s1', OPEN), db({ readShare: 0.5 }), replica('r1'), queue('q', { messageBytes: 0 }), server('w1', OPEN)],
      [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1'], ['s1', 'q'], ['q', 'w1'], ['w1', 'db']],
    );
    // The users' writes are 600 minus the reads the replica answered; the
    // worker's writes come on top, and all of them reach the replica.
    const usersWrites = 600 - station(r, 'r1').reads!;
    const primaryWrites = station(r, 'db').writes!;
    expect(primaryWrites).toBeGreaterThan(usersWrites);
    expect(station(r, 'r1').applied).toBe(primaryWrites);
  });

  it('is skipped by a cache hit, like the primary', () => {
    const r = run([users(), server('s1', OPEN), cache('cache', { hitRate: 1, lookupRequestBytes: 0, lookupResultBytes: 0, populateOnMiss: false }), db(), replica('r1')], [['c1', 's1'], ['s1', 'cache'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']]);
    expect(r.databaseQueries).toBe(0);
    expect(station(r, 'r1').reads).toBe(0);
  });

  it('refuses a replica that copies nothing, the wrong database, or a server without one', () => {
    expect(errors([users(), server('s1', OPEN), db(), replica('r1')], [['c1', 's1'], ['s1', 'db'], ['s1', 'r1']])).toContain('route/replica-source');
    expect(errors([users(), server('s1', OPEN), db(), database('other'), replica('r1')], [['c1', 's1'], ['s1', 'db'], ['other', 'r1'], ['s1', 'r1']])).toContain('route/replica-mismatch');
    expect(errors([users(), server('s1', OPEN), db(), replica('r1')], [['c1', 's1'], ['db', 'r1'], ['s1', 'r1']])).toContain('route/replica-without-database');
    // A database may replicate; it may not call anything else.
    expect(errors([users(), server('s1', OPEN), db(), cache('cache')], [['c1', 's1'], ['s1', 'db'], ['db', 'cache']])).toContain('topology/leaf-outgoing');
    expect(errors([users(), server('s1', OPEN), db(), replica('r1')], wired.slice(0, 3).concat([['s1', 'r1']]))).toEqual([]);
  });

  it('is priced as a database instance holding a copy of the primary', () => {
    const { estimate } = priced([users(), server('s1', OPEN), db({ dataSizeGb: 200 }), replica('r1')], [['c1', 's1'], ['s1', 'db'], ['db', 'r1'], ['s1', 'r1']], { db: 'aws.rds.m7g-large-postgres.us-east-1', r1: 'aws.rds.m7g-large-postgres.us-east-1' });
    const lines = (id: string) => estimate.lines.filter((l) => l.nodeId === id);
    expect(lines('r1').map((l) => l.chargeType).sort()).toEqual(['compute', 'storage']);
    expect(lines('r1').find((l) => l.chargeType === 'storage')!.quantity).toBe(lines('db').find((l) => l.chargeType === 'storage')!.quantity);
    expect(lines('r1').find((l) => l.chargeType === 'compute')!.monthly).toBe(lines('db').find((l) => l.chargeType === 'compute')!.monthly);
  });
});

// ------------------------------------------------------------ Key-Value Store

describe('Key-Value Store', () => {
  it('reads and writes by the configured share, each at its own service time', () => {
    const reads = run([users(), server('s1', OPEN), kv('kv', { readShare: 1, readServiceTimeMs: 2, writeServiceTimeMs: 40 })], [['c1', 's1'], ['s1', 'kv']]);
    const writes = run([users(), server('s1', OPEN), kv('kv', { readShare: 0, readServiceTimeMs: 2, writeServiceTimeMs: 40 })], [['c1', 's1'], ['s1', 'kv']]);
    expect(station(reads, 'kv').reads).toBe(600);
    expect(station(reads, 'kv').writes).toBe(0);
    // A key and an acknowledgement are a few hundred bytes, worth microseconds.
    expect(mean(reads)).toBeCloseTo(7, 3);
    expect(station(writes, 'kv').writes).toBe(600);
    expect(mean(writes)).toBeCloseTo(45, 3);
  });

  it('carries the record on the wire in the direction it moves', () => {
    const reads = run([users(), server('s1', OPEN), kv('kv', { readShare: 1, itemBytes: 1000 })], [['c1', 's1'], ['s1', 'kv']]);
    const writes = run([users(), server('s1', OPEN), kv('kv', { readShare: 0, itemBytes: 1000 })], [['c1', 's1'], ['s1', 'kv']]);
    const bytes = (r: SimulationResult, from: string, to: string) => r.links.find((l) => l.fromId === from && l.toId === to)!.bytes;
    expect(bytes(reads, 'kv', 's1')).toBe(600 * 1000);
    expect(bytes(writes, 's1', 'kv')).toBe(600 * 1000);
  });

  it('never queues by default, because a managed store scales itself', () => {
    const r = run([users(), server('s1', OPEN), kv('kv', { readServiceTimeMs: 500, writeServiceTimeMs: 500 })], [['c1', 's1'], ['s1', 'kv']]);
    expect(r.waitByStageMs.kv).toBe(0);
    expect(station(r, 'kv').queuePeak).toBe(0);
    const narrow = run([users(), server('s1', OPEN), kv('kv', { readServiceTimeMs: 500, writeServiceTimeMs: 500, maxConcurrentRequests: 1 })], [['c1', 's1'], ['s1', 'kv']]);
    expect(narrow.waitByStageMs.kv).toBeGreaterThan(0);
  });

  it('is skipped by a cache hit for reads, and never for writes', () => {
    const hits = (share: number) =>
      run([users(), server('s1', OPEN), cache('cache', { hitRate: 1, lookupRequestBytes: 0, lookupResultBytes: 0, populateOnMiss: false }), kv('kv', { readShare: share })], [['c1', 's1'], ['s1', 'cache'], ['s1', 'kv']]);
    expect(station(hits(1), 'kv').operations).toBe(0);
    expect(station(hits(0), 'kv').writes).toBe(600);
  });

  it('is priced per read, per write and per gigabyte kept', () => {
    const { r, estimate } = priced([users(), server('s1', OPEN), kv('kv', { readShare: 0.75, storedGb: 100 })], [['c1', 's1'], ['s1', 'kv']], { kv: 'aws.dynamodb.on-demand.us-east-1' });
    const line = (type: string) => estimate.lines.find((l) => l.nodeId === 'kv' && l.chargeType === type)!;
    const perMonth = (n: number) => (n / r.usage.measuredSeconds) * 730 * 3600 / 1e6;
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(station(r, 'kv').reads!), 4);
    expect(Number(line('writes').quantity)).toBeCloseTo(perMonth(station(r, 'kv').writes!), 4);
    expect(line('requests').rate).toBe('0.125');
    expect(line('writes').rate).toBe('0.625');
    expect(Number(line('storage').monthly)).toBeCloseTo(100 * 0.25, 6);
    expect(estimate.lines.filter((l) => l.nodeId === 'kv').every((l) => l.verified)).toBe(true);
  });
});

// -------------------------------------------------------------- Object Storage

describe('Object Storage', () => {
  it('reads or writes one object per request, each kind at its own time', () => {
    const gets = run([users(), server('s1', OPEN), storage('os', { writeShare: 0, getServiceTimeMs: 15, putServiceTimeMs: 60 })], [['c1', 's1'], ['s1', 'os']]);
    const puts = run([users(), server('s1', OPEN), storage('os', { writeShare: 1, getServiceTimeMs: 15, putServiceTimeMs: 60 })], [['c1', 's1'], ['s1', 'os']]);
    expect(station(gets, 'os').reads).toBe(600);
    expect(mean(gets)).toBeCloseTo(20, 3);
    expect(station(puts, 'os').writes).toBe(600);
    expect(mean(puts)).toBeCloseTo(65, 3);
  });

  it('moves the object across the link in the direction it goes', () => {
    const gets = run([users(), server('s1', OPEN), storage('os', { writeShare: 0, objectBytes: 50_000 })], [['c1', 's1'], ['s1', 'os']]);
    const puts = run([users(), server('s1', OPEN), storage('os', { writeShare: 1, objectBytes: 50_000 })], [['c1', 's1'], ['s1', 'os']]);
    const bytes = (r: SimulationResult, from: string, to: string) => r.links.find((l) => l.fromId === from && l.toId === to)!.bytes;
    expect(bytes(gets, 'os', 's1')).toBe(600 * 50_000);
    expect(bytes(puts, 's1', 'os')).toBe(600 * 50_000);
  });

  it('is priced per gigabyte kept, per read and per write', () => {
    const { r, estimate } = priced([users(), server('s1', OPEN), storage('os', { writeShare: 0.2, storedGb: 1000 })], [['c1', 's1'], ['s1', 'os']], { os: 'aws.s3.standard.us-east-1' });
    const line = (type: string) => estimate.lines.find((l) => l.nodeId === 'os' && l.chargeType === type)!;
    const perMonth = (n: number) => (n / r.usage.measuredSeconds) * 730 * 3600 / 1e6;
    expect(Number(line('storage').monthly)).toBeCloseTo(1000 * 0.023, 6);
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(station(r, 'os').reads!), 4);
    expect(Number(line('writes').quantity)).toBeCloseTo(perMonth(station(r, 'os').writes!), 4);
    expect(line('writes').rate).toBe('5.00');
    expect(line('requests').rate).toBe('0.40');
  });
});

// ---------------------------------------------------------------- Pub/Sub Topic

describe('Pub/Sub Topic', () => {
  const two: [string, string][] = [['c1', 's1'], ['s1', 't'], ['t', 'w1'], ['t', 'w2']];

  it('hands every listener its own copy of every event', () => {
    const r = run([users(), server('s1', OPEN), topic('t'), server('w1', OPEN), server('w2', OPEN)], two);
    expect(r.messagesPublished).toBe(600);
    expect(station(r, 't').operations).toBe(600);
    expect(r.queues).toHaveLength(2);
    for (const sub of r.queues) {
      expect(sub.nodeId).toBe('t');
      expect(sub.enqueued).toBe(600);
      expect(sub.processed).toBe(600);
    }
    expect(r.queues.map((q) => q.consumerName).sort()).toEqual(['w1', 'w2']);
    expect(r.servers.find((s) => s.nodeId === 'w1')!.completed).toBe(600);
    expect(r.servers.find((s) => s.nodeId === 'w2')!.completed).toBe(600);
    // Billed once per publish, not once per copy.
    expect(r.usage.requestsByNodeId['t']).toBe(600);
  });

  it('never makes the publisher wait for a slow listener', () => {
    const slow: Partial<ServerSettings> = { ...OPEN, cpuSlots: 1, concurrencyLimit: 1, cpuMsPerRequest: 500 };
    const r = run([users(), server('s1', OPEN), topic('t', { publishServiceTimeMs: 1 }), server('w1', OPEN), server('w2', slow)], two);
    expect(mean(r)).toBe(6); // 5 ms of CPU and 1 ms for the broker to take it
    expect(r.rejected).toBe(0);
    expect(r.queues.find((q) => q.consumerName === 'w1')!.processed).toBe(600);
    expect(r.queues.find((q) => q.consumerName === 'w2')!.outstanding).toBeGreaterThan(0);
  });

  it('drops copies for a full listener and tells the publisher nothing', () => {
    const slow: Partial<ServerSettings> = { ...OPEN, cpuSlots: 1, concurrencyLimit: 1, cpuMsPerRequest: 500 };
    const r = run([users(), server('s1', OPEN), topic('t', { maxDepth: 5 }), server('w1', OPEN), server('w2', slow)], two);
    const dropped = station(r, 't').dropped!;
    expect(dropped).toBeGreaterThan(400);
    expect(r.queues.find((q) => q.consumerName === 'w2')!.refused).toBe(dropped);
    expect(r.queues.find((q) => q.consumerName === 'w1')!.refused).toBe(0);
    expect(r.rejected).toBe(0);
    expect(r.completed).toBe(600);
  });

  it('accepts a function as a listener and refuses a topic with none', () => {
    const r = run([users(), server('s1', OPEN), topic('t'), fn('w1')], [['c1', 's1'], ['s1', 't'], ['t', 'w1']]);
    expect(r.servers.find((s) => s.nodeId === 'w1')!.completed).toBe(600);
    expect(errors([users(), server('s1', OPEN), topic('t')], [['c1', 's1'], ['s1', 't']])).toContain('route/queue-no-consumer');
    // A queue still has exactly one consumer; a topic is how you fan out.
    expect(errors([users(), server('s1', OPEN), queue('q'), server('w1', OPEN), server('w2', OPEN)], [['c1', 's1'], ['s1', 'q'], ['q', 'w1'], ['q', 'w2']])).toContain('route/queue-multiple-consumers');
    // A listener publishing back to its own topic is a loop.
    expect(errors([users(), server('s1', OPEN), topic('t'), server('w1', OPEN)], [['c1', 's1'], ['s1', 't'], ['t', 'w1'], ['w1', 't']])).toContain('route/queue-cycle');
  });

  it('is priced per publish with the SNS rate', () => {
    const { r, estimate } = priced([users(), server('s1', OPEN), topic('t'), server('w1', OPEN), server('w2', OPEN)], two, { t: 'aws.sns.us-east-1' });
    const line = estimate.lines.find((l) => l.nodeId === 't' && l.chargeType === 'requests')!;
    expect(Number(line.quantity)).toBeCloseTo((600 / r.usage.measuredSeconds) * 730 * 3600 / 1e6, 4);
    expect(line.rate).toBe('0.50');
    expect(line.verified).toBe(true);
  });
});
