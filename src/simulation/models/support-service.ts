import type { SupportNode } from '../../domain/support-services';
import type { ChainServiceNode } from '../../domain/chain-services';

/** Every node this model drives: the shared services, and four chain pieces. */
export type ServiceNode = SupportNode | ChainServiceNode;
import { RingQueue } from '../ring-queue';
import { StreamingStat, TimeWeightedAccumulator } from '../metrics';
import type { Rng, RandomStreams } from '../rng';
import { RetainedLog } from './retained-log';

export interface SupportJob { id: number; caller: string; actor: string; queuedAt: number; attempts: number; blocked?: string }

/**
 * A lock's own bookkeeping, kept apart from the service's slots. A slot is
 * the lock service's work — granting or releasing — and is busy for a couple
 * of milliseconds. Holding a lock takes no slot: the service is idle while a
 * request holds one, and every other request that wants the same lock waits
 * in that lock's own line, not in the service's.
 */
interface LockWaiter { job: SupportJob; since: number; timeoutAt: number; cancelled: boolean }
interface HeldLock { job: SupportJob; key: number; until: number }
export interface SupportMetrics {
  nodeId: string; name: string; kind: ServiceNode['kind'] | 'oracle'; accepted: number; completed: number; rejected: number;
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
  protected readonly random: Rng;
  private readonly retained: RetainedLog | null;
  private tokens: number;
  private refilledAt = 0;
  // Distributed lock only: who holds each lock, who waits for it, and a stream
  // for which requests need one and which lock they need.
  private readonly holders = new Map<number, HeldLock>();
  private readonly held = new Map<number, number>();
  private readonly lockLines = new Map<number, LockWaiter[]>();
  private readonly lockWaiting = new Map<number, LockWaiter>();
  private readonly lockStream: Rng;
  readonly heldAcc = new TimeWeightedAccumulator(0);
  // Indexer only: when the indexer will have caught up, and how far behind
  // the chain it has been.
  private indexedUntil = 0;
  /** How far behind the chain the indexer was, as each block arrived. */
  readonly lagAtBlocks = new StreamingStat();
  // Decentralised storage only: whether the operation in a slot is an upload.
  private readonly uploads = new Set<number>();
  private nextProviderAt = 0;
  private failures = 0;
  private openUntil = 0;
  accepted = 0; completed = 0; rejected = 0; waitMsTotal = 0;
  readonly details: Record<string, number> = { attempts: 0, retries: 0, cacheHits: 0, cacheMisses: 0, stale: 0,
    denied: 0, unavailable: 0, throttled: 0, connectionsOpened: 0, connectionsRefused: 0, connectionsPeak: 0, heartbeats: 0, circuitRefused: 0, deliveryFailed: 0, sampled: 0,
    grants: 0, lockWaits: 0, lockTimeouts: 0, lockWaitMsTotal: 0, lockSkipped: 0, lockWaitingPeak: 0,
    signed: 0, passedThrough: 0, walletRefused: 0, blocksIndexed: 0, lagPeakMs: 0, gatewayHits: 0, networkFetches: 0, uploads: 0 };
  constructor(readonly node: ServiceNode, streams: RandomStreams) {
    this.random = streams.stream(`support:${node.id}`);
    this.lockStream = streams.stream(`lock:${node.id}`);
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
  /**
   * Whether this request goes straight past a lock it does not need. Only
   * the lock can be skipped: a request that does not touch the protected
   * thing never asks for it, and pays nothing.
   */
  skips(): boolean {
    if (this.node.kind !== 'lock') return false;
    if (this.lockStream.bernoulli(this.node.settings.lockShare)) return false;
    this.details.lockSkipped!++;
    return true;
  }
  shouldSample(): boolean {
    const sample = this.node.kind !== 'monitoring' || this.random.bernoulli(this.node.settings.sampleShare);
    if (sample) this.details.sampled!++;
    return sample;
  }
  /**
   * How many operations at once, and how many may wait. A wallet has neither:
   * every person signs in their own, so nobody waits for anybody else.
   */
  get slots(): number {
    return 'maxConcurrentRequests' in this.node.settings ? this.node.settings.maxConcurrentRequests : Number.POSITIVE_INFINITY;
  }
  get lineLimit(): number {
    return 'queueLimit' in this.node.settings ? this.node.settings.queueLimit : 0;
  }
  /**
   * Whether this request is a transaction — something that changes the chain
   * and must be signed — rather than a read. Decided once per request, by the
   * first chain piece that asks; see the engine's `chainTx`.
   */
  decideTx(): boolean {
    return this.node.kind === 'wallet' ? this.random.bernoulli(this.node.settings.transactionShare) : false;
  }
  admit(job: SupportJob, now: number, start: SupportStart): boolean {
    if (this.active.size >= this.slots && this.waiting.length >= this.lineLimit) { this.rejected++; return false; }
    this.accepted++;
    if (this.active.size < this.slots) this.start(job, now, start);
    else this.waiting.push(job);
    return true;
  }
  protected start(job: SupportJob, now: number, start: SupportStart): void {
    this.active.set(job.id, job); this.busy.set(now, this.active.size);
    const waited = now - job.queuedAt; this.waitMsTotal += waited;
    let ms = this.node.settings.serviceTimeMs;
    if (this.node.kind === 'ipfs') {
      // An upload is pinned; a read is quick from a gateway's cache and slow
      // when the file has to be found on the network first.
      const s = this.node.settings;
      if (this.random.bernoulli(s.writeShare)) { this.uploads.add(job.id); this.details.uploads!++; ms += s.uploadMs; }
      else if (this.random.bernoulli(s.gatewayHitShare)) this.details.gatewayHits!++;
      else { this.details.networkFetches!++; ms += s.retrievalMs; }
    }
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
    if (this.node.kind === 'lock') return this.finishLock(id, now, start);
    const job = this.active.get(id); if (!job) return null;
    const n = this.node;
    let failure: string | null = job.blocked ?? null;
    if (!failure && n.kind === 'wallet') {
      if (this.random.bernoulli(n.settings.rejectShare)) { failure = 'wallet-rejected'; this.details.walletRefused!++; }
      else this.details.signed!++;
    }
    this.uploads.delete(id);
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
  /**
   * One event for a lock is one of three things, told apart by where the
   * request is: its grant request has been processed (it was in a slot), its
   * hold is over (it holds a lock), or it has waited as long as it will (it is
   * in a lock's line). A timeout that arrives after the request was granted,
   * or a hold end for a request long gone, finds nothing to do.
   */
  private finishLock(id: number, now: number, start: SupportStart): { job: SupportJob; failure: string | null } | null {
    const n = this.node;
    if (n.kind !== 'lock') return null;
    const inSlot = this.active.get(id);
    if (inSlot) {
      // The service has processed the request for the lock; its slot is free.
      this.active.delete(id); this.busy.set(now, this.active.size);
      const next = this.waiting.shift(); if (next) this.start(next, now, start);
      const key = n.settings.lockKeys > 1 ? Math.floor(this.lockStream.next() * n.settings.lockKeys) : 0;
      if (!this.held.has(key)) { this.grant(inSlot, key, now, 0, start); return null; }
      const waiter: LockWaiter = { job: inSlot, since: now, timeoutAt: now + n.settings.waitTimeoutMs, cancelled: false };
      const line = this.lockLines.get(key) ?? [];
      line.push(waiter); this.lockLines.set(key, line);
      this.lockWaiting.set(id, waiter);
      this.details.lockWaits!++;
      this.details.lockWaitingPeak = Math.max(this.details.lockWaitingPeak!, this.lockWaiting.size);
      start(id, n.settings.waitTimeoutMs, 0);
      return null;
    }
    const holding = this.holders.get(id);
    if (holding) {
      if (now < holding.until) return null; // a timeout that fired while it held the lock
      this.holders.delete(id); this.held.delete(holding.key); this.heldAcc.set(now, this.held.size);
      this.completed++;
      const line = this.lockLines.get(holding.key) ?? [];
      while (line.length > 0) {
        const waiter = line.shift()!;
        if (waiter.cancelled) continue;
        this.lockWaiting.delete(waiter.job.id);
        this.grant(waiter.job, holding.key, now, now - waiter.since, start);
        break;
      }
      return { job: holding.job, failure: null };
    }
    const waiter = this.lockWaiting.get(id);
    if (waiter && now >= waiter.timeoutAt) {
      waiter.cancelled = true;
      this.lockWaiting.delete(id);
      this.details.lockTimeouts!++;
      this.details.lockWaitMsTotal! += now - waiter.since;
      this.rejected++;
      return { job: waiter.job, failure: 'lock-timeout' };
    }
    return null;
  }

  /**
   * Indexer only: a block arrived with this many of the app's transactions.
   * Indexing is sequential — block after block — so when the chain produces
   * work faster than the indexer gets through it, it falls behind, and a
   * query answered now describes the chain as it was that long ago.
   */
  indexBlock(now: number, transactions: number): void {
    if (this.node.kind !== 'indexer') return;
    const s = this.node.settings;
    this.indexedUntil = Math.max(now, this.indexedUntil) + s.blockOverheadMs + transactions * s.indexMsPerTx;
    const lag = this.indexedUntil - now;
    this.lagAtBlocks.record(lag);
    this.details.blocksIndexed!++;
    this.details.lagPeakMs = Math.max(this.details.lagPeakMs!, lag);
  }

  private grant(job: SupportJob, key: number, now: number, waited: number, start: SupportStart): void {
    const n = this.node;
    if (n.kind !== 'lock') return;
    const until = now + n.settings.holdMs;
    this.holders.set(job.id, { job, key, until });
    this.held.set(key, job.id); this.heldAcc.set(now, this.held.size);
    this.details.grants!++;
    this.details.lockWaitMsTotal! += waited;
    start(job.id, n.settings.holdMs, waited);
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
      waiting: this.waiting.length, active: this.active.size, utilisation: Number.isFinite(this.slots) ? this.busy.timeAverage(now) / this.slots : 0,
      waitMsTotal: this.waitMsTotal, details: { ...this.details, connections: this.sessions.size, retained: this.retained?.retained ?? 0,
        expired: this.retained?.expired ?? 0, evicted: this.retained?.evicted ?? 0, cachedEntries: this.cache.size, circuitOpen: now < this.openUntil ? 1 : 0,
        lockWaiting: this.lockWaiting.size, locksHeldAverage: this.heldAcc.timeAverage(now),
        lagAverageMs: this.lagAtBlocks.mean } };
  }
}
