import { describe, expect, it } from 'vitest';
import { DATA_KINDS, DATA_SERVICES, dataDefaults } from '../src/domain/data-services';
import type { DataKind, DataServiceNode } from '../src/domain/data-services';
import { makeNode } from '../src/domain/defaults';
import { architectureDocumentSchema } from '../src/domain/schema';
import { DEFAULT_LIMITS } from '../src/domain/types';
import { SimulationEngine, runSimulation } from '../src/simulation/engine';
import { validateAndResolve } from '../src/simulation/routing';
import { DataServiceModel } from '../src/simulation/models/data-service';
import { RandomStreams } from '../src/simulation/rng';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { estimateCost } from '../src/pricing/pricing';
import { createRunRecord } from '../src/storage/runs';
import { runRecordSchema } from '../src/storage/run-schema';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { client, server, queue, doc, edge, INSTANT } from './helpers';

function store(kind: DataKind, overrides: Record<string, number> = {}, id = 'data'): DataServiceNode {
  const node = makeNode(kind, id, DATA_SERVICES[kind].label, { x: 700, y: 100 }) as DataServiceNode;
  Object.assign(node.settings, overrides);
  return node;
}
function design(kind: DataKind, overrides: Record<string, number> = {}, rate = 10) {
  return doc([client('users', { requestRateOverridePerSecond: rate, requestBytes: 0, responseBytes: 0 }),
    server('server', { cpuMsPerRequest: 6, cpuSlots: 16, concurrencyLimit: 10000, ramMb: 1000000 }), store(kind, overrides)],
  [edge('users', 'server', INSTANT), edge('server', 'data', INSTANT)], { durationSeconds: 2, drainSeconds: 20 });
}
const catalog = cloudCatalogSchema.parse(rawCatalog);

