import { describe, expect, it } from 'vitest';
import { runSimulation } from '../src/simulation/engine';
import { validateAndResolve } from '../src/simulation/routing';
import type { ArchEdge, ArchNode } from '../src/domain/types';
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
  server,
  waf,
  INSTANT,
} from './helpers';

/**
 * The four components in front of everything.
 *
 * Each has exactly one reason of its own to stop a request, and that reason is
 * the whole point of drawing it: a CDN answers hits itself, a WAF refuses what
 * it judges malicious, a gateway refuses what is over its limit, and a DNS is
 * consulted before a request even sets off. These tests hold each to the one
 * thing it does, and hold the chain together.
 */

/** Users -> [hops] -> one server doing 10 ms of CPU, with nothing else on the wire. */
function chained(hops: ArchNode[], workload = {}) {
  const nodes: ArchNode[] = [
    client('c1', { requestRateOverridePerSecond: 10, requestBytes: 0, responseBytes: 0 }),
    ...hops,
    server('s1', {
      profile: 'custom',
      cpuSlots: 64,
      cpuMsPerRequest: 10,
      concurrencyLimit: 100_000,
      ramMb: 10_000_000,
      queueLimit: 1_000_000,
    }),
  ];
  const path = ['c1', ...hops.map((h) => h.id), 's1'];
  const edges: ArchEdge[] = [];
  for (let i = 0; i < path.length - 1; i += 1) edges.push(edge(path[i]!, path[i + 1]!, INSTANT));
  return doc(nodes, edges, { durationSeconds: 100, drainSeconds: 10, seed: 11, ...workload });
}

describe('CDN', () => {
  it('answers hits at the edge, and the origin never hears of them', () => {
    // 1,000 requests at an assumed 80% hit rate: about 800 answered by the
    // CDN in 1 ms, about 200 forwarded and answered in 1 + 10 ms.
    const result = runSimulation(chained([cdn('cdn', { hitRate: 0.8, serviceTimeMs: 1 })]));
    const edgeStation = result.stations.find((s) => s.kind === 'cdn')!;
    const origin = result.servers[0]!;

    expect(result.offered).toBe(1000);
    expect(result.completed).toBe(1000);
    expect(edgeStation.hits! + edgeStation.misses!).toBe(1000);
    expect(edgeStation.hits).toBeGreaterThan(740);
    expect(edgeStation.hits).toBeLessThan(860);
    expect(origin.completed).toBe(edgeStation.misses);

    // Mean response: 0.8 x 1 + 0.2 x 11 = 3 ms, give or take the sampling.
    expect(result.responseTime.meanMs).toBeGreaterThan(2.4);
    expect(result.responseTime.meanMs).toBeLessThan(3.6);
    expect(result.responseTime.minMs).toBeCloseTo(1, 9);
    expect(result.responseTime.maxMs).toBeCloseTo(11, 9);
  });

  it('is where the bytes leave, so egress is its charge and not the origin\'s', () => {
    const document = chained([cdn('cdn', { hitRate: 0.5 })]);
    const users = document.nodes.find((n) => n.kind === 'client')!;
    if (users.kind === 'client') users.settings.responseBytes = 10_000;
    const result = runSimulation(document);
    expect(result.usage.egressByNodeId['cdn']).toBeGreaterThan(0);
    expect(result.usage.egressByNodeId['s1'] ?? 0).toBe(0);
    // Every completed request sent 10,000 bytes to the users, hit or miss.
    expect(result.usage.egressByNodeId['cdn']).toBe(result.completed * 10_000);
  });

  it('sends everything through at a hit rate of zero', () => {
    const result = runSimulation(chained([cdn('cdn', { hitRate: 0, serviceTimeMs: 1 })]));
    expect(result.servers[0]!.completed).toBe(1000);
    expect(result.responseTime.meanMs).toBeCloseTo(11, 9);
  });
});

