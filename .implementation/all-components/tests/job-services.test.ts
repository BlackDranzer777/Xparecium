import { describe, expect, it } from 'vitest';
import { makeNode } from '../src/domain/defaults';
import type { JobKind, JobServiceNode } from '../src/domain/job-services';
import { JOB_KINDS, JOB_SERVICES } from '../src/domain/job-services';
import { architectureDocumentSchema } from '../src/domain/schema';
import { runSimulation, SimulationEngine } from '../src/simulation/engine';
import { DEFAULT_LIMITS } from '../src/domain/types';
import { validateAndResolve } from '../src/simulation/routing';
import { client, server, queue, doc, edge, INSTANT } from './helpers';
import { estimateCost } from '../src/pricing/pricing';
import { cloudCatalogSchema } from '../src/catalogs/types';
import raw from '../public/catalogs/cloud-profiles.v1.json';
import { createRunRecord } from '../src/storage/runs';
import { runRecordSchema } from '../src/storage/run-schema';
function job(kind: JobKind, id: string, settings = {}): JobServiceNode {
  const n = makeNode(kind, id, kind, { x: 0, y: 0 }) as JobServiceNode; Object.assign(n.settings, settings); return n;
}
const catalog = cloudCatalogSchema.parse(raw);
function stream(settings = {}) {
  return doc([client('u', { requestRateOverridePerSecond: 10 }), server('s'), job('eventStream', 'log', settings), server('w1'), server('w2')],
    [edge('u', 's', INSTANT), edge('s', 'log', INSTANT), edge('log', 'w1', INSTANT), edge('log', 'w2', INSTANT)], { durationSeconds: 1, drainSeconds: 2 });
}
function failedQueue(settings = {}, dlqSettings = {}) {
  return doc([client('u', { requestRateOverridePerSecond: 10 }), server('s'), queue('q', { processingFailureShare: 1, maxAttempts: 3, retryDelayMs: 10, ...settings }), server('w'), job('deadLetter', 'dlq', dlqSettings)],
    [edge('u', 's', INSTANT), edge('s', 'q', INSTANT), edge('q', 'w', INSTANT), edge('q', 'dlq', INSTANT)], { durationSeconds: 1, drainSeconds: 3 });
}
describe('Background job integration', () => {
  it('stream consumers each process a copy and reading retains history', () => {
    const r = runSimulation(stream()); expect(r.status).toBe('completed'); expect(r.completed).toBe(10); expect(r.messagesPublished).toBe(10);
    expect(r.queues.map(q => q.processed)).toEqual([10, 10]); expect(r.jobServices![0]!.details.retained).toBe(10);
    expect(r.links.find(l => l.fromId === 'log' && l.toId === 's')!.messages).toBe(10);
  });
  it('earliest catches up while latest skips history at delayed start', () => {
    const early = runSimulation(stream({ consumerStartSeconds: 0.5, startPosition: 'earliest' }));
    const late = runSimulation(stream({ consumerStartSeconds: 0.5, startPosition: 'latest' }));
    expect(early.queues[0]!.processed).toBe(10); expect(late.queues[0]!.processed).toBe(5);
  });
  it('one slow group does not hold up another; retention losses are explicit', () => {
    const d = stream({ retentionSeconds: 0.15, partitions: 1 }); Object.assign(d.nodes[3]!.settings, { cpuMsPerRequest: 1000 });
    const r = runSimulation(d); expect(r.queues[1]!.processed).toBe(10); expect(r.queues[0]!.refused).toBeGreaterThan(0);
    expect(r.jobServices![0]!.details.expired).toBe(10);
  });
  it('bounded log evicts oldest records and supports a publisher without consumers', () => {
    const d = stream({ maxDepth: 3 }); d.nodes = d.nodes.slice(0, 3); d.edges = d.edges.slice(0, 2);
    const r = runSimulation(d); expect(r.completed).toBe(10); expect(r.jobServices![0]!.details).toMatchObject({ retained: 3, evicted: 7 });
  });
  it('retries three attempts then routes one failed job to DLQ without rejecting its user', () => {
    const r = runSimulation(failedQueue()); expect(r.status).toBe('completed'); expect(r.completed).toBe(10); expect(r.rejected).toBe(0);
    const q = r.queues.find(q => q.nodeId === 'q')!; expect(q).toMatchObject({ enqueued: 10, retries: 20, failed: 10, outstanding: 0 });
    expect(r.jobServices!.find(s => s.kind === 'deadLetter')).toMatchObject({ accepted: 10, waiting: 10 });
    expect(r.links.find(l => l.fromId === 'q' && l.toId === 'dlq')!.messages).toBe(10);
  });
  it('replay runs once through its connected worker and clears holding queue', () => {
    const d = failedQueue({}, { replayEnabled: true, replayDelaySeconds: 0.05 }); d.nodes.push(server('replay')); d.edges.push(edge('dlq', 'replay', INSTANT));
    const r = runSimulation(d); expect(r.status).toBe('completed'); expect(r.jobServices![0]).toMatchObject({ completed: 10, waiting: 0 });
    expect(r.completed).toBe(10); expect(r.messagesProcessed).toBe(10);
  });
  it('DLQ retention and refused capacity are counted, not silently lost', () => {
    const r = runSimulation(failedQueue({}, { maxDepth: 2, retentionSeconds: 0.5 }));
    const m = r.jobServices![0]!; expect(m.details.refused).toBeGreaterThan(0); expect(m.details.expired).toBe(m.accepted); expect(m.waiting).toBe(0);
  });
  it('scheduler works without users and does not inflate user totals', () => {
    const d = doc([job('scheduler', 'cron', { intervalSeconds: 0.25, batchSize: 2 }), server('w')], [edge('cron', 'w', INSTANT)], { durationSeconds: 1 });
    const r = runSimulation(d); expect(r.status).toBe('completed'); expect(r.offered).toBe(0); expect(r.clients).toEqual([]);
    expect(r.jobServices![0]).toMatchObject({ accepted: 8, completed: 8, details: { ticks: 4, skipped: 0 } }); expect(r.usage.requestsByNodeId.cron).toBe(8);
  });
  it('scheduler bounds overlap and skips excess ticks', () => {
    const d = doc([job('scheduler', 'cron', { intervalSeconds: 0.1, maxConcurrentJobs: 1 }), server('w', { cpuMsPerRequest: 350 })], [edge('cron', 'w', INSTANT)], { durationSeconds: 1 });
    const r = runSimulation(d); expect(r.jobServices![0]!.details.skipped).toBeGreaterThan(0); expect(r.jobServices![0]!.accepted).toBe(3);
  });
  it('invalid retry cycles and invalid scheduler targets are rejected', () => {
    const d = failedQueue({}, { replayEnabled: true }); d.edges.push(edge('dlq', 's', INSTANT)); expect(validateAndResolve(d).hasErrors).toBe(true);
    const x = doc([job('scheduler', 'cron'), job('eventStream', 'log')], [edge('cron', 'log', INSTANT)]); expect(validateAndResolve(x).hasErrors).toBe(true);
  });
  it('live snapshots do not expire or duplicate records', () => {
    const d = stream({ retentionSeconds: 0.2 }); const a = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
    const b = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
    for (let t = 100; t <= 2000; t += 100) { a.step(100000, t); a.result(); a.result(); }
    b.step(1000000, 2000); expect(a.result().jobServices).toEqual(b.result().jobServices);
  });
  for (const kind of JOB_KINDS) it(`${kind}: settings and immutable run metrics reopen with unpriced cost`, () => {
    const d = kind === 'eventStream' ? stream() : kind === 'deadLetter' ? failedQueue() : doc([job('scheduler', 'cron'), server('w')], [edge('cron', 'w', INSTANT)]);
    expect(architectureDocumentSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const target = d.nodes.find(n => n.kind === kind)!;
    for (const [key, field] of Object.entries(JOB_SERVICES[kind].fields)) {
      if ('min' in field) { const bad = structuredClone(d); Object.assign(bad.nodes.find(n => n.id === target.id)!.settings, { [key]: -1 }); expect(architectureDocumentSchema.safeParse(bad).success, key).toBe(false); }
    }
    const result = runSimulation(d); const cost = estimateCost({ document: d, catalog, usage: result.usage });
    expect(cost.lines.filter(l => l.nodeId === target.id).every(l => l.unpriced)).toBe(true);
    const record = createRunRecord({ projectId: 'p', label: 'jobs', document: d, catalog, result, cost });
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record))).result.jobServices).toEqual(result.jobServices);
  });
});
