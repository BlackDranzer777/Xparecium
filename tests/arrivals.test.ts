import { describe, expect, it } from 'vitest';
import {
  arrivalRateMultiplier,
  meanArrivalMultiplier,
  runSimulation,
} from '../src/simulation/engine';
import { DEFAULT_WORKLOAD } from '../src/domain/defaults';
import type { ArchNode, Workload } from '../src/domain/types';
import { arrivals, client, database, doc, edge, server, INSTANT } from './helpers';

/**
 * How traffic arrives, and who decides when to send the next request.
 *
 * Two independent changes are covered here: the shape of the arrival stream
 * over the run, and whether a client waits for its own answers before asking
 * again. Both exist because flat, open-loop traffic is the least realistic
 * thing about a simulated system — real load is bursty, and real people stop
 * clicking when the page stops loading.
 */

/** One client, one server, no network delay: response time is pure CPU. */
function bench(workload: Partial<Workload>, clientOverrides: Record<string, unknown> = {}) {
  return doc(
    [
      client('c1', { requestRateOverridePerSecond: 10, ...clientOverrides }),
      server('s1', {
        profile: 'custom',
        cpuSlots: 64,
        cpuMsPerRequest: 10,
        concurrencyLimit: 10_000,
        ramMb: 1_000_000,
        queueLimit: 100_000,
      }),
    ],
    [edge('c1', 's1', INSTANT)],
    { durationSeconds: 100, drainSeconds: 30, seed: 7, ...workload },
  );
}

