import { describe, expect, it } from 'vitest';
import { runSimulation, SimulationEngine } from '../src/simulation/engine';
import { DEFAULT_LIMITS } from '../src/domain/types';
import { validateAndResolve } from '../src/simulation/routing';
import {
  cache,
  client,
  database,
  doc,
  edge,
  loadBalancer,
  server,
  FAST,
  INSTANT,
} from './helpers';

/**
 * A deliberately tiny, fully deterministic system used for the hand
 * calculation. Nothing contends for anything: one request per second, four CPU
 * slots, four database slots.
 */
function handCalcDocument() {
  return doc(
    [
      client('c1', { requestRateOverridePerSecond: 1, requestBytes: 1000, responseBytes: 1000 }),
      server('s1', {
        profile: 'custom',
        cpuSlots: 4,
        cpuMsPerRequest: 10,
        concurrencyLimit: 50,
        ramMb: 100_000,
      }),
      database('d1', {
        queryServiceTimeMs: 5,
        maxConcurrentQueries: 4,
        queryRequestBytes: 100,
        queryResultBytes: 100,
      }),
    ],
    [
      edge('c1', 's1', { propagationDelayMs: 10, bandwidthMbps: 1000 }),
      edge('s1', 'd1', { propagationDelayMs: 1, bandwidthMbps: 1000 }),
    ],
    { durationSeconds: 10, drainSeconds: 5, seed: 1 },
  );
}

describe('acceptance 2 — a light-load case matches a hand calculation', () => {
  it('reproduces the exact expected response time', () => {
    const result = runSimulation(handCalcDocument());

    // Hand calculation, in milliseconds:
    //   client -> server : 1000 bytes * 8 / (1000 Mbps * 1000) = 0.008 transmit
    //                      + 10 propagation                    = 10.008
    //   CPU segment 1    : 10 ms of CPU / 2 segments           =  5
    //   server -> db     : 100 bytes * 8 / 1e6                 =  0.0008
    //                      + 1 propagation                     =  1.0008
    //   db service       :                                        5
    //   db -> server     :                                        1.0008
    //   CPU segment 2    :                                        5
    //   server -> client :                                       10.008
    //                                                    total = 37.0176
    const expected = 10.008 + 5 + 1.0008 + 5 + 1.0008 + 5 + 10.008;
    expect(expected).toBeCloseTo(37.0176, 10);

    expect(result.status).toBe('completed');
    expect(result.offered).toBe(10);
    expect(result.completed).toBe(10);
    expect(result.rejected).toBe(0);
    expect(result.unfinished).toBe(0);
    expect(result.responseTime.meanMs).toBeCloseTo(expected, 9);
    expect(result.responseTime.minMs).toBeCloseTo(expected, 9);
    expect(result.responseTime.maxMs).toBeCloseTo(expected, 9);
    expect(result.meanWaitMs).toBeCloseTo(0, 12);
    expect(result.meanServiceMs).toBeCloseTo(expected, 9);
    expect(result.databaseQueries).toBe(10);
  });

  it('measures throughput over the configured arrival window', () => {
    const result = runSimulation(handCalcDocument());
    expect(result.throughputWindowMs).toBeGreaterThanOrEqual(10_000);
    expect(result.throughputPerSecond).toBeCloseTo(10 / (result.throughputWindowMs / 1000), 10);
    expect(result.offeredRatePerSecond).toBeCloseTo(1, 10);
  });

  it('accounts for both request and response bytes on the link', () => {
    const result = runSimulation(handCalcDocument());
    const out = result.links.find((l) => l.fromId === 'c1' && l.toId === 's1');
    const back = result.links.find((l) => l.fromId === 's1' && l.toId === 'c1');
    expect(out?.bytes).toBe(10 * 1000);
    expect(back?.bytes).toBe(10 * 1000);
    expect(result.bytesEgressToClients).toBe(10 * 1000);
    // 10 requests, 10 responses, 10 queries, 10 results
    expect(result.bytesTransferred).toBe(10 * 1000 + 10 * 1000 + 10 * 100 + 10 * 100);
  });
});

