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
  for (const kind of JOB_KINDS) it(`${kind}: settings and immutable run metrics reopen; the rate-less shape stays unpriced`, () => {
    const d = kind === 'eventStream' ? stream() : kind === 'deadLetter' ? failedQueue() : doc([job('scheduler', 'cron'), server('w')], [edge('cron', 'w', INSTANT)]);
    expect(architectureDocumentSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const target = d.nodes.find(n => n.kind === kind)!;
    for (const [key, field] of Object.entries(JOB_SERVICES[kind].fields)) {
      if ('min' in field) { const bad = structuredClone(d); Object.assign(bad.nodes.find(n => n.id === target.id)!.settings, { [key]: -1 }); expect(architectureDocumentSchema.safeParse(bad).success, key).toBe(false); }
    }
    // The rate-less shape, held to reporting honestly; the AWS default is priced elsewhere.
    target.cloud = { profileId: `generic.${kind}` };
    const result = runSimulation(d); const cost = estimateCost({ document: d, catalog, usage: result.usage });
    expect(cost.lines.filter(l => l.nodeId === target.id).every(l => l.unpriced)).toBe(true);
    const record = createRunRecord({ projectId: 'p', label: 'jobs', document: d, catalog, result, cost });
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record))).result.jobServices).toEqual(result.jobServices);
  });
});

