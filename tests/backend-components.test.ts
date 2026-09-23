import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { buildTemplate, DEFAULT_SERVER_SETTINGS, isReleased, makeNode, releasedTemplates, upgradeDocument } from '../src/domain/defaults';
import { architectureDocumentSchema } from '../src/domain/schema';
import { DOCUMENT_SCHEMA_VERSION } from '../src/domain/types';
import type { ArchitectureDocument, ArchNode, ServerSettings } from '../src/domain/types';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation, SimulationEngine } from '../src/simulation/engine';
import { DEFAULT_LIMITS } from '../src/domain/types';
import { validateAndResolve } from '../src/simulation/routing';
import { createRunRecord } from '../src/storage/runs';
import { runRecordSchema } from '../src/storage/run-schema';
import { client, doc, edge, queue, server, INSTANT } from './helpers';

/**
 * The three pieces that completed the backend set (entry 075): a distributed
 * lock, a workflow engine, and auto scaling on the Application Server. Each is
 * held to what it is for — one holder at a time, ordered steps that retry on
 * their own, machines that follow the load — and to an honest bill.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);
const HOURS = 730;
const EC2_M7I_LARGE = catalog.profiles.find((p) => p.id === 'aws.ec2.m7i-large.us-east-1')!.charges.compute!.amount!;

const busyServer = (id: string, overrides: Partial<ServerSettings> = {}) =>
  server(id, { cpuSlots: 16, cpuMsPerRequest: 1, concurrencyLimit: 10_000, ramMb: 1e6, ...overrides });

// ------------------------------------------------------------------- lock

function lockDesign(settings: Record<string, number>, rate = 100): ArchitectureDocument {
  const lock = makeNode('lock', 'lock', 'Lock', { x: 0, y: 0 });
  Object.assign(lock.settings as Record<string, number>, settings);
  return doc([client('u', { requestRateOverridePerSecond: rate, requestBytes: 0, responseBytes: 0 }), busyServer('s'), lock],
    [edge('u', 's', INSTANT), edge('s', 'lock', INSTANT)], { durationSeconds: 5, drainSeconds: 5 });
}
const lockMetrics = (d: ArchitectureDocument) => {
  const r = runSimulation(d);
  return { r, lock: r.supportServices!.find((s) => s.kind === 'lock')! };
};

describe('distributed lock', () => {
  it('one lock lets one request through at a time: 20 ms held caps the system at 50 a second', () => {
    const { r, lock } = lockMetrics(lockDesign({ lockKeys: 1, holdMs: 20, waitTimeoutMs: 1000 }));
    expect(r.status).toBe('completed');
    expect(r.offered).toBe(500);
    // 50 a second for the 5-second window and the drain after it.
    expect(r.throughputPerSecond).toBeCloseTo(50, 0);
    expect(r.completed).toBe(lock.details.grants);
    // The rest waited longer than a second and gave up — refused, not lost.
    expect(r.rejectionsByReason['lock-timeout']).toBe(r.offered - r.completed);
    expect(lock.details.lockTimeouts).toBe(r.offered - r.completed);
    // The one lock was held the whole time the traffic ran.
    expect(lock.details.locksHeldAverage).toBeGreaterThan(0.99);
  });

  it('one lock per item takes the waiting away', () => {
    const { r, lock } = lockMetrics(lockDesign({ lockKeys: 1000, holdMs: 20 }));
    expect(r.completed).toBe(500);
    expect(r.rejected).toBe(0);
    expect(lock.details.lockWaits).toBe(0);
    // Each request pays the grant and the held work, and nothing else.
    expect(r.responseTime.meanMs).toBeGreaterThan(20);
    expect(r.responseTime.meanMs).toBeLessThan(25);
  });

  it('a request that does not need the lock never asks for it', () => {
    const { r, lock } = lockMetrics(lockDesign({ lockKeys: 1000, lockShare: 0.5 }));
    expect(r.completed).toBe(500);
    expect(lock.details.lockSkipped! + lock.details.grants!).toBe(500);
    expect(lock.details.lockSkipped).toBeGreaterThan(200);
    expect(lock.details.lockSkipped).toBeLessThan(300);
    expect(r.usage.requestsByNodeId.lock).toBe(lock.details.grants);
  });

  it('a short wait limit refuses sooner, and the refusals are counted', () => {
    const patient = lockMetrics(lockDesign({ lockKeys: 1, waitTimeoutMs: 1000 })).r;
    const impatient = lockMetrics(lockDesign({ lockKeys: 1, waitTimeoutMs: 50 })).r;
    expect(impatient.responseTime.meanMs).toBeLessThan(patient.responseTime.meanMs);
    expect(impatient.rejectionsByReason['lock-timeout']).toBeGreaterThan(0);
  });

  it('is priced as the machines of its cluster: nodes × 730 hours at the EC2 rate', () => {
    const d = lockDesign({ clusterNodes: 5 });
    const line = estimateCost({ document: d, catalog, usage: runSimulation(d).usage }).lines.find((l) => l.nodeId === 'lock')!;
    expect(line.profileId).toBe('aws.ec2.m7i-large.lock.us-east-1');
    expect(line.verified).toBe(true);
    expect(line.rate).toBe(EC2_M7I_LARGE);
    expect(Number(line.quantity)).toBe(5 * HOURS);
    expect(Number(line.monthly)).toBeCloseTo(5 * HOURS * Number(EC2_M7I_LARGE), 2);
    expect(line.basis).toContain('5 cluster nodes');
  });

  it('only answers calls, and saved runs keep what it did', () => {
    const d = lockDesign({});
    d.edges.push(edge('lock', 's', INSTANT));
    expect(validateAndResolve(d).issues.map((i) => i.code)).toContain('topology/leaf-outgoing');
    const ok = lockDesign({ lockKeys: 1 });
    const result = runSimulation(ok);
    const cost = estimateCost({ document: ok, catalog, usage: result.usage });
    const record = createRunRecord({ projectId: 'p', label: 'lock', document: ok, catalog, result, cost });
    const reread = runRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    expect(reread.result.supportServices).toEqual(result.supportServices);
    expect(reread.result.rejectionsByReason['lock-timeout']).toBe(result.rejectionsByReason['lock-timeout']);
  });
});

// --------------------------------------------------------------- workflow

function workflowDesign(settings: Record<string, number> = {}, stepCpuMs = [50, 50, 50]): ArchitectureDocument {
  const wf = makeNode('workflow', 'wf', 'Checkout', { x: 0, y: 0 });
  Object.assign(wf.settings as Record<string, number>, settings);
  const steps = stepCpuMs.map((ms, i) => server(`step${i + 1}`, { cpuMsPerRequest: ms }));
  return doc([client('u', { requestRateOverridePerSecond: 10, requestBytes: 0, responseBytes: 0 }), server('s', { cpuMsPerRequest: 2 }), wf, ...steps],
    [edge('u', 's', INSTANT), edge('s', 'wf', INSTANT), ...steps.map((w) => edge('wf', w.id, INSTANT))], { durationSeconds: 5, drainSeconds: 10 });
}
const workflowOf = (r: ReturnType<typeof runSimulation>) => r.jobServices!.find((j) => j.kind === 'workflow')!;

describe('workflow engine', () => {
  it('runs every workflow through its steps in the order they were drawn, after the user already has an answer', () => {
    const r = runSimulation(workflowDesign());
    const w = workflowOf(r);
    expect(r.status).toBe('completed');
    expect(w).toMatchObject({ accepted: 50, completed: 50, failed: 0, waiting: 0 });
    // Three steps of 50 ms, and two saves of 20 ms between them.
    expect(w.details.meanDurationMs).toBeCloseTo(3 * 50 + 2 * 20, 3);
    // The user waited only for the server and the start: 2 ms, not 190.
    expect(r.responseTime.meanMs).toBeLessThan(10);
    const steps = r.queues.filter((q) => q.nodeId === 'wf');
    expect(steps.map((q) => q.consumerId)).toEqual(['step1', 'step2', 'step3']);
    expect(steps.map((q) => q.name)).toEqual(['Checkout · step 1', 'Checkout · step 2', 'Checkout · step 3']);
    expect(steps.every((q) => q.processed === 50 && q.kind === 'workflow')).toBe(true);
    // One state transition per step executed: what Step Functions bills.
    expect(w.details.transitions).toBe(150);
    expect(r.usage.requestsByNodeId.wf).toBe(150);
  });

  it('retries a failed step on its own, and fails the workflow only when that step runs out of attempts', () => {
    const r = runSimulation(workflowDesign({ processingFailureShare: 0.3, retryDelayMs: 100, maxAttempts: 3 }));
    const w = workflowOf(r);
    expect(w.accepted).toBe(50);
    expect(w.details.retries).toBeGreaterThan(20);
    expect(w.completed + w.failed).toBe(50);
    expect(w.completed).toBeGreaterThan(40);
    // Every attempt is billed: the steps that ran, plus their retries.
    const steps = r.queues.filter((q) => q.nodeId === 'wf');
    const executed = steps.reduce((n, q) => n + q.processed + (q.failed ?? 0), 0);
    expect(w.details.transitions).toBe(executed + (w.details.retries ?? 0));
    // A workflow that failed at a step never reached the steps after it.
    expect(steps[2]!.enqueued).toBe(w.completed);
  });

  it('with one attempt a failure is final', () => {
    const w = workflowOf(runSimulation(workflowDesign({ processingFailureShare: 1, maxAttempts: 1 })));
    expect(w).toMatchObject({ accepted: 50, completed: 0, failed: 50 });
    expect(w.details.transitions).toBe(50);
  });

  it('a step with no room fails the workflow there and counts the refusal', () => {
    // Step two's worker takes one job at a time and is slow, and one more may
    // wait for it, so later arrivals are refused.
    const d = workflowDesign({ maxDepth: 1 }, [1, 400, 1]);
    Object.assign(d.nodes.find((n) => n.id === 'step2')!.settings, { cpuSlots: 1, concurrencyLimit: 1 });
    const r = runSimulation(d);
    const w = workflowOf(r);
    const step2 = r.queues.find((q) => q.consumerId === 'step2')!;
    expect(step2.refused).toBeGreaterThan(0);
    expect(w.failed).toBeGreaterThan(0);
    expect(w.completed + w.failed + w.waiting).toBe(w.accepted);
  });

  it('is priced per state transition at the Step Functions rate', () => {
    const d = workflowDesign();
    const r = runSimulation(d);
    const line = estimateCost({ document: d, catalog, usage: r.usage }).lines.find((l) => l.nodeId === 'wf')!;
    expect(line.profileId).toBe('aws.stepfunctions.standard.us-east-1');
    expect(line.verified).toBe(true);
    expect(line.rate).toBe('25.00');
    expect(line.quantityUnit).toBe('million state transitions');
    expect(Number(line.quantity)).toBeCloseTo((150 / r.usage.measuredSeconds) * HOURS * 3600 / 1e6, 4);
    expect(line.basis).toContain('150 state transitions');
  });

  it('refuses a workflow with no steps, a step that is not compute, and a loop back into itself', () => {
    const codes = (d: ArchitectureDocument) => validateAndResolve(d).issues.filter((i) => i.severity === 'error').map((i) => i.code);
    const empty = workflowDesign(); empty.edges = empty.edges.filter((e) => e.source !== 'wf');
    expect(codes(empty)).toContain('route/queue-no-consumer');
    const wrong = workflowDesign(); wrong.nodes.push(makeNode('cache', 'c', 'c', { x: 0, y: 0 })); wrong.edges.push(edge('wf', 'c', INSTANT));
    expect(codes(wrong)).toContain('route/queue-unsupported-consumer');
    const loop = workflowDesign(); loop.edges.push(edge('step3', 'wf', INSTANT));
    expect(codes(loop)).toContain('route/queue-cycle');
    // A server starts one workflow or publishes to one queue, not both.
    const both = workflowDesign(); both.nodes.push(queue('q'), server('w')); both.edges.push(edge('s', 'q', INSTANT), edge('q', 'w', INSTANT));
    expect(codes(both)).toContain('route/server-multiple-queues');
  });

  it('saved runs keep the workflow and its steps', () => {
    const d = workflowDesign({ processingFailureShare: 0.2, retryDelayMs: 50 });
    const result = runSimulation(d);
    const cost = estimateCost({ document: d, catalog, usage: result.usage });
    const reread = runRecordSchema.parse(JSON.parse(JSON.stringify(createRunRecord({ projectId: 'p', label: 'wf', document: d, catalog, result, cost }))));
    expect(reread.result.jobServices).toEqual(result.jobServices);
    expect(reread.result.queues).toEqual(result.queues);
  });
});

// ------------------------------------------------------------ auto scaling

function scaledDesign(autoscale: Partial<ServerSettings>, rate = 100, workload: Partial<ArchitectureDocument['workload']> = {}): ArchitectureDocument {
  const group = server('s', { cpuSlots: 2, cpuMsPerRequest: 30, concurrencyLimit: 64, queueLimit: 500, minInstances: 1, maxInstances: 6,
    targetCpuShare: 0.6, instanceWarmupSeconds: 5, scaleCheckSeconds: 2, ...autoscale });
  group.cloud = { profileId: 'aws.ec2.m7i-large.us-east-1' };
  return doc([client('u', { requestRateOverridePerSecond: rate, requestBytes: 0, responseBytes: 0 }), group],
    [edge('u', 's', INSTANT)], { durationSeconds: 60, drainSeconds: 10, ...workload });
}

describe('auto scaling', () => {
  it('turns an overload into a group that keeps up', () => {
    // One instance does 2 × 1000 / 30 ≈ 67 a second; 100 a second arrive.
    const off = runSimulation(scaledDesign({ autoscaleEnabled: false }));
    const on = runSimulation(scaledDesign({ autoscaleEnabled: true }));
    expect(off.rejected).toBeGreaterThan(1000);
    expect(off.servers[0]!.instancesAverage).toBeUndefined();
    expect(off.usage.instancesByNodeId).toEqual({});
    expect(on.rejected).toBe(0);
    expect(on.completed).toBe(6000);
    expect(on.responseTime.meanMs).toBeLessThan(off.responseTime.meanMs / 10);
    const s = on.servers[0]!;
    // 100 a second × 30 ms = 3 busy slots; at 60% of 2 slots each that is 2.5, so 3 instances.
    expect(s.instancesNow).toBe(3);
    expect(s.instancesPeak).toBeLessThanOrEqual(6);
    expect(s.scaleOuts).toBeGreaterThan(0);
    expect(s.instancesAverage).toBeGreaterThan(2);
    expect(s.instancesAverage).toBeLessThan(4);
    expect(on.usage.instancesByNodeId!.s).toBeCloseTo(s.instancesAverage!, 9);
  });

  it('never goes below the fewest or above the most', () => {
    const quiet = runSimulation(scaledDesign({ autoscaleEnabled: true, minInstances: 2, maxInstances: 6 }, 1));
    expect(quiet.servers[0]!.instancesNow).toBe(2);
    expect(quiet.servers[0]!.instancesAverage).toBeCloseTo(2, 9);
    const capped = runSimulation(scaledDesign({ autoscaleEnabled: true, maxInstances: 2 }, 300));
    expect(capped.servers[0]!.instancesPeak).toBe(2);
    expect(capped.rejected).toBeGreaterThan(0);
  });

  it('steps down when the traffic falls away', () => {
    // A burst every 20 s for 5 s, five times normal, then quiet.
    const r = runSimulation(scaledDesign({ autoscaleEnabled: true }, 20, {
      arrivalPattern: 'burst',
      arrivalOptions: { rampStartMultiplier: 0.2, rampEndMultiplier: 2, burstPeriodSeconds: 20, burstDurationSeconds: 5, burstMultiplier: 6 },
    }));
    const s = r.servers[0]!;
    expect(s.scaleOuts).toBeGreaterThan(0);
    expect(s.scaleIns).toBeGreaterThan(0);
  });

  it('a new instance serves only after it has warmed up', () => {
    // A warm-up longer than the arrival window: an instance could never serve, so none is started.
    const r = runSimulation(scaledDesign({ autoscaleEnabled: true, instanceWarmupSeconds: 90 }));
    expect(r.servers[0]!.scaleOuts).toBe(0);
    expect(r.servers[0]!.instancesPeak).toBe(1);
    expect(r.rejected).toBeGreaterThan(1000);
  });

  it('scaling decisions stop with the traffic, so an idle group does not stretch a Timed run', () => {
    const r = runSimulation(scaledDesign({ autoscaleEnabled: true, minInstances: 2 }, 1, { durationSeconds: 5, drainSeconds: 30 }));
    expect(r.usage.measuredSeconds).toBeLessThan(6);
    // Live mode keeps deciding for as long as the clock runs.
    const live = new SimulationEngine({ document: scaledDesign({ autoscaleEnabled: true }), limits: DEFAULT_LIMITS, continuous: true });
    live.step(10_000_000, 120_000);
    expect(live.result().servers[0]!.instancesNow).toBe(3);
  });

  it('bills the machines it measured, warming up included, and its minimum before any run', () => {
    const d = scaledDesign({ autoscaleEnabled: true, minInstances: 2 });
    const rate = catalog.profiles.find((p) => p.id === 'aws.ec2.m7i-large.us-east-1')!.charges.compute!.amount!;
    const before = estimateCost({ document: d, catalog, usage: null }).lines.find((l) => l.nodeId === 's' && l.chargeType === 'compute')!;
    expect(Number(before.quantity)).toBe(2 * HOURS);
    expect(before.basis).toContain('minimum of 2 instances');
    const r = runSimulation(d);
    const after = estimateCost({ document: d, catalog, usage: r.usage }).lines.find((l) => l.nodeId === 's' && l.chargeType === 'compute')!;
    const average = r.usage.instancesByNodeId!.s!;
    expect(Number(after.quantity)).toBeCloseTo(average * HOURS, 1);
    expect(Number(after.monthly)).toBeCloseTo(average * HOURS * Number(rate), 1);
    expect(after.basis).toContain(`billed ${average.toFixed(2)} instances on average`);
    // A run saved before instances were measured falls back to the minimum.
    const { instancesByNodeId: _dropped, ...older } = r.usage;
    const legacy = estimateCost({ document: d, catalog, usage: older }).lines.find((l) => l.nodeId === 's' && l.chargeType === 'compute')!;
    expect(Number(legacy.quantity)).toBe(2 * HOURS);
  });

  it('off is exactly one machine, as every server was before', () => {
    const d = scaledDesign({ autoscaleEnabled: false });
    const line = estimateCost({ document: d, catalog, usage: runSimulation(d).usage }).lines.find((l) => l.nodeId === 's' && l.chargeType === 'compute')!;
    expect(line.quantity).toBe(String(HOURS));
    expect(line.basis).toMatch(/^1 instance running/);
  });

  it('settings validate, and the most can never be fewer than the fewest', () => {
    const d = scaledDesign({ autoscaleEnabled: true });
    expect(architectureDocumentSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const bad = structuredClone(d);
    Object.assign(bad.nodes[1]!.settings, { minInstances: 5, maxInstances: 2 });
    expect(architectureDocumentSchema.safeParse(bad).success).toBe(false);
  });
});

// ------------------------------------------------------------ persistence

describe('documents saved before schema version 7', () => {
  it('open with auto scaling off, and keep any value already there', () => {
    const current = buildTemplate('starter');
    const stripped = {
      ...current,
      schemaVersion: 6,
      nodes: current.nodes.map((node) => {
        if (node.kind !== 'server') return node;
        const { autoscaleEnabled: _a, minInstances: _b, maxInstances: _c, targetCpuShare: _d, instanceWarmupSeconds: _e, scaleCheckSeconds: _f, ...older } = node.settings;
        return { ...node, settings: older };
      }),
    } as unknown as ArchitectureDocument;
    const upgraded = upgradeDocument(stripped);
    expect(upgraded.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    const s = upgraded.nodes.find((n) => n.kind === 'server') as ArchNode & { kind: 'server' };
    expect(s.settings).toMatchObject({ autoscaleEnabled: false, minInstances: 1, maxInstances: 4, targetCpuShare: 0.6,
      instanceWarmupSeconds: DEFAULT_SERVER_SETTINGS.instanceWarmupSeconds, scaleCheckSeconds: DEFAULT_SERVER_SETTINGS.scaleCheckSeconds });
    // What an import would fill in through the schema, so both ways of opening agree.
    expect(s.settings).toEqual(architectureDocumentSchema.parse(stripped).nodes.find((n) => n.kind === 'server')!.settings);
    // Simulates as one machine, as it always did.
    expect(runSimulation(upgraded).servers[0]!.instancesAverage).toBeUndefined();
  });

  it('a version 7 document opens, and one from a newer build than this is refused', () => {
    expect(() => upgradeDocument({ ...buildTemplate('starter'), schemaVersion: 7 })).not.toThrow();
    const newer = DOCUMENT_SCHEMA_VERSION + 1;
    expect(() => upgradeDocument({ ...buildTemplate('starter'), schemaVersion: newer })).toThrow(new RegExp(`schema version ${newer}`));
  });
});

// ----------------------------------------------------------- the workshop

describe('backend workshop', () => {
  it('is offered, uses all three pieces, and runs clean', () => {
    expect(isReleased('lock')).toBe(true);
    expect(isReleased('workflow')).toBe(true);
    expect(releasedTemplates().some((t) => t.id === 'backend-workshop')).toBe(true);
    const d = buildTemplate('backend-workshop');
    expect(validateAndResolve(d).hasErrors).toBe(false);
    const r = runSimulation(d);
    expect(r.status).toBe('completed');
    expect(r.rejected).toBe(0);
    const app = r.servers.find((s) => s.nodeId === 'app')!;
    expect(app.scaleOuts).toBeGreaterThan(0);
    const w = r.jobServices!.find((j) => j.kind === 'workflow')!;
    expect(w.completed).toBe(w.accepted);
    expect(w.details.steps).toBe(3);
    const cost = estimateCost({ document: d, catalog, usage: r.usage });
    expect(cost.unpricedLineCount).toBe(0);
  });
});