describe('the shape of the arrival stream', () => {
  it('leaves a constant pattern exactly as it was', () => {
    // 10 per second for 100 seconds, evenly spaced, is 1000 requests. No
    // randomness is involved, so this is exact rather than approximate.
    const result = runSimulation(bench(arrivals('constant')));
    expect(result.offered).toBe(1000);
    expect(result.completed).toBe(1000);
  });

  it('computes the rate multiplier of a ramp in closed form', () => {
    const workload: Workload = {
      ...DEFAULT_WORKLOAD,
      arrivalPattern: 'ramp',
      arrivalOptions: {
        ...DEFAULT_WORKLOAD.arrivalOptions,
        rampStartMultiplier: 0.5,
        rampEndMultiplier: 1.5,
      },
    };
    expect(arrivalRateMultiplier(workload, 0, 1000)).toBeCloseTo(0.5, 12);
    expect(arrivalRateMultiplier(workload, 500, 1000)).toBeCloseTo(1, 12);
    expect(arrivalRateMultiplier(workload, 1000, 1000)).toBeCloseTo(1.5, 12);
    // The mean of a straight line is the midpoint of its ends.
    expect(meanArrivalMultiplier(workload)).toBeCloseTo(1, 12);
  });

  it('a ramp offers the same total but back-loads it', () => {
    // mult(t) = 0.5 + t/T, so the mean is 1 and the total is unchanged at 1000.
    // The integral over the first half is 3T/8 and over the second 5T/8, so the
    // traffic should be markedly heavier in the second half.
    const result = runSimulation(
      bench(arrivals('ramp', { rampStartMultiplier: 0.5, rampEndMultiplier: 1.5 })),
    );
    expect(result.offered).toBeGreaterThan(950);
    expect(result.offered).toBeLessThan(1050);

    const firstHalf = result.journeys.filter((j) => j.startMs < 50_000).length;
    const secondHalf = result.journeys.filter((j) => j.startMs >= 50_000).length;
    expect(secondHalf).toBeGreaterThan(firstHalf);
  });

  it('computes the mean multiplier of a burst from its duty cycle', () => {
    const workload: Workload = {
      ...DEFAULT_WORKLOAD,
      arrivalPattern: 'burst',
      arrivalOptions: {
        ...DEFAULT_WORKLOAD.arrivalOptions,
        burstPeriodSeconds: 10,
        burstDurationSeconds: 2,
        burstMultiplier: 5,
      },
    };
    // Five times the rate for a fifth of the time, once otherwise:
    //   5 * 0.2 + 1 * 0.8 = 1.8
    expect(meanArrivalMultiplier(workload)).toBeCloseTo(1.8, 12);
    expect(arrivalRateMultiplier(workload, 0, 100_000)).toBe(5);
    expect(arrivalRateMultiplier(workload, 1_999, 100_000)).toBe(5);
    expect(arrivalRateMultiplier(workload, 2_001, 100_000)).toBe(1);
    expect(arrivalRateMultiplier(workload, 10_500, 100_000)).toBe(5);
  });

  it('a burst offers its duty-cycle share more than a flat run', () => {
    const result = runSimulation(
      bench(
        arrivals('burst', {
          burstPeriodSeconds: 10,
          burstDurationSeconds: 2,
          burstMultiplier: 5,
        }),
      ),
    );
    // 1000 flat requests scaled by the 1.8 mean multiplier is about 1800.
    expect(result.offered).toBeGreaterThan(1700);
    expect(result.offered).toBeLessThan(1900);
  });

  it('a burst longer than its own period is just a higher rate', () => {
    const workload: Workload = {
      ...DEFAULT_WORKLOAD,
      arrivalPattern: 'burst',
      arrivalOptions: {
        ...DEFAULT_WORKLOAD.arrivalOptions,
        burstPeriodSeconds: 5,
        burstDurationSeconds: 60,
        burstMultiplier: 3,
      },
    };
    expect(arrivalRateMultiplier(workload, 0, 100_000)).toBe(3);
    expect(arrivalRateMultiplier(workload, 4_999, 100_000)).toBe(3);
  });

  it('poisson keeps the mean rate but not the spacing, and is reproducible', () => {
    const first = runSimulation(bench(arrivals('poisson')));
    const same = runSimulation(bench(arrivals('poisson')));
    const other = runSimulation(bench({ ...arrivals('poisson'), seed: 99 }));

    // Same seed, same document, same answer — down to the request count.
    expect(same.offered).toBe(first.offered);
    expect(same.responseTime.meanMs).toBe(first.responseTime.meanMs);

    // A different seed draws different intervals.
    expect(other.offered).not.toBe(first.offered);

    // The mean is preserved: about 1000 requests, but no longer exactly 1000.
    expect(first.offered).toBeGreaterThan(900);
    expect(first.offered).toBeLessThan(1100);
    expect(first.offered).not.toBe(1000);
  });

  it('a shaped pattern does not disturb any other random stream', () => {
    // Every independent source of randomness has its own stream, so changing
    // the arrival pattern must not shift what anything else draws. Same design,
    // same seed, constant against a ramp whose mean multiplier is 1.
    const withDatabase = (workload: Partial<Workload>) => {
      const nodes: ArchNode[] = [
        client('c1', { requestRateOverridePerSecond: 10 }),
        server('s1', {
          profile: 'custom',
          cpuSlots: 64,
          cpuMsPerRequest: 1,
          concurrencyLimit: 10_000,
          ramMb: 1_000_000,
        }),
        database('d1', { queryServiceTimeMs: 1, maxConcurrentQueries: 64 }),
      ];
      return doc(nodes, [edge('c1', 's1', INSTANT), edge('s1', 'd1', INSTANT)], {
        durationSeconds: 100,
        drainSeconds: 30,
        seed: 7,
        ...workload,
      });
    };
    const flat = runSimulation(withDatabase(arrivals('constant')));
    const ramped = runSimulation(
      withDatabase(arrivals('ramp', { rampStartMultiplier: 0.5, rampEndMultiplier: 1.5 })),
    );
    expect(flat.databaseQueries).toBe(flat.offered);
    expect(ramped.databaseQueries).toBe(ramped.offered);
  });
});