describe('acceptance 1 — identical input and seed produce identical results', () => {
  it('is byte-for-byte reproducible with a cache in the path', () => {
    const build = () =>
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 400 }),
          server('s1', { profile: 'custom', cpuSlots: 2, cpuMsPerRequest: 4 }),
          cache('k1', { hitRate: 0.7 }),
          database('d1'),
        ],
        [edge('c1', 's1', FAST), edge('s1', 'k1', FAST), edge('s1', 'd1', FAST)],
        { durationSeconds: 5, drainSeconds: 5, seed: 20250909 },
      );

    const a = runSimulation(build());
    const b = runSimulation(build());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.cacheHits + a.cacheMisses).toBeGreaterThan(0);
  });

  it('produces different results for a different seed', () => {
    const build = (seed: number) =>
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 400 }),
          server('s1', { profile: 'custom', cpuSlots: 2, cpuMsPerRequest: 4 }),
          cache('k1', { hitRate: 0.5 }),
          database('d1'),
        ],
        [edge('c1', 's1', FAST), edge('s1', 'k1', FAST), edge('s1', 'd1', FAST)],
        { durationSeconds: 5, drainSeconds: 5, seed },
      );
    expect(runSimulation(build(1)).cacheHits).not.toBe(runSimulation(build(2)).cacheHits);
  });
});

describe('acceptance 3 — excess traffic produces queues, rejections or unfinished work', () => {
  it('builds a queue and rejects when the server is far beyond capacity', () => {
    const result = runSimulation(
      doc(
        [
          // 2000 requests/second against a server that can serve 50/second.
          client('c1', { requestRateOverridePerSecond: 2000 }),
          server('s1', {
            profile: 'custom',
            cpuSlots: 1,
            cpuMsPerRequest: 20,
            concurrencyLimit: 20,
            queueLimit: 50,
            ramMb: 100_000,
          }),
          database('d1', { queryServiceTimeMs: 1, maxConcurrentQueries: 64 }),
        ],
        [edge('c1', 's1', INSTANT), edge('s1', 'd1', INSTANT)],
        { durationSeconds: 3, drainSeconds: 2, seed: 5 },
      ),
    );

    expect(result.offered).toBe(6000);
    expect(result.rejected).toBeGreaterThan(0);
    expect(result.rejectionsByReason['server-queue-full']).toBeGreaterThan(0);
    const s = result.servers[0]!;
    expect(s.admissionQueuePeak).toBe(50);
    expect(s.cpuUtilisation).toBeGreaterThan(0.95);
    expect(result.completed + result.rejected + result.unfinished).toBe(result.offered);
  });

  it('rejects on the memory budget when memory is the binding constraint', () => {
    const result = runSimulation(
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 1000 }),
          server('s1', {
            profile: 'custom',
            cpuSlots: 1,
            cpuMsPerRequest: 20,
            concurrencyLimit: 10_000,
            queueLimit: 10_000,
            ramMb: 300,
            baselineMemoryMb: 100,
            memoryPerRequestMb: 10,
            memoryPerQueuedRequestMb: 1,
          }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 2, drainSeconds: 2, seed: 5 },
      ),
    );
    expect(result.rejectionsByReason['server-memory-full']).toBeGreaterThan(0);
    expect(result.servers[0]!.peakMemoryMb).toBeLessThanOrEqual(300);
  });

  it('reports requests still in flight when the drain window ends', () => {
    const result = runSimulation(
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 200 }),
          server('s1', {
            profile: 'custom',
            cpuSlots: 1,
            cpuMsPerRequest: 20,
            concurrencyLimit: 100_000,
            queueLimit: 100_000,
            ramMb: 10_000_000,
            memoryPerRequestMb: 0,
            memoryPerQueuedRequestMb: 0,
          }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 5, drainSeconds: 0, seed: 5 },
      ),
    );
    expect(result.unfinished).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.id === 'unfinished')).toBe(true);
  });
});