describe('WAF', () => {
  it('refuses the blocked share, and nothing behind it sees them', () => {
    const result = runSimulation(chained([waf('waf', { blockRate: 0.1, serviceTimeMs: 0 })]));
    const firewall = result.stations.find((s) => s.kind === 'waf')!;
    expect(firewall.blocked).toBeGreaterThan(70);
    expect(firewall.blocked).toBeLessThan(130);
    expect(result.rejectionsByReason['waf-blocked']).toBe(firewall.blocked);
    expect(result.rejected).toBe(firewall.blocked);
    expect(result.completed).toBe(1000 - firewall.blocked!);
    expect(result.servers[0]!.completed).toBe(result.completed);
  });

  it('blocks nothing at a block rate of zero, and draws no random number doing it', () => {
    // The WAF's stream is separate from everything else's, and a zero rate
    // never even consults it — so a design with a passive WAF simulates
    // exactly as it did without one, cache hits included.
    const withCache = (hops: ArchNode[]) => {
      const nodes: ArchNode[] = [
        client('c1', { requestRateOverridePerSecond: 10 }),
        ...hops,
        server('s1', { profile: 'custom', cpuSlots: 64, cpuMsPerRequest: 1, concurrencyLimit: 10_000, ramMb: 1_000_000 }),
        cache('k1', { hitRate: 0.7 }),
        database('d1', { queryServiceTimeMs: 1, maxConcurrentQueries: 64 }),
      ];
      const path = ['c1', ...hops.map((h) => h.id), 's1'];
      const edges: ArchEdge[] = [];
      for (let i = 0; i < path.length - 1; i += 1) edges.push(edge(path[i]!, path[i + 1]!, INSTANT));
      edges.push(edge('s1', 'k1', INSTANT), edge('s1', 'd1', INSTANT));
      return doc(nodes, edges, { durationSeconds: 100, drainSeconds: 10, seed: 11 });
    };
    const plain = runSimulation(withCache([]));
    const guarded = runSimulation(withCache([waf('waf', { blockRate: 0 })]));
    expect(guarded.rejected).toBe(0);
    expect(guarded.cacheHits).toBe(plain.cacheHits);
    expect(guarded.cacheMisses).toBe(plain.cacheMisses);
  });
});

describe('API gateway', () => {
  it('lets the configured rate through and refuses the rest', () => {
    // 10 a second offered, 5 a second allowed with a burst of 5: the first
    // five pass on the stored burst, then one in two for the rest of the run.
    // 100 seconds: about 5 + 500 admitted, about 495 refused.
    const result = runSimulation(
      chained([apiGateway('gw', { rateLimitPerSecond: 5, burstCapacity: 5, serviceTimeMs: 0 })]),
    );
    const gateway = result.stations.find((s) => s.kind === 'apiGateway')!;
    expect(gateway.throttled).toBeGreaterThan(480);
    expect(gateway.throttled).toBeLessThan(510);
    expect(result.rejectionsByReason['gateway-throttled']).toBe(gateway.throttled);
    expect(result.completed + result.rejected).toBe(1000);
    expect(result.servers[0]!.completed).toBe(result.completed);
  });

  it('refuses over the limit rather than queueing, so nobody behind it waits', () => {
    const result = runSimulation(
      chained([apiGateway('gw', { rateLimitPerSecond: 5, burstCapacity: 5, serviceTimeMs: 0 })]),
    );
    // Those that got through were served at once: 10 ms, no queueing anywhere.
    expect(result.responseTime.maxMs).toBeCloseTo(10, 9);
    expect(result.meanWaitMs).toBeCloseTo(0, 9);
  });

  it('throttles nothing without a limit', () => {
    const result = runSimulation(chained([apiGateway('gw', { rateLimitPerSecond: null })]));
    expect(result.rejected).toBe(0);
    expect(result.completed).toBe(1000);
  });
});

describe('DNS', () => {
  /** Users -> server, with a DNS beside the users. */
  function withDns(lookupShare: number) {
    return doc(
      [
        client('c1', { requestRateOverridePerSecond: 10, requestBytes: 0, responseBytes: 0 }),
        dns('dns', { lookupShare, lookupServiceTimeMs: 20, queryBytes: 0, answerBytes: 0 }),
        server('s1', {
          profile: 'custom', cpuSlots: 64, cpuMsPerRequest: 10, concurrencyLimit: 100_000, ramMb: 10_000_000,
        }),
      ],
      [edge('c1', 'dns', INSTANT), edge('c1', 's1', INSTANT)],
      { durationSeconds: 100, drainSeconds: 10, seed: 11 },
    );
  }

  it('is consulted by a share of requests before they set off, and by no others', () => {
    // Half the requests pay a 20 ms lookup before their 10 ms of work.
    const result = runSimulation(withDns(0.5));
    const resolver = result.stations.find((s) => s.kind === 'dns')!;
    expect(resolver.operations).toBeGreaterThan(440);
    expect(resolver.operations).toBeLessThan(560);
    expect(result.completed).toBe(1000);
    expect(result.responseTime.minMs).toBeCloseTo(10, 9);
    expect(result.responseTime.maxMs).toBeCloseTo(30, 9);
    // 0.5 x 10 + 0.5 x 30 = 20 ms
    expect(result.responseTime.meanMs).toBeGreaterThan(18.5);
    expect(result.responseTime.meanMs).toBeLessThan(21.5);
  });

  it('costs nothing when every answer is cached', () => {
    const result = runSimulation(withDns(0));
    expect(result.stations.find((s) => s.kind === 'dns')!.operations).toBe(0);
    expect(result.responseTime.meanMs).toBeCloseTo(10, 9);
  });
});

