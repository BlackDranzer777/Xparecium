import type { SupportNode } from '../../domain/support-services';
import { RingQueue } from '../ring-queue';
import { TimeWeightedAccumulator } from '../metrics';
import type { Rng, RandomStreams } from '../rng';
import { RetainedLog } from './retained-log';

export interface SupportJob { id: number; caller: string; actor: string; queuedAt: number; attempts: number; blocked?: string }
export interface SupportMetrics {
  nodeId: string; name: string; kind: SupportNode['kind']; accepted: number; completed: number; rejected: number;
  waiting: number; active: number; utilisation: number; waitMsTotal: number; details: Record<string, number>;
}
export type SupportStart = (id: number, delay: number, waited: number) => void;
/** Resource bounds are shared; policies below are deliberately different for each service. */
export class SupportServiceModel {
  readonly waiting = new RingQueue<SupportJob>();
  readonly active = new Map<number, SupportJob>();
  readonly busy = new TimeWeightedAccumulator(0);
  readonly sessions = new Map<string, { expires: number; route: number }>();
  private readonly cache = new Map<string, { expires: number; version: number }>();
  private readonly random: Rng;
  private readonly retained: RetainedLog | null;
  private tokens: number;
  private refilledAt = 0;
  private nextProviderAt = 0;
  private failures = 0;
  private openUntil = 0;
  accepted = 0; completed = 0; rejected = 0; waitMsTotal = 0;
  readonly details: Record<string, number> = { attempts: 0, retries: 0, cacheHits: 0, cacheMisses: 0, stale: 0,
    denied: 0, unavailable: 0, throttled: 0, connectionsOpened: 0, connectionsRefused: 0, connectionsPeak: 0, heartbeats: 0, circuitRefused: 0, deliveryFailed: 0, sampled: 0 };
  constructor(readonly node: SupportNode, streams: RandomStreams) {
    this.random = streams.stream(`support:${node.id}`);
    this.tokens = node.kind === 'rateLimiter' ? node.settings.burstCapacity : 0;
    this.retained = node.kind === 'monitoring' && node.settings.maxRecords > 0 ? new RetainedLog(1, node.settings.maxRecords, node.settings.retentionSeconds * 1000) : null;
  }
  private version(now: number): number {
    const n = this.node;
    const seconds = n.kind === 'discovery' ? n.settings.updateSeconds : n.kind === 'secrets' ? n.settings.rotationSeconds : 0;
    return seconds > 0 ? Math.floor(now / (seconds * 1000)) : 0;
  }
  /** Caller-side cache: a hit does not send a network request or consume a service slot. */
  cached(caller: string, actor: string, now: number): 'allowed' | 'secret-expired' | null {
    const n = this.node;
    if (n.kind !== 'identity' && n.kind !== 'discovery' && n.kind !== 'secrets') return null;
    const key = n.kind === 'identity' ? actor : caller;
    const entry = this.cache.get(key);
    if (!entry || entry.expires <= now) { this.cache.delete(key); this.details.cacheMisses!++; return null; }
    this.details.cacheHits!++;
    if (entry.version !== this.version(now)) {
      this.details.stale!++;
      if (n.kind === 'secrets' && now >= ((entry.version + 1) * n.settings.rotationSeconds + n.settings.graceSeconds) * 1000) {
        this.details.denied!++; return 'secret-expired';
      }
    }
    return 'allowed';
  }
  shouldSample(): boolean {
    const sample = this.node.kind !== 'monitoring' || this.random.bernoulli(this.node.settings.sampleShare);
    if (sample) this.details.sampled!++;
    return sample;
  }
  admit(job: SupportJob, now: number, start: SupportStart): boolean {
    if (this.active.size >= this.node.settings.maxConcurrentRequests && this.waiting.length >= this.node.settings.queueLimit) { this.rejected++; return false; }
    this.accepted++;
    if (this.active.size < this.node.settings.maxConcurrentRequests) this.start(job, now, start);
    else this.waiting.push(job);
    return true;
  }
  private start(job: SupportJob, now: number, start: SupportStart): void {
    this.active.set(job.id, job); this.busy.set(now, this.active.size);
    const waited = now - job.queuedAt; this.waitMsTotal += waited;
    let ms = this.node.settings.serviceTimeMs;
    if (this.node.kind === 'websocket') {
      this.expireSessions(now);
      if (!this.sessions.has(job.actor)) {
        const s = this.node.settings;
        const limit = Math.min(s.maxConnections, Math.floor(s.memoryMb / s.memoryPerConnectionMb));
        if (this.sessions.size >= limit) { job.blocked = 'connection-limit'; this.details.connectionsRefused!++; }
        else { this.sessions.set(job.actor, { expires: now + s.connectionSeconds * 1000, route: Number(job.caller) }); this.details.connectionsOpened!++; this.details.connectionsPeak = Math.max(this.details.connectionsPeak!, this.sessions.size); ms += s.handshakeMs; }
      }
    }
    this.attempt(job, now, ms, waited, start);
  }
  private attempt(job: SupportJob, now: number, ms: number, waited: number, start: SupportStart): void {
    const n = this.node;
    job.attempts++; this.details.attempts!++;
    if (n.kind === 'notification') {
      const at = Math.max(now, this.nextProviderAt); this.nextProviderAt = at + 1000 / n.settings.ratePerSecond;
      ms += at - now + n.settings.deliveryMs;
    }
    if (n.kind === 'serviceMesh') {
      if (now < this.openUntil) { job.blocked = 'circuit-open'; this.details.circuitRefused!++; }
      else ms += n.settings.connectMs;
    }
    start(job.id, ms, waited);
  }
  finish(id: number, now: number, start: SupportStart): { job: SupportJob; failure: string | null } | null {
    const job = this.active.get(id); if (!job) return null;
    const n = this.node;
    let failure: string | null = job.blocked ?? null;
    if (!failure && n.kind === 'rateLimiter') {
      this.tokens = Math.min(n.settings.burstCapacity, this.tokens + (now - this.refilledAt) / 1000 * n.settings.ratePerSecond); this.refilledAt = now;
      if (this.tokens < 1) { failure = 'rate-limited'; this.details.throttled!++; } else this.tokens--;
    }
    if (!failure && (n.kind === 'identity' || n.kind === 'discovery' || n.kind === 'secrets')) {
      if (this.random.bernoulli(n.settings.unavailableShare)) { failure = 'dependency-unavailable'; this.details.unavailable!++; }
      else if (n.kind === 'identity' && this.random.bernoulli(n.settings.invalidShare)) { failure = 'identity-denied'; this.details.denied!++; }
      else if (n.settings.cacheTtlSeconds > 0) {
        const key = n.kind === 'identity' ? job.actor : job.caller;
        this.cache.delete(key);
        while (this.cache.size >= n.settings.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: now + n.settings.cacheTtlSeconds * 1000, version: this.version(now) });
      }
    }
    if (!failure && (n.kind === 'notification' || n.kind === 'serviceMesh')) {
      const chance = n.kind === 'notification' ? n.settings.failureShare : n.settings.connectionFailureShare;
      if (this.random.bernoulli(chance)) {
        if (job.attempts < n.settings.maxAttempts) {
          this.details.retries!++;
          this.attempt(job, now + n.settings.retryDelayMs, n.settings.serviceTimeMs + n.settings.retryDelayMs, 0, start); return null;
        }
        failure = n.kind === 'notification' ? 'delivery-failed' : 'mesh-unavailable';
        if (n.kind === 'notification') this.details.deliveryFailed!++;
        else { this.failures++; if (this.failures >= n.settings.failureThreshold) { this.openUntil = now + n.settings.resetSeconds * 1000; this.failures = 0; } }
      } else if (n.kind === 'serviceMesh') this.failures = 0;
    }
    this.active.delete(id); this.busy.set(now, this.active.size);
    if (failure) this.rejected++; else { this.completed++; this.retained?.append(id, now); }
    const next = this.waiting.shift(); if (next) this.start(next, now, start);
    return { job, failure };
  }
  expireSessions(now: number): void { for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key); }
  heartbeat(now: number): Map<number, number> {
    this.expireSessions(now);
    const counts = new Map<number, number>();
    for (const session of this.sessions.values()) counts.set(session.route, (counts.get(session.route) ?? 0) + 1);
    this.details.heartbeats! += this.sessions.size;
    return counts;
  }
  maintain(now: number): void { this.expireSessions(now); this.retained?.expire(now); }
  get nextMaintenance(): number | null { return this.retained?.nextExpiryAt ?? null; }
  snapshot(now: number): SupportMetrics {
    return { nodeId: this.node.id, name: this.node.name, kind: this.node.kind, accepted: this.accepted, completed: this.completed, rejected: this.rejected,
      waiting: this.waiting.length, active: this.active.size, utilisation: this.busy.timeAverage(now) / this.node.settings.maxConcurrentRequests,
      waitMsTotal: this.waitMsTotal, details: { ...this.details, connections: this.sessions.size, retained: this.retained?.retained ?? 0,
        expired: this.retained?.expired ?? 0, evicted: this.retained?.evicted ?? 0, cachedEntries: this.cache.size, circuitOpen: now < this.openUntil ? 1 : 0 } };
  }
}