/** A CPU-limited system: the database is fast, the CPU is the bottleneck. */
function cpuLimited(cpuSlots: number, ramMb: number) {
  return doc(
    [
      client('c1', { requestRateOverridePerSecond: 300 }),
      server('s1', {
        profile: 'custom',
        cpuSlots,
        ramMb,
        cpuMsPerRequest: 20,
        concurrencyLimit: 64,
        queueLimit: 5000,
        baselineMemoryMb: 100,
        memoryPerRequestMb: 1,
        memoryPerQueuedRequestMb: 0.1,
      }),
      database('d1', { queryServiceTimeMs: 0.5, maxConcurrentQueries: 128 }),
    ],
    [edge('c1', 's1', INSTANT), edge('s1', 'd1', INSTANT)],
    { durationSeconds: 4, drainSeconds: 6, seed: 11 },
  );
}

describe('acceptance 4 and 5 — CPU helps a CPU-limited system, RAM alone does not', () => {
  it('completes more work with more CPU slots', () => {
    const one = runSimulation(cpuLimited(1, 4096));
    const four = runSimulation(cpuLimited(4, 4096));
    expect(one.completed).toBeGreaterThan(0);
    expect(four.completed).toBeGreaterThan(one.completed);
    expect(four.responseTime.meanMs).toBeLessThan(one.responseTime.meanMs);
    expect(four.servers[0]!.cpuUtilisation).toBeLessThan(one.servers[0]!.cpuUtilisation);
  });

  it('changes nothing at all when only RAM is increased', () => {
    const small = runSimulation(cpuLimited(1, 4096));
    const large = runSimulation(cpuLimited(1, 65_536));
    expect(large.completed).toBe(small.completed);
    expect(large.responseTime.meanMs).toBe(small.responseTime.meanMs);
    expect(large.throughputPerSecond).toBe(small.throughputPerSecond);
  });
});

function cacheDocument(hitRate: number, populateOnMiss = true) {
  return doc(
    [
      client('c1', { requestRateOverridePerSecond: 100 }),
      server('s1', { profile: 'custom', cpuSlots: 8, cpuMsPerRequest: 2 }),
      cache('k1', {
        hitRate,
        populateOnMiss,
        lookupServiceTimeMs: 0.5,
        populateServiceTimeMs: 0.5,
        maxConcurrentLookups: 64,
      }),
      database('d1', { queryServiceTimeMs: 5, maxConcurrentQueries: 64 }),
    ],
    [edge('c1', 's1', INSTANT), edge('s1', 'k1', INSTANT), edge('s1', 'd1', INSTANT)],
    { durationSeconds: 5, drainSeconds: 5, seed: 3 },
  );
}