describe('the whole edge, in order', () => {
  it('runs clean and accounts for every request', () => {
    // Users -> CDN -> WAF -> gateway -> balancer -> two servers -> database,
    // with a DNS beside the users. The realistic front of a web system.
    const nodes: ArchNode[] = [
      client('c1', { requestRateOverridePerSecond: 20 }),
      dns('dns'),
      cdn('cdn', { hitRate: 0.6 }),
      waf('waf', { blockRate: 0.05 }),
      apiGateway('gw', { rateLimitPerSecond: 15, burstCapacity: 30 }),
      loadBalancer('lb'),
      server('s1', { profile: 'custom', cpuSlots: 4, cpuMsPerRequest: 5, concurrencyLimit: 1000, ramMb: 100_000 }),
      server('s2', { profile: 'custom', cpuSlots: 4, cpuMsPerRequest: 5, concurrencyLimit: 1000, ramMb: 100_000 }),
      database('d1', { queryServiceTimeMs: 2, maxConcurrentQueries: 16 }),
    ];
    const edges: ArchEdge[] = [
      edge('c1', 'dns', INSTANT),
      edge('c1', 'cdn', INSTANT),
      edge('cdn', 'waf', INSTANT),
      edge('waf', 'gw', INSTANT),
      edge('gw', 'lb', INSTANT),
      edge('lb', 's1', INSTANT),
      edge('lb', 's2', INSTANT),
      edge('s1', 'd1', INSTANT),
      edge('s2', 'd1', INSTANT),
    ];
    const routing = validateAndResolve(doc(nodes, edges));
    expect(routing.hasErrors).toBe(false);
    expect(routing.routes[0]!.edgeChain.map((h) => h.kind)).toEqual(['cdn', 'waf', 'apiGateway']);
    expect(routing.routes[0]!.dnsId).toBe('dns');
    expect(routing.routes[0]!.loadBalancerId).toBe('lb');

    const result = runSimulation(doc(nodes, edges, { durationSeconds: 60, drainSeconds: 10, seed: 3 }));
    expect(result.status).toBe('completed');
    expect(result.offered).toBe(1200);
    expect(result.completed + result.rejected).toBe(1200);
    // Only what got past the CDN, the WAF and the gateway reached the servers.
    const served = result.servers.reduce((n, s) => n + s.completed, 0);
    const cdnHits = result.stations.find((s) => s.kind === 'cdn')!.hits!;
    expect(served + cdnHits + result.rejected).toBe(1200);
    expect(result.rejectionsByReason['waf-blocked']).toBeGreaterThan(0);
    // 20/s offered, 60% answered at the edge, 5% of the rest blocked: about
    // 7.6/s reach the gateway, under its 15/s limit, so it throttles nothing.
    expect(result.rejectionsByReason['gateway-throttled'] ?? 0).toBe(0);
  });
});

describe('what the edge may be connected to', () => {
  const codes = (nodes: ArchNode[], edges: ArchEdge[]) =>
    validateAndResolve(doc(nodes, edges)).issues.map((i) => i.code);

  it('refuses a hop that forwards to nothing', () => {
    expect(codes([client('c1'), cdn('cdn')], [edge('c1', 'cdn', INSTANT)])).toContain(
      'route/edge-unconnected',
    );
  });

  it('refuses a hop that forwards to two things', () => {
    expect(
      codes(
        [client('c1'), waf('waf'), server('s1'), server('s2')],
        [edge('c1', 'waf', INSTANT), edge('waf', 's1', INSTANT), edge('waf', 's2', INSTANT)],
      ),
    ).toContain('route/edge-ambiguous');
  });

  it('refuses a hop that forwards to something that cannot serve', () => {
    expect(
      codes(
        [client('c1'), apiGateway('gw'), cache('k1')],
        [edge('c1', 'gw', INSTANT), edge('gw', 'k1', INSTANT)],
      ),
    ).toContain('route/client-target');
  });

  it('refuses a loop in front of the servers', () => {
    expect(
      codes(
        [client('c1'), cdn('cdn'), waf('waf'), server('s1')],
        [edge('c1', 'cdn', INSTANT), edge('cdn', 'waf', INSTANT), edge('waf', 'cdn', INSTANT)],
      ),
    ).toContain('route/edge-cycle');
  });

  it('refuses a DNS that starts a connection, and two DNS on one group of users', () => {
    expect(
      codes(
        [client('c1'), dns('dns'), server('s1')],
        [edge('c1', 'dns', INSTANT), edge('dns', 's1', INSTANT), edge('c1', 's1', INSTANT)],
      ),
    ).toContain('topology/leaf-outgoing');
    expect(
      codes(
        [client('c1'), dns('a'), dns('b'), server('s1')],
        [edge('c1', 'a', INSTANT), edge('c1', 'b', INSTANT), edge('c1', 's1', INSTANT)],
      ),
    ).toContain('route/dns-ambiguous');
  });
});
