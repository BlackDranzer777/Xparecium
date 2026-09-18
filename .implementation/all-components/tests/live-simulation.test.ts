import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTemplate } from '../src/domain/defaults';
import { DEFAULT_LIMITS } from '../src/domain/types';
import { formatPercent } from '../src/domain/units';
import { SimulationEngine, runSimulation } from '../src/simulation/engine';
import { SimulationClient } from '../src/workers/client';
import type { SimulationResult } from '../src/simulation/types';
import { client, server, doc, edge, INSTANT } from './helpers';

function advance(engine: SimulationEngine, ms: number) {
  while (!engine.isFinished && engine.progressUpdate.simulatedMs < ms) engine.step(1000, ms);
  return engine.result();
}

describe('steady arrivals at the end boundary', () => {
  it.each([3, 7, 67, 470, 1000])('%s requests/s for 20s has exactly rate × duration arrivals', rate => {
    const d = buildTemplate('serverless-api');
    const c = d.nodes.find(n => n.kind === 'client')!;
    if (c.kind !== 'client') throw Error();
    c.settings.requestRateOverridePerSecond = rate;
    d.workload.durationSeconds = 20;
    expect(runSimulation(d).offered).toBe(rate * 20);
  });
});

it('continues past the configured window without resetting queues, counters or random streams', () => {
  const d = buildTemplate('serverless-api');
  d.workload.durationSeconds = 1;
  const engine = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
  const a = advance(engine, 1000);
  const saved = JSON.stringify(a);
  const b = advance(engine, 3000);
  expect(b.status).toBe('running');
  expect(b.completed).toBeGreaterThan(a.completed);
  expect(b.offered).toBe(b.completed + b.rejected + b.unfinished);
  expect(b.clients).toHaveLength(1); // workers are jobs, not users
  expect(JSON.stringify(a)).toBe(saved);
  expect(engine.result()).toEqual(b); // reading a snapshot changes nothing
  const unsampled = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
  expect(advance(unsampled, 3000)).toEqual(b);
  expect(b.journeys.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxJourneySamples);
  engine.cancel();
  const stopped = engine.result();
  engine.step(10000, 5000);
  expect(engine.result()).toEqual(stopped);
  expect(stopped.status).toBe('cancelled');
});

it('carries a saturated server queue across snapshot boundaries', () => {
  const d = doc([client('c', { requestRateOverridePerSecond: 100, requestBytes: 0, responseBytes: 0 }),
    server('s', { cpuSlots: 1, cpuMsPerRequest: 100, queueLimit: 10000 })], [edge('c', 's', INSTANT)], { durationSeconds: 0.1 });
  const engine = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
  const a = advance(engine, 500);
  const b = advance(engine, 1000);
  expect(b.unfinished).toBeGreaterThan(a.unfinished);
  expect(b.servers[0]!.cpuQueuePeak).toBeGreaterThan(a.servers[0]!.cpuQueuePeak);
  expect(b.offered).toBe(100);
  expect(b.offered).toBe(b.completed + b.rejected + b.unfinished);
});

it('bills in-flight function time and uses only elapsed time for live prices', () => {
  const d = buildTemplate('serverless-api');
  const fn = d.nodes.find(n => n.id === 'function_1')!;
  if (fn.kind !== 'serverless') throw Error();
  fn.settings.cpuMsPerRequest = 2000;
  fn.settings.coldStartShare = 0;
  const engine = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true });
  const r = advance(engine, 500);
  expect(r.usage.measuredSeconds).toBe(0.5);
  expect(r.servers[0]!.completed).toBe(0);
  expect(r.usage.busyMsByNodeId.function_1).toBeGreaterThan(0);
});

it('preserves memory limits in continuous mode', () => {
  const d = buildTemplate('starter');
  const engine = new SimulationEngine({ document: d, continuous: true,
    limits: { ...DEFAULT_LIMITS, maxInFlightRequests: 1 } });
  const r = advance(engine, 1000);
  expect(r.status).toBe('incomplete');
});

it('shows small positive utilisation without implying the component is idle', () => {
  expect(formatPercent(0, 0)).toBe('0%');
  expect(formatPercent(0.000011, 0)).toBe('<1%');
  expect(formatPercent(0.000011, 1)).toBe('<0.1%');
  expect(formatPercent(0.1, 0)).toBe('10%');
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('the fallback publishes growing results until Stop and settles superseded runs', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', class { constructor() { throw Error('unavailable'); } });
  const client = new SimulationClient();
  const snapshots: SimulationResult[] = [];
  const d = buildTemplate('starter');
  d.workload.durationSeconds = 0.1;
  const a = client.run(d, DEFAULT_LIMITS, undefined, { continuous: true, onSnapshot: r => snapshots.push(r) });
  await vi.advanceTimersByTimeAsync(1200);
  expect(snapshots.length).toBeGreaterThan(2);
  expect(snapshots.at(-1)!.completed).toBeGreaterThan(snapshots[0]!.completed);
  expect(snapshots.at(-1)!.simulatedMs).toBeGreaterThan(100);
  const b = client.run(d, DEFAULT_LIMITS, undefined, { continuous: true });
  expect((await a.result).status).toBe('cancelled');
  client.cancel();
  expect((await b.result).status).toBe('cancelled');
  const count = snapshots.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(snapshots).toHaveLength(count);
  client.dispose();
});