describe('acceptance 6, 7, 8 — cache behaviour', () => {
  it('a 100% hit rate eliminates database reads', () => {
    const result = runSimulation(cacheDocument(1));
    expect(result.completed).toBe(500);
    expect(result.cacheHits).toBe(500);
    expect(result.cacheMisses).toBe(0);
    expect(result.databaseQueries).toBe(0);
    expect(result.cachePopulates).toBe(0);
  });

  it('a 0% hit rate sends every read to the database', () => {
    const result = runSimulation(cacheDocument(0));
    expect(result.cacheHits).toBe(0);
    expect(result.cacheMisses).toBe(500);
    expect(result.databaseQueries).toBe(500);
    expect(result.cachePopulates).toBe(500);
  });

  it('charges misses for the lookup overhead they added', () => {
    // Same system without a cache at all.
    const noCache = runSimulation(
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 100 }),
          server('s1', { profile: 'custom', cpuSlots: 8, cpuMsPerRequest: 2 }),
          database('d1', { queryServiceTimeMs: 5, maxConcurrentQueries: 64 }),
        ],
        [edge('c1', 's1', INSTANT), edge('s1', 'd1', INSTANT)],
        { durationSeconds: 5, drainSeconds: 5, seed: 3 },
      ),
    );
    const allMisses = runSimulation(cacheDocument(0, false));

    // A miss still costs a full cache lookup on top of the database read, so
    // an always-missing cache is strictly slower. The overhead is the 0.5 ms
    // of lookup service plus the transfer of the 256-byte lookup key and the
    // 256-byte negative reply across the (very fast) link.
    const lookupBytes = 256;
    const linkMbps = 1_000_000;
    const transferOverhead = (2 * lookupBytes * 8) / (linkMbps * 1000);
    expect(allMisses.responseTime.meanMs).toBeGreaterThan(noCache.responseTime.meanMs);
    expect(allMisses.responseTime.meanMs - noCache.responseTime.meanMs).toBeCloseTo(
      0.5 + transferOverhead,
      9,
    );
  });

  it('a high hit rate is faster than a low one when the database is slow', () => {
    const cold = runSimulation(cacheDocument(0));
    const warm = runSimulation(cacheDocument(1));
    expect(warm.responseTime.meanMs).toBeLessThan(cold.responseTime.meanMs);
  });
});

describe('acceptance 9 — larger messages take longer on a constrained link', () => {
  it('scales transfer time with message size and bandwidth', () => {
    const build = (responseBytes: number) =>
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 1, requestBytes: 100, responseBytes }),
          server('s1', { profile: 'custom', cpuSlots: 8, cpuMsPerRequest: 0 }),
        ],
        // 10 Mbps link, no propagation delay: response time is transfer time.
        [edge('c1', 's1', { propagationDelayMs: 0, bandwidthMbps: 10 })],
        { durationSeconds: 5, drainSeconds: 5, seed: 4 },
      );

    const small = runSimulation(build(1_000));
    const large = runSimulation(build(1_000_000));

    // bytes * 8 / (Mbps * 1000) milliseconds
    const smallExpected = (100 * 8) / 10_000 + (1_000 * 8) / 10_000;
    const largeExpected = (100 * 8) / 10_000 + (1_000_000 * 8) / 10_000;
    expect(small.responseTime.meanMs).toBeCloseTo(smallExpected, 9);
    expect(large.responseTime.meanMs).toBeCloseTo(largeExpected, 6);
    expect(large.responseTime.meanMs).toBeGreaterThan(small.responseTime.meanMs);
  });

  it('queues messages behind a busy link', () => {
    const result = runSimulation(
      doc(
        [
          client('c1', {
            requestRateOverridePerSecond: 50,
            requestBytes: 100,
            responseBytes: 500_000,
          }),
          server('s1', { profile: 'custom', cpuSlots: 8, cpuMsPerRequest: 0 }),
        ],
        [edge('c1', 's1', { propagationDelayMs: 0, bandwidthMbps: 100 })],
        { durationSeconds: 3, drainSeconds: 10, seed: 4 },
      ),
    );
    const back = result.links.find((l) => l.fromId === 's1' && l.toId === 'c1')!;
    expect(back.utilisation).toBeGreaterThan(0.95);
    expect(back.queuePeak).toBeGreaterThan(1);
    expect(result.waitByStageMs.network).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.id.startsWith('link-busy'))).toBe(true);
  });
});