describe('closed-loop clients', () => {
  /** 10 users, 100 ms of thinking, and a response that is exactly 10 ms of CPU. */
  function closedBench(overrides: Record<string, unknown> = {}) {
    return bench({}, { mode: 'closed', activeUsers: 10, thinkTimeMs: 100, ...overrides });
  }

  it('never has more requests in flight than there are users', () => {
    // The defining property: a user with a request outstanding is not sending
    // another one, so with ten users there can never be an eleventh in flight.
    const result = runSimulation(closedBench());
    expect(result.unfinished).toBeLessThanOrEqual(10);
    expect(result.rejected).toBe(0);
  });

  it('settles at the throughput the cycle time implies', () => {
    // Each user's cycle is one think time plus one response: 100 + 10 = 110 ms.
    // Ten users therefore offer about 10 / 0.110 = 90.9 per second.
    const analytic = 10 / ((100 + 10) / 1000);
    expect(analytic).toBeCloseTo(90.909, 3);

    const result = runSimulation(closedBench());
    const users = result.clients[0]!;
    expect(users.mode).toBe('closed');
    expect(users.achievedRatePerSecond).toBeGreaterThan(analytic * 0.9);
    expect(users.achievedRatePerSecond).toBeLessThan(analytic * 1.1);
  });

  it('reports the ceiling separately from what was achieved', () => {
    // With instant answers, ten users thinking for 100 ms would offer 100/s.
    const result = runSimulation(closedBench());
    const users = result.clients[0]!;
    expect(users.offeredRatePerSecond).toBeCloseTo(100, 9);
    // The real figure is lower, because answers are not instant.
    expect(users.achievedRatePerSecond).toBeLessThan(users.offeredRatePerSecond);
  });

  it('does not release the whole population at the same instant', () => {
    // Two hundred people do not click together. They are spread across one
    // think time, so the first three seconds of a run are not a burst the size
    // of the population — which is what the first version did, and it made the
    // measured rate a report of the start rather than of the system.
    //
    // The steady figure is still not a hard cap: nobody has thought yet at the
    // start, so the first request of each user is free and a short run offers
    // more than the settled rate. Both facts are asserted here so neither can
    // be quietly lost.
    const settings = { mode: 'closed', activeUsers: 200, thinkTimeMs: 3_000 };
    const short = runSimulation(bench({ durationSeconds: 6, drainSeconds: 10 }, settings));
    const long = runSimulation(bench({ durationSeconds: 300, drainSeconds: 20 }, settings));

    expect(short.clients[0]!.offeredRatePerSecond).toBeCloseTo(200 / 3, 6);

    // No instant of the run carries the whole population at once.
    const startedInFirst10ms = short.journeys.filter((j) => j.startMs < 10).length;
    expect(startedInFirst10ms).toBeLessThan(short.journeys.length);

    // Given long enough to settle, the rate falls to the steady figure.
    expect(long.clients[0]!.achievedRatePerSecond).toBeLessThan(200 / 3);
    expect(long.clients[0]!.achievedRatePerSecond).toBeGreaterThan(0.9 * (200 / 3));
    // And the short run is the faster of the two, not the slower.
    expect(short.clients[0]!.achievedRatePerSecond).toBeGreaterThan(
      long.clients[0]!.achievedRatePerSecond,
    );
  });

  it('backs off when the system is overloaded, where an open client does not', () => {
    // One CPU slot at 50 ms per request: the server can finish 20 per second.
    // An open client asked for 100/s piles them up regardless; a closed
    // population waits for its answers, so it offers far less.
    const bottleneck = (clientOverrides: Record<string, unknown>) =>
      doc(
        [
          client('c1', clientOverrides),
          server('s1', {
            profile: 'custom',
            cpuSlots: 1,
            cpuMsPerRequest: 50,
            concurrencyLimit: 10_000,
            ramMb: 1_000_000,
            queueLimit: 1_000_000,
          }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 60, drainSeconds: 120, seed: 3 },
      );

    const open = runSimulation(bottleneck({ mode: 'open', requestRateOverridePerSecond: 100 }));
    const closed = runSimulation(bottleneck({ mode: 'closed', activeUsers: 10, thinkTimeMs: 100 }));

    expect(open.offered).toBe(6000);
    expect(closed.offered).toBeLessThan(open.offered / 2);
    // The closed population cannot outrun the server: it offers roughly what
    // the server can actually finish, near 20 per second across 60 seconds.
    expect(closed.offered).toBeGreaterThan(900);
    expect(closed.offered).toBeLessThan(1500);
  });

  it('is reproducible from its seed', () => {
    const a = runSimulation(closedBench());
    const b = runSimulation(closedBench());
    expect(b.offered).toBe(a.offered);
    expect(b.responseTime.meanMs).toBe(a.responseTime.meanMs);
  });
});