describe('Additional data services', () => {
  for (const kind of DATA_KINDS) {
    it(`${kind}: settings validate and survive JSON without inventing defaults`, () => {
      const d = design(kind);
      expect(architectureDocumentSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
      expect(dataDefaults(kind)).toEqual(d.nodes[2]!.settings);
      for (const key of Object.keys(DATA_SERVICES[kind].fields)) {
        const bad = structuredClone(d);
        Object.assign(bad.nodes[2]!.settings, { [key]: -1 });
        expect(architectureDocumentSchema.safeParse(bad).success, key).toBe(false);
      }
    });
    it(`${kind}: compute and network calls reconcile`, () => {
      const d = design(kind, { readShare: 1 });
      const r = runSimulation(d);
      expect(r.status).toBe('completed');
      expect(r.completed).toBe(20);
      expect(r.rejected).toBe(0);
      expect(r.dataServices![0]!.reads).toBe(20);
      expect(r.servers[0]!.cpuServiceMsTotal).toBeCloseTo(120);
      expect(r.links.find((l) => l.fromId === 'data')!.messages).toBe(20);
      expect(r.usage.requestsByNodeId.data).toBe(20);
    });
    it(`${kind}: shared queue worker uses exactly the same operation path`, () => {
      const d = design(kind, { readShare: 0 });
      d.nodes.push(queue('queue'), server('worker', { cpuMsPerRequest: 1 }));
      d.edges.push(edge('server', 'queue', INSTANT), edge('queue', 'worker', INSTANT), edge('worker', 'data', INSTANT));
      const r = runSimulation(d);
      expect(r.completed).toBe(20);
      expect(r.messagesProcessed).toBe(20);
      expect(r.dataServices![0]!.writes).toBe(40);
      expect(r.clients).toHaveLength(1);
      expect(r.usage.writesByNodeId.data).toBe(40);
    });
    it(`${kind}: the rate-less shape stays unpriced, and immutable runs reopen`, () => {
      const d = design(kind);
      // The default profile now carries a verified rate; this holds the
      // self-managed shape, which has none, to reporting that honestly.
      d.nodes[2]!.cloud = { profileId: `generic.${kind}` };
      const result = runSimulation(d);
      const cost = estimateCost({ document: d, catalog, usage: result.usage });
      const lines = cost.lines.filter((l) => l.nodeId === 'data');
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.unpriced && l.monthly === null)).toBe(true);
      const record = createRunRecord({ projectId: 'p', label: 'Data test', document: d, catalog, result, cost });
      const reopened = runRecordSchema.parse(JSON.parse(JSON.stringify(record)));
      expect(reopened).not.toBeNull();
      expect(reopened!.result.dataServices).toEqual(result.dataServices);
      Object.assign(d.nodes[2]!.settings, { readShare: 0.123 });
      expect(record.inputDocument.nodes[2]!.settings).not.toEqual(d.nodes[2]!.settings);
    });
    it(`${kind}: unsupported wiring gives a validation error`, () => {
      const d = design(kind);
      d.edges.push(edge('data', 'server', INSTANT));
      expect(validateAndResolve(d).hasErrors).toBe(true);
      d.edges = [edge('users', 'data', INSTANT)];
      expect(validateAndResolve(d).hasErrors).toBe(true);
    });
  }

  it('indexed reads inspect fewer documents and use their configured cost', () => {
    const indexed = runSimulation(design('documentDb', { readShare: 1, indexHitShare: 1, indexedReadMs: 2 }));
    const scanned = runSimulation(design('documentDb', { readShare: 1, indexHitShare: 0, documentsPerScan: 100, scanMsPerDocument: 0.1 }));
    expect(scanned.responseTime.meanMs - indexed.responseTime.meanMs).toBeCloseTo(8, 5);
    expect(indexed.dataServices![0]!.details).toMatchObject({ indexedReads: 20, scans: 0, documentsExamined: 20 });
    expect(scanned.dataServices![0]!.details.documentsExamined).toBe(2000);
  });
  it('a hot partition refuses work while a distributed workload uses the other partitions', () => {
    const settings = { readShare: 1, partitions: 16, slotsPerPartition: 1, readMs: 50, queueLimit: 0 };
    const hot = runSimulation(design('wideColumn', { ...settings, hotPartitionShare: 1 }, 100));
    const spread = runSimulation(design('wideColumn', { ...settings, hotPartitionShare: 0 }, 100));
    expect(hot.rejected).toBeGreaterThan(spread.rejected * 3);
    expect(hot.rejectionsByReason['data-service-full']).toBe(hot.rejected);
    expect(hot.dataServices![0]!.utilisation).toBeLessThan(0.1);
    expect(hot.completed + hot.rejected).toBe(hot.offered);
  });
  it('data-service waiting is included in the user waiting total', () => {
    const r = runSimulation(design('documentDb', { readShare: 1, indexHitShare: 1, indexedReadMs: 100, maxConcurrentRequests: 1 }, 20));
    expect(r.dataServices![0]!.waitMsTotal).toBeGreaterThan(0);
    expect(r.waitByStageMs.database).toBe(r.dataServices![0]!.waitMsTotal);
    expect(r.meanWaitMs).toBeCloseTo(r.dataServices![0]!.waitMsTotal / r.completed, 3);
  });
  it('search writes become visible at a refresh, even with no later query', () => {
    const model = new DataServiceModel(store('searchIndex', { readShare: 0, refreshMs: 1000, indexMs: 5 }), new RandomStreams(1));
    const op = model.prepare(0);
    model.admit(1, op, 0, () => {});
    model.finish(1, 5, () => {});
    const first = model.snapshot(5);
    expect(first.details).toEqual({ searchableWrites: 0, pendingRefresh: 1 });
    expect(model.snapshot(1000).details).toEqual({ searchableWrites: 1, pendingRefresh: 0 });
    expect(first.details.pendingRefresh).toBe(1);
  });
  it('searching twice as many shards doubles query work', () => {
    const one = runSimulation(design('searchIndex', { readShare: 1, shardsPerQuery: 1, queryMs: 3 }));
    const two = runSimulation(design('searchIndex', { readShare: 1, shardsPerQuery: 2, queryMs: 3 }));
    expect(two.dataServices![0]!.serviceMsTotal).toBe(one.dataServices![0]!.serviceMsTotal * 2);
    expect(two.responseTime.meanMs - one.responseTime.meanMs).toBeCloseTo(3, 5);
  });
  it('warehouse scan volume drives both query duration and its explicit GB charge', () => {
    const d = design('warehouse', { readShare: 1, scanGbPerQuery: 2, scanGbPerSecond: 4, maxConcurrentRequests: 100 });
    d.nodes[2]!.cloud = { profileId: 'generic.warehouse' };
    const result = runSimulation(d);
    expect(result.dataServices![0]!.details.scannedGb).toBe(40);
    expect(result.dataServices![0]!.serviceMsTotal).toBe(20 * 520);
    d.pricingOverrides['generic.warehouse'] = { scan: '0.01' };
    const scan = estimateCost({ document: d, catalog, usage: result.usage }).lines.find((l) => l.chargeType === 'scan')!;
    expect(Number(scan.monthly)).toBeCloseTo(40 / result.usage.measuredSeconds * 730 * 3600 * 0.01, 2);
    expect(scan.verified).toBe(false);
    expect(scan.edited).toBe(true);
  });
  it('time-series writes add points, queries scan their time window, and retention expires them', () => {
    const n = store('timeSeries', { readShare: 0, pointsPerWrite: 100, retentionSeconds: 1, queryWindowSeconds: 0.5 });
    const model = new DataServiceModel(n, new RandomStreams(1));
    const op = model.prepare(0);
    expect(op.requestBytes).toBe(100 * n.settings.itemBytes);
    model.admit(1, op, 0, () => {});
    model.finish(1, 1, () => {});
    Object.assign(n.settings, { readShare: 1 });
    expect(model.prepare(200).examined).toBe(100);
    expect(model.prepare(700).examined).toBe(0);
    expect(model.snapshot(700).details.retainedPoints).toBe(100);
    expect(model.snapshot(1100).details.retainedPoints).toBe(0);
    expect(model.snapshot(1100).details.ingestedPoints).toBe(100);
  });
  it('all five can share an application pipeline without duplicating CPU work', () => {
    const d = design('documentDb', { readShare: 1 });
    for (const kind of DATA_KINDS.slice(1)) { d.nodes.push(store(kind, { readShare: 1 }, kind)); d.edges.push(edge('server', kind, INSTANT)); }
    const r = runSimulation(d);
    expect(r.completed).toBe(r.offered);
    expect(r.dataServices).toHaveLength(5);
    expect(r.dataServices!.every((s) => s.completed === r.offered)).toBe(true);
    expect(r.servers[0]!.cpuServiceMsTotal).toBeCloseTo(120);
  });
  it('worker failures free the queue and do not become rejected user requests', () => {
    const d = design('documentDb', { readShare: 1, indexHitShare: 1, indexedReadMs: 100, maxConcurrentRequests: 1, queueLimit: 0 }, 50);
    d.nodes.push(queue('q'), server('w', { cpuMsPerRequest: 1, concurrencyLimit: 4 }));
    d.edges = [edge('users', 'server', INSTANT), edge('server', 'q', INSTANT), edge('q', 'w', INSTANT), edge('w', 'data', INSTANT)];
    const r = runSimulation(d);
    expect(r.completed).toBe(100);
    expect(r.rejected).toBe(0);
    expect(r.queues[0]!.failed).toBeGreaterThan(0);
    expect(r.queues[0]!.processed + r.queues[0]!.failed!).toBe(r.queues[0]!.enqueued);
    expect(r.queues[0]!.outstanding).toBe(0);
  });
  it('live snapshots do not change running data-service state', () => {
    const d = design('warehouse', { readShare: 1 });
    const engine = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
    engine.step(100000, 1000);
    const first = engine.result();
    const copy = structuredClone(first);
    expect(engine.result()).toEqual(first);
    engine.step(100000, 2000);
    expect(engine.result().dataServices![0]!.completed).toBeGreaterThan(first.dataServices![0]!.completed);
    expect(first).toEqual(copy);
  });
});