describe('acceptance 16 — unsupported routes produce understandable validation', () => {
  it('rejects a client with two outgoing connections', () => {
    const d = doc(
      [client('c1'), server('s1'), server('s2')],
      [edge('c1', 's1', FAST), edge('c1', 's2', FAST)],
    );
    const routing = validateAndResolve(d);
    expect(routing.hasErrors).toBe(true);
    const issue = routing.issues.find((i) => i.code === 'route/client-ambiguous')!;
    expect(issue.message).toContain('2 outgoing connections');
    expect(issue.hint).toContain('one entry point per group of users');

    const result = runSimulation(d);
    expect(result.status).toBe('invalid');
    expect(result.issues.some((i) => i.code === 'route/client-ambiguous')).toBe(true);
  });

  it('rejects a client wired straight to a database', () => {
    const routing = validateAndResolve(
      doc([client('c1'), database('d1')], [edge('c1', 'd1', FAST)]),
    );
    expect(routing.issues.some((i) => i.code === 'route/client-target')).toBe(true);
  });

  it('rejects a database that calls something', () => {
    const routing = validateAndResolve(
      doc(
        [client('c1'), server('s1'), database('d1'), cache('k1')],
        [edge('c1', 's1', FAST), edge('s1', 'd1', FAST), edge('d1', 'k1', FAST)],
      ),
    );
    const issue = routing.issues.find((i) => i.code === 'topology/leaf-outgoing');
    expect(issue?.severity).toBe('error');
    expect(issue?.hint).toContain('only answers calls');
  });

  it('rejects two databases behind one server', () => {
    const routing = validateAndResolve(
      doc(
        [client('c1'), server('s1'), database('d1'), database('d2')],
        [edge('c1', 's1', FAST), edge('s1', 'd1', FAST), edge('s1', 'd2', FAST)],
      ),
    );
    expect(routing.issues.some((i) => i.code === 'route/server-multiple-databases')).toBe(true);
  });

  it('warns, but still runs, when a component carries no traffic', () => {
    const d = doc(
      [client('c1'), server('s1'), database('d1'), database('spare')],
      [edge('c1', 's1', FAST), edge('s1', 'd1', FAST)],
      { durationSeconds: 1, drainSeconds: 1 },
    );
    const routing = validateAndResolve(d);
    expect(routing.hasErrors).toBe(false);
    const warning = routing.issues.find((i) => i.code === 'topology/unreachable')!;
    expect(warning.severity).toBe('warning');
    expect(warning.nodeIds).toEqual(['spare']);
    expect(runSimulation(d).status).toBe('completed');
  });

  it('explains an empty canvas', () => {
    const routing = validateAndResolve(doc([], []));
    expect(routing.issues.some((i) => i.code === 'topology/no-client')).toBe(true);
  });
});

describe('engine safety limits', () => {
  it('labels a run incomplete when an execution limit is reached', () => {
    const d = doc(
      [
        client('c1', { requestRateOverridePerSecond: 5000 }),
        server('s1', { profile: 'custom', cpuSlots: 1, cpuMsPerRequest: 50, queueLimit: 500_000, concurrencyLimit: 500_000, ramMb: 10_000_000, memoryPerRequestMb: 0, memoryPerQueuedRequestMb: 0 }),
      ],
      [edge('c1', 's1', INSTANT)],
      { durationSeconds: 60, drainSeconds: 10, seed: 1 },
    );
    const result = runSimulation(d, {
      maxPendingEvents: 5_000,
      maxInFlightRequests: 5_000,
      maxProcessedEvents: 50_000,
      maxJourneySamples: 4,
    });
    expect(result.status).toBe('incomplete');
    expect(result.statusReason).toBeTruthy();
    expect(result.findings.some((f) => f.id === 'run-incomplete')).toBe(true);
  });

  it('captures a bounded, spread-out sample of request journeys', () => {
    const result = runSimulation(handCalcDocument());
    expect(result.journeys.length).toBeGreaterThan(0);
    expect(result.journeys.length).toBeLessThanOrEqual(8);
    const first = result.journeys[0]!;
    expect(first.outcome).toBe('completed');
    expect(first.steps.map((s) => s.label)).toContain('Database query sent');
    expect(first.steps.map((s) => s.label)).toContain('Response received by client');
  });
});