describe('retention housekeeping and the measured interval', () => {
  // Codex regression. A record expires on the simulated clock, so a stream
  // with a long retention keeps the engine busy long after the last request.
  // That housekeeping is not workload and must not stretch the interval the
  // throughput and the bill are measured over.
  function publisherOnly(retentionSeconds: number) {
    return doc([client('u', { requestRateOverridePerSecond: 10 }), server('s'), job('eventStream', 'log', { retentionSeconds })],
      [edge('u', 's', INSTANT), edge('s', 'log', INSTANT)], { durationSeconds: 1, drainSeconds: 10 });
  }
  it('a longer retention does not lengthen the interval or lower the throughput for the same traffic', () => {
    const short = runSimulation(publisherOnly(0.01));
    const long = runSimulation(publisherOnly(5));
    expect(short.completed).toBe(10); expect(long.completed).toBe(10);
    expect(short.simulatedMs).toBe(1000);
    expect(long.simulatedMs).toBe(1000);
    expect(long.usage.measuredSeconds).toBe(short.usage.measuredSeconds);
    expect(long.throughputPerSecond).toBe(short.throughputPerSecond);
    expect(long.throughputPerSecond).toBe(10);
    // The housekeeping still ran: every record outlived its retention within the drain.
    expect(long.jobServices![0]!.details).toMatchObject({ expired: 10, retained: 0 });
    // And the projected bill is the same for the same traffic.
    const requests = (r: typeof short) => estimateCost({ document: publisherOnly(5), catalog, usage: r.usage }).lines.find(l => l.nodeId === 'log' && l.chargeType === 'requests')!;
    expect(requests(long).quantity).toBe(requests(short).quantity);
    expect(requests(long).monthly).toBe(requests(short).monthly);
  });
  it('genuine unfinished work still extends the interval into the drain', () => {
    // A one-slot worker that needs 300 ms per job is still working through
    // the backlog after arrivals stop; that is workload, and it counts.
    const d = doc([client('u', { requestRateOverridePerSecond: 10 }), server('s'), job('eventStream', 'log', { retentionSeconds: 60 }), server('w', { cpuSlots: 1, concurrencyLimit: 1, cpuMsPerRequest: 300 })],
      [edge('u', 's', INSTANT), edge('s', 'log', INSTANT), edge('log', 'w', INSTANT)], { durationSeconds: 1, drainSeconds: 10 });
    const r = runSimulation(d);
    expect(r.status).toBe('completed');
    expect(r.queues[0]!.processed).toBe(10);
    expect(r.simulatedMs).toBeGreaterThan(2500);
    expect(r.simulatedMs).toBeLessThanOrEqual(11_000);
    // With a drain too short for the backlog, the whole window was used.
    const cut = runSimulation({ ...d, workload: { ...d.workload, drainSeconds: 0.5 } });
    expect(cut.simulatedMs).toBe(1500);
    expect(cut.queues[0]!.outstanding).toBeGreaterThan(0);
  });
  it('Live mode measures the clock itself, whatever the retention', () => {
    for (const retention of [0.01, 5]) {
      const engine = new SimulationEngine({ document: publisherOnly(retention), limits: DEFAULT_LIMITS, continuous: true });
      engine.step(1_000_000, 2000);
      expect(engine.result().simulatedMs).toBe(2000);
    }
  });
  it('a dead-letter queue that empties by expiry after the work keeps an honest depth average', () => {
    // Each attempt takes 100 ms and a job fails three times with 10 ms
    // between, so nothing reaches the holding queue before 320 ms and the
    // last job is held by about 1.6 s. With a 1.5-second retention every
    // expiry happens after that, inside the drain: pure housekeeping. The
    // depth only ever rose while work flowed, so its average over the
    // measured interval cannot exceed the peak, or 10 × (interval − 320 ms).
    // Letting the expiries add time would push it past both.
    const d = failedQueue({}, { maxDepth: 100, retentionSeconds: 1.5 });
    Object.assign(d.nodes.find(n => n.id === 'w')!.settings, { cpuMsPerRequest: 100 });
    const r = runSimulation(d);
    const dlq = r.queues.find(q => q.nodeId === 'dlq')!;
    expect(dlq).toMatchObject({ enqueued: 10, expired: 10, refused: 0, outstanding: 0, depthPeak: 10 });
    expect(r.simulatedMs).toBeGreaterThan(1200);
    expect(r.simulatedMs).toBeLessThan(3000);
    expect(dlq.depthAverage).toBeGreaterThan(0);
    expect(dlq.depthAverage).toBeLessThan(dlq.depthPeak);
    expect(dlq.depthAverage).toBeLessThanOrEqual(10 * (r.simulatedMs - 320) / r.simulatedMs);
  });

  // Codex review of entry 067 (P2). One job a second for one second, failing
  // once at a 100 ms worker with no retry, so exactly one job reaches the
  // dead-letter queue at 100 ms. The work is over at 100 ms; the interval is
  // the 1-second arrival window. Whatever the retention, the average depth
  // over that second is the time the job sat there, divided by the second.
  function oneDeadLetter(retentionSeconds: number, rate = 1) {
    return doc([client('u', { requestRateOverridePerSecond: rate, requestBytes: 0, responseBytes: 0 }), server('s', { cpuMsPerRequest: 0 }),
      queue('q', { publishServiceTimeMs: 0, messageBytes: 0, processingFailureShare: 1, maxAttempts: 1 }), server('w', { cpuMsPerRequest: 100 }),
      job('deadLetter', 'dlq', { retentionSeconds, replayEnabled: false })],
      [edge('u', 's', INSTANT), edge('s', 'q', INSTANT), edge('q', 'w', INSTANT), edge('q', 'dlq', INSTANT)], { durationSeconds: 1, drainSeconds: 10 });
  }
  const held = (retentionSeconds: number) => {
    const r = runSimulation(oneDeadLetter(retentionSeconds));
    expect(r.status).toBe('completed');
    expect(r.simulatedMs).toBe(1000);
    const dlq = r.queues.find(q => q.nodeId === 'dlq')!;
    expect(dlq).toMatchObject({ enqueued: 1, depthPeak: 1 });
    return dlq;
  };
  it('a message that expires inside the measured interval counts for the time it waited', () => {
    // Held from 100 ms to 600 ms: half the second.
    expect(held(0.5)).toMatchObject({ expired: 1, outstanding: 0 });
    expect(held(0.5).depthAverage).toBeCloseTo(0.5, 9);
  });
  it('a message that expires after the measured interval counts up to its end and no further', () => {
    // Held from 100 ms past the end of the second; expires at 2.1 s inside the drain.
    expect(held(2)).toMatchObject({ expired: 1, outstanding: 0 });
    expect(held(2).depthAverage).toBeCloseTo(0.9, 9);
    // And exactly the same average when it never expires within the drain.
    expect(held(60)).toMatchObject({ expired: 0, outstanding: 1 });
    expect(held(60).depthAverage).toBeCloseTo(0.9, 9);
  });
  it('a limit reached during housekeeping cuts the housekeeping short, not the workload', () => {
    // Three jobs are dead-lettered at 100, 433 and 767 ms and expire a second
    // later, all after the work. Stopping at the event limit after the first
    // expiry leaves the workload complete, so the interval is still the second
    // and the depth average over it is unchanged; only the expiry count differs.
    const d = oneDeadLetter(1, 3);
    const full = runSimulation(d);
    const maintenance = 3;
    const cut = new SimulationEngine({ document: d, limits: { ...DEFAULT_LIMITS, maxProcessedEvents: full.eventsProcessed - maintenance + 1 }, continuous: false }).runToCompletion();
    expect(full.queues.find(q => q.nodeId === 'dlq')!).toMatchObject({ enqueued: 3, expired: 3 });
    expect(full.simulatedMs).toBe(1000);
    expect(full.queues.find(q => q.nodeId === 'dlq')!.depthAverage).toBeCloseTo((900 + 567 + 233) / 1000, 2);
    expect(cut.status).toBe('incomplete');
    expect(cut.simulatedMs).toBe(1000);
    expect(cut.queues.find(q => q.nodeId === 'dlq')!).toMatchObject({ enqueued: 3, expired: 1 });
    expect(cut.queues.find(q => q.nodeId === 'dlq')!.depthAverage).toBeCloseTo(full.queues.find(q => q.nodeId === 'dlq')!.depthAverage, 9);
  });

  for (const stop of ['cancel', 'event limit'] as const) {
    for (const retentionSeconds of [0.5, 0.9, 1.5]) {
      it(`${stop} during cleanup at ${100 + retentionSeconds * 1000} ms uses only the covered measurement interval`, () => {
        // Three simultaneous user requests fail at a serial worker. Their jobs
        // enter the DLQ at 100/200/300 ms. The first expiry can fall before,
        // exactly at, or after the 1-second measurement boundary.
        const users = [1, 2, 3].map(i => client(`u${i}`, {
          requestRateOverridePerSecond: 1, requestBytes: 0, responseBytes: 0,
        }));
        const d = doc([
          ...users, server('s', { cpuMsPerRequest: 0 }),
          queue('q', { publishServiceTimeMs: 0, messageBytes: 0, processingFailureShare: 1, maxAttempts: 1 }),
          server('w', { cpuSlots: 1, concurrencyLimit: 1, cpuMsPerRequest: 100 }),
          job('deadLetter', 'dlq', { retentionSeconds, replayEnabled: false }),
        ], [
          ...users.map(u => edge(u.id, 's', INSTANT)),
          edge('s', 'q', INSTANT), edge('q', 'w', INSTANT), edge('q', 'dlq', INSTANT),
        ], { durationSeconds: 1, drainSeconds: 10 });

        const firstExpiryMs = 100 + retentionSeconds * 1000;
        const engine = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS });
        // Stop after handling the first expiry without pinning an internal
        // event count. The next expiry is 100 ms later.
        engine.step(10_000, firstExpiryMs + 0.001);
        const eventsThroughExpiry = engine.result().eventsProcessed;
        const interrupted = new SimulationEngine({ document: d, limits: {
          ...DEFAULT_LIMITS,
          ...(stop === 'event limit' ? { maxProcessedEvents: eventsThroughExpiry } : {}),
        } });
        if (stop === 'cancel') {
          interrupted.step(eventsThroughExpiry);
          interrupted.cancel();
        } else interrupted.runToCompletion();

        const result = interrupted.result();
        const measuredMs = Math.min(firstExpiryMs, 1000);
        // Integrate each job's actual waiting interval, clipped to the time
        // measured. Do not extrapolate across expiries still waiting to run.
        const waitingMs = [100, 200, 300].reduce((area, arrival) =>
          area + Math.max(0, Math.min(measuredMs, arrival + retentionSeconds * 1000) - arrival), 0);
        expect(result.status).toBe(stop === 'cancel' ? 'cancelled' : 'incomplete');
        expect(result.completed).toBe(3);
        expect(result.simulatedMs).toBe(measuredMs);
        expect(result.throughputWindowMs).toBe(measuredMs);
        expect(result.usage.measuredSeconds).toBe(measuredMs / 1000);
        expect(result.throughputPerSecond).toBeCloseTo(3000 / measuredMs, 9);
        const dlq = result.queues.find(q => q.nodeId === 'dlq')!;
        expect(dlq).toMatchObject({ expired: 1, outstanding: 2 });
        expect(dlq.depthAverage).toBeCloseTo(waitingMs / measuredMs, 9);
        expect(interrupted.result()).toEqual(result);

        const full = runSimulation(d);
        expect(full.simulatedMs).toBe(1000);
        expect(full.queues.find(q => q.nodeId === 'dlq')!.depthAverage).toBeCloseTo(
          retentionSeconds === 0.5 ? 1.5 : 2.4, 9);
      });
    }
  }
});
