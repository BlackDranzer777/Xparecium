import { describe, expect, it } from 'vitest';
import { makeNode, buildTemplate, TEMPLATES } from '../src/domain/defaults';
import type { SupportKind, SupportNode } from '../src/domain/support-services';
import { SUPPORT_KINDS, SUPPORT_SERVICES, INLINE_SUPPORT } from '../src/domain/support-services';
import { runSimulation, SimulationEngine } from '../src/simulation/engine';
import { DEFAULT_LIMITS } from '../src/domain/types';
import { architectureDocumentSchema } from '../src/domain/schema';
import { validateAndResolve } from '../src/simulation/routing';
import { client, server, queue, apiGateway, doc, edge, INSTANT } from './helpers';
import { cloudCatalogSchema } from '../src/catalogs/types';
import raw from '../public/catalogs/cloud-profiles.v1.json';
import { estimateCost } from '../src/pricing/pricing';
import { createRunRecord } from '../src/storage/runs';
import { runRecordSchema } from '../src/storage/run-schema';
function support(kind: SupportKind, settings = {}, id = 'support'): SupportNode {
  const n = makeNode(kind, id, kind, { x: 0, y: 0 }) as SupportNode; Object.assign(n.settings, settings); return n;
}
function design(kind: SupportKind, settings = {}) {
  const inline = (INLINE_SUPPORT as readonly string[]).includes(kind);
  return doc([client('u', { activeUsers: 2, requestRateOverridePerSecond: 10 }), server('s', { cpuMsPerRequest: 1 }), support(kind, settings)],
    inline ? [edge('u', 'support', INSTANT), edge('support', 's', INSTANT)] : [edge('u', 's', INSTANT), edge('s', 'support', INSTANT)], { durationSeconds: 2, drainSeconds: 10 });
}
function metric(r: ReturnType<typeof runSimulation>) { return r.supportServices![0]!; }
describe('Shared service integrations', () => {
  it('WebSocket reuse avoids repeated handshakes; heartbeat traffic is measured', () => {
    const r = runSimulation(design('websocket', { heartbeatSeconds: 0.2 }));
    expect(r.completed).toBe(20); expect(metric(r).details.connectionsOpened).toBe(2); expect(metric(r).details.heartbeats).toBeGreaterThan(0);
    expect(r.links.find(l => l.fromId === 'u')!.messages).toBeGreaterThan(20);
    const longer = runSimulation(design('websocket', { handshakeMs: 100 })); expect(longer.responseTime.meanMs).toBeGreaterThan(r.responseTime.meanMs);
  });
  it('WebSocket memory limits connections, and expired leases reconnect', () => {
    const r = runSimulation(design('websocket', { memoryMb: 1, memoryPerConnectionMb: 1 }));
    expect(r.rejectionsByReason['connection-limit']).toBe(10); expect(metric(r).details.connectionsPeak).toBe(1);
    expect(metric(runSimulation(design('websocket', { connectionSeconds: 0.1 }))).details.connectionsOpened).toBe(20);
  });
  it('notification failures retry in background without changing user results', () => {
    const d = design('notification', { failureShare: 1, maxAttempts: 3, retryDelayMs: 20 }); const r = runSimulation(d);
    expect(r.completed).toBe(20); expect(r.rejected).toBe(0); expect(metric(r).completed).toBe(0);
    expect(metric(r).details).toMatchObject({ attempts: 60, retries: 40, deliveryFailed: 20 });
    const fast = runSimulation(design('notification', { failureShare: 0, deliveryMs: 0 })); expect(r.responseTime.meanMs).toBe(fast.responseTime.meanMs);
  });
  it('notification provider quota slows delivery and bounded overload drops work explicitly', () => {
    const r = runSimulation(design('notification', { failureShare: 0, ratePerSecond: 1, maxConcurrentRequests: 1, queueLimit: 1 }));
    expect(r.completed).toBe(20); expect(metric(r).rejected).toBeGreaterThan(0); expect(metric(r).completed).toBeLessThan(20);
  });
  it('identity caches valid decisions per user, with network calls on misses only', () => {
    const r = runSimulation(design('identity', { invalidShare: 0, cacheTtlSeconds: 30 }));
    expect(r.completed).toBe(20); expect(metric(r).accepted).toBe(2); expect(metric(r).details.cacheHits).toBe(18);
    expect(r.links.find(l => l.fromId === 's' && l.toId === 'support')!.messages).toBe(2);
    expect(runSimulation(design('identity', { invalidShare: 1 })).rejectionsByReason['identity-denied']).toBe(20);
  });
  it('gateway identity checks before the application receives a request', () => {
    const d = design('identity', { invalidShare: 1 }); d.nodes.push(apiGateway('g')); d.edges = [edge('u', 'g', INSTANT), edge('g', 's', INSTANT), edge('g', 'support', INSTANT)];
    const r = runSimulation(d); expect(r.status).toBe('completed'); expect(r.rejected).toBe(20); expect(r.servers[0]!.admitted).toBe(0);
  });
  it('standalone token bucket limits forwarded requests and refills', () => {
    const r = runSimulation(design('rateLimiter', { ratePerSecond: 2, burstCapacity: 2, serviceTimeMs: 0 }));
    expect(r.completed).toBe(5); expect(r.rejectionsByReason['rate-limited']).toBe(15); expect(r.servers[0]!.admitted).toBe(5);
  });
  it('discovery cache reduces calls while configuration updates can make it stale', () => {
    const r = runSimulation(design('discovery', { updateSeconds: 0.3, cacheTtlSeconds: 1 }));
    expect(metric(r).accepted).toBe(2); expect(metric(r).details.stale).toBeGreaterThan(0); expect(r.completed).toBe(20);
    expect(runSimulation(design('discovery', { unavailableShare: 1 })).rejected).toBe(20);
  });
  it('secrets rotation rejects an expired cached version until it refreshes', () => {
    const r = runSimulation(design('secrets', { rotationSeconds: 0.3, cacheTtlSeconds: 1, graceSeconds: 0.1 }));
    expect(r.rejectionsByReason['secret-expired']).toBeGreaterThan(0); expect(r.completed).toBeGreaterThan(1); expect(metric(r).accepted).toBe(2);
    expect(runSimulation(design('secrets', { rotationSeconds: 0.3, cacheTtlSeconds: 0.1, graceSeconds: 1 })).rejected).toBe(0);
  });
  it('telemetry samples separately and drops do not fail application requests', () => {
    expect(metric(runSimulation(design('monitoring', { sampleShare: 0 }))).accepted).toBe(0);
    const r = runSimulation(design('monitoring', { sampleShare: 1, serviceTimeMs: 500, maxConcurrentRequests: 1, queueLimit: 0 }));
    expect(r.completed).toBe(20); expect(r.rejected).toBe(0); expect(metric(r).rejected).toBeGreaterThan(0);
  });
  it('telemetry retention respects age and capacity without mutating snapshots', () => {
    const d = design('monitoring', { maxRecords: 3, retentionSeconds: 0.4 });
    const a = new SimulationEngine({ document: d, limits: DEFAULT_LIMITS, continuous: true }); a.step(100000, 2000);
    const first = a.result(); expect(metric(first).details.retained).toBeLessThanOrEqual(3); expect(metric(first).details.evicted).toBeGreaterThan(0); expect(a.result()).toEqual(first);
  });
  it('mesh retries are bounded and the circuit blocks before reaching the app', () => {
    const r = runSimulation(design('serviceMesh', { connectionFailureShare: 1, maxAttempts: 2, failureThreshold: 1, resetSeconds: 0.5 }));
    expect(r.completed).toBe(0); expect(r.rejected).toBe(20); expect(metric(r).details.retries).toBeGreaterThan(0); expect(metric(r).details.circuitRefused).toBeGreaterThan(0);
    expect(r.servers[0]!.admitted).toBe(0); expect(metric(r).details.attempts).toBeLessThan(40);
  });
  it('multiple dependencies preserve CPU work and support queue workers', () => {
    const d = design('identity', { invalidShare: 0 }); d.nodes.push(support('discovery', {}, 'discovery'), support('secrets', {}, 'secrets'), queue('q'), server('w', { cpuMsPerRequest: 6 }));
    d.edges.push(edge('s', 'discovery', INSTANT), edge('s', 'secrets', INSTANT), edge('s', 'q', INSTANT), edge('q', 'w', INSTANT), edge('w', 'discovery', INSTANT));
    const r = runSimulation(d); expect(r.completed).toBe(20); expect(r.messagesProcessed).toBe(20); expect(r.servers.find(s => s.nodeId === 'w')!.cpuServiceMsTotal).toBeCloseTo(120);
  });
  for (const kind of SUPPORT_KINDS) {
    it(`${kind}: every field validates, and results/pricing survive immutable history`, () => {
      const d = design(kind); expect(architectureDocumentSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
      for (const key of Object.keys(SUPPORT_SERVICES[kind].fields)) {
        const bad = structuredClone(d); Object.assign(bad.nodes[2]!.settings, { [key]: -1 }); expect(architectureDocumentSchema.safeParse(bad).success, key).toBe(false);
      }
      // The rate-less shape, held to reporting honestly; the AWS default is priced elsewhere.
      d.nodes[2]!.cloud = { profileId: `generic.${kind}` };
      const result = runSimulation(d); expect(result.status).toBe('completed');
      const catalog = cloudCatalogSchema.parse(raw); const cost = estimateCost({ document: d, catalog, usage: result.usage });
      const record = createRunRecord({ projectId: 'p', label: kind, document: d, catalog, result, cost });
      expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record))).result.supportServices).toEqual(result.supportServices);
      expect(cost.lines.filter(l => l.nodeId === 'support').length).toBeGreaterThan(0);
      expect(cost.lines.filter(l => l.nodeId === 'support').every(l => l.unpriced)).toBe(true);
    });
    it(`${kind}: rejects a backwards or ambiguous connection`, () => {
      const d = design(kind); d.edges.push(edge('support', 'u', INSTANT)); expect(validateAndResolve(d).hasErrors).toBe(true);
    });
  }
  it('all workshop templates produce valid routes', () => { for (const id of ['data-workshop', 'jobs-workshop', 'support-workshop']) { expect(TEMPLATES.some(t => t.id === id)).toBe(true); expect(validateAndResolve(buildTemplate(id)).hasErrors, id).toBe(false); } });
});