describe('cancellation', () => {
  it('stops promptly and measures over the time it actually reached', () => {
    const engine = new SimulationEngine({
      document: doc(
        [
          client('c1', { requestRateOverridePerSecond: 100 }),
          server('s1', { profile: 'custom', cpuSlots: 8, cpuMsPerRequest: 1 }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 10_000, drainSeconds: 10, seed: 2 },
      ),
      limits: DEFAULT_LIMITS,
    });

    engine.step(2_000);
    expect(engine.isFinished).toBe(false);
    const reached = engine.progressUpdate.simulatedMs;
    engine.cancel();
    expect(engine.isFinished).toBe(true);

    const result = engine.result();
    expect(result.status).toBe('cancelled');
    expect(result.statusReason).toContain('cancelled');
    // The configured window was 10,000 s but only a fraction of it elapsed.
    expect(result.simulatedMs).toBeLessThan(10_000_000);
    expect(result.simulatedMs).toBeCloseTo(reached, 6);
    // Throughput is measured against the time that actually passed, so it is
    // close to the offered rate rather than diluted by 10,000 seconds.
    expect(result.throughputPerSecond).toBeGreaterThan(50);
    expect(result.offered).toBeLessThan(1_000_000);
  });

  it('marks a client with nothing attached as invalid rather than running it', () => {
    const result = runSimulation(
      doc([client('c1', { requestRateOverridePerSecond: 0.1 })], [], {
        durationSeconds: 20,
        drainSeconds: 1,
        seed: 1,
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('measures a slow trickle against the configured window, not the last event', () => {
    const result = runSimulation(
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 0.1 }),
          server('s1', { profile: 'custom', cpuSlots: 4, cpuMsPerRequest: 1 }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 20, drainSeconds: 1, seed: 1 },
      ),
    );
    expect(result.offered).toBe(2); // arrivals at 0 ms and 10,000 ms
    expect(result.simulatedMs).toBeGreaterThanOrEqual(20_000);
    expect(result.throughputPerSecond).toBeCloseTo(0.1, 3);
  });
});


/* ========================================================================== */
/*  Load balancer                                                             */
/* ========================================================================== */

/** Users -> balancer -> N identical servers. No database, to isolate the fan-out. */
function balancedDocument(serverCount: number, options: {
  rate?: number;
  cpuMs?: number;
  cpuSlots?: number;
  lbQueueLimit?: number;
  lbSlots?: number;
  lbServiceMs?: number;
  policy?: 'round-robin' | 'least-busy';
  durationSeconds?: number;
  drainSeconds?: number;
} = {}) {
  const nodes = [
    client('users', { requestRateOverridePerSecond: options.rate ?? 400 }),
    loadBalancer('lb', {
      serviceTimeMs: options.lbServiceMs ?? 0,
      queueLimit: options.lbQueueLimit ?? 10_000,
      maxConcurrentRequests: options.lbSlots ?? 10_000,
      policy: options.policy ?? 'round-robin',
    }),
  ];
  const edges = [edge('users', 'lb', INSTANT)];
  for (let i = 1; i <= serverCount; i += 1) {
    nodes.push(
      server(`s${i}`, {
        profile: 'custom',
        cpuSlots: options.cpuSlots ?? 1,
        cpuMsPerRequest: options.cpuMs ?? 20,
        concurrencyLimit: 10_000,
        queueLimit: 10_000,
        ramMb: 10_000_000,
        memoryPerRequestMb: 0,
        memoryPerQueuedRequestMb: 0,
      }),
    );
    edges.push(edge('lb', `s${i}`, INSTANT));
  }
  return doc(nodes, edges, {
    durationSeconds: options.durationSeconds ?? 2,
    drainSeconds: options.drainSeconds ?? 20,
    seed: 7,
  });
}

describe('load balancer — fan-out', () => {
  it('matches a hand calculation for one request through the balancer', () => {
    const result = runSimulation(
      doc(
        [
          client('users', {
            requestRateOverridePerSecond: 1,
            requestBytes: 1000,
            responseBytes: 1000,
          }),
          loadBalancer('lb', { serviceTimeMs: 1 }),
          server('s1', { profile: 'custom', cpuSlots: 4, cpuMsPerRequest: 10 }),
          server('s2', { profile: 'custom', cpuSlots: 4, cpuMsPerRequest: 10 }),
        ],
        [
          edge('users', 'lb', { propagationDelayMs: 10, bandwidthMbps: 1000 }),
          edge('lb', 's1', { propagationDelayMs: 1, bandwidthMbps: 1000 }),
          edge('lb', 's2', { propagationDelayMs: 1, bandwidthMbps: 1000 }),
        ],
        { durationSeconds: 10, drainSeconds: 5, seed: 1 },
      ),
    );

    // users -> balancer : 1000 * 8 / 1e6 = 0.008 transmit + 10 propagation
    // balancer service  : 1
    // balancer -> server: 0.008 + 1
    // CPU (one segment) : 10
    // server -> balancer: 0.008 + 1
    // balancer -> users : 0.008 + 10
    const expected = 10.008 + 1 + 1.008 + 10 + 1.008 + 10.008;
    expect(expected).toBeCloseTo(33.032, 10);

    expect(result.status).toBe('completed');
    expect(result.completed).toBe(10);
    expect(result.responseTime.meanMs).toBeCloseTo(expected, 9);
    expect(result.responseTime.minMs).toBeCloseTo(expected, 9);
  });

  it('spreads work evenly across the servers behind it', () => {
    const result = runSimulation(balancedDocument(4, { rate: 400, cpuMs: 1 }));
    expect(result.offered).toBe(800);
    expect(result.completed).toBe(800);
    expect(result.servers).toHaveLength(4);
    // Round robin over 800 requests and 4 servers is exactly 200 each.
    for (const s of result.servers) expect(s.completed).toBe(200);
  });

  it('records the balancer as its own component, not as a server', () => {
    const result = runSimulation(balancedDocument(2, { rate: 100, cpuMs: 1 }));
    const balancer = result.stations.find((s) => s.kind === 'loadBalancer');
    expect(balancer).toBeDefined();
    expect(balancer!.name).toBe('lb');
    expect(balancer!.operations).toBe(result.offered);
    // It forwards; it never computes and never queries.
    expect(result.databaseQueries).toBe(0);
  });

  it('adding servers behind the balancer raises throughput when servers are the limit', () => {
    // Each server can serve 50/s; 400/s is offered for 2 s with a 2 s drain,
    // which is not long enough for one server to catch up but is for four.
    const one = runSimulation(balancedDocument(1, { rate: 400, cpuMs: 20, drainSeconds: 2 }));
    const four = runSimulation(balancedDocument(4, { rate: 400, cpuMs: 20, drainSeconds: 2 }));
    expect(four.completed).toBeGreaterThan(one.completed);
    expect(four.responseTime.meanMs).toBeLessThan(one.responseTime.meanMs);
    // The gain comes from four servers running flat out rather than one.
    // Per-server CPU stays pinned in both runs, because 400/s still exceeds
    // what four servers at 50/s each can serve.
    expect(four.servers).toHaveLength(4);
    for (const s of four.servers) expect(s.completed).toBeGreaterThan(0);
    expect(four.servers.reduce((n, s) => n + s.completed, 0)).toBe(four.completed);
  });

  it('rejects at the balancer when its own queue fills, before any server is picked', () => {
    const result = runSimulation(
      balancedDocument(2, {
        rate: 2000,
        cpuMs: 20,
        // One request in the balancer at a time, and almost nowhere to wait.
        lbSlots: 1,
        lbServiceMs: 2,
        lbQueueLimit: 5,
        durationSeconds: 2,
      }),
    );
    expect(result.rejectionsByReason['balancer-queue-full']).toBeGreaterThan(0);
    const balancer = result.stations.find((s) => s.kind === 'loadBalancer')!;
    expect(balancer.rejected).toBeGreaterThan(0);
    expect(balancer.queuePeak).toBe(5);
  });

  it('the least-busy policy sends work to whichever server is free', () => {
    // With nothing ever busy, least-busy keeps picking the first server: every
    // server has zero in hand and ties go to the lowest index. That is correct,
    // so the pool has to be genuinely loaded for the choice to mean anything.
    const idle = runSimulation(balancedDocument(3, { rate: 5, cpuMs: 1, policy: 'least-busy' }));
    expect(idle.servers[0]!.completed).toBe(idle.offered);
    expect(idle.servers[1]!.completed).toBe(0);

    const build = () =>
      balancedDocument(3, { rate: 300, cpuMs: 20, policy: 'least-busy', drainSeconds: 30 });
    const a = runSimulation(build());
    const b = runSimulation(build());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    for (const s of a.servers) expect(s.completed).toBeGreaterThan(0);
    expect(a.completed).toBe(a.offered);
  });

  it('reports what each group of users saw separately from the totals', () => {
    const result = runSimulation(balancedDocument(2, { rate: 100, cpuMs: 1 }));
    expect(result.clients).toHaveLength(1);
    const users = result.clients[0]!;
    expect(users.nodeId).toBe('users');
    expect(users.offered).toBe(result.offered);
    expect(users.completed).toBe(result.completed);
    expect(users.meanResponseMs).toBeCloseTo(result.responseTime.meanMs, 9);
  });

  it('sends the response back through the balancer', () => {
    const result = runSimulation(balancedDocument(2, { rate: 10, cpuMs: 1 }));
    const toUsers = result.links.find((l) => l.fromId === 'lb' && l.toId === 'users');
    const fromServer = result.links.filter((l) => l.toId === 'lb' && l.fromId !== 'users');
    expect(toUsers?.messages).toBe(result.completed);
    // Every response crossed a server-to-balancer link on the way.
    expect(fromServer.reduce((n, l) => n + l.messages, 0)).toBe(result.completed);
  });
});

describe('load balancer — validation', () => {
  it('explains a balancer with nothing behind it', () => {
    const routing = validateAndResolve(
      doc([client('users'), loadBalancer('lb')], [edge('users', 'lb', FAST)]),
    );
    expect(routing.hasErrors).toBe(true);
    const issue = routing.issues.find((i) => i.code === 'route/balancer-empty')!;
    expect(issue.message).toContain('no Application Servers behind it');
    expect(issue.hint).toContain('at least one Application Server');
  });

  it('refuses a balancer wired straight to a database', () => {
    const routing = validateAndResolve(
      doc(
        [client('users'), loadBalancer('lb'), database('d1')],
        [edge('users', 'lb', FAST), edge('lb', 'd1', FAST)],
      ),
    );
    const issue = routing.issues.find((i) => i.code === 'route/balancer-unsupported-target')!;
    expect(issue.severity).toBe('error');
    expect(issue.hint).toContain('Application Servers and Serverless Functions only');
  });

  it('warns about a balancer nobody sends traffic to', () => {
    const routing = validateAndResolve(
      doc(
        [client('users'), server('s1'), loadBalancer('spare')],
        [edge('users', 's1', FAST)],
      ),
    );
    expect(routing.hasErrors).toBe(false);
    expect(routing.issues.some((i) => i.code === 'topology/balancer-no-traffic')).toBe(true);
  });

  it('resolves one branch per server behind the balancer', () => {
    const routing = validateAndResolve(balancedDocument(3, { rate: 1 }));
    expect(routing.hasErrors).toBe(false);
    expect(routing.routes).toHaveLength(1);
    expect(routing.routes[0]!.loadBalancerId).toBe('lb');
    expect(routing.routes[0]!.branches.map((b) => b.serverId)).toEqual(['s1', 's2', 's3']);
  });
});
