/**
 * The application server.
 *
 * Three resources are tracked separately, because conflating them is exactly
 * the mistake this simulator exists to expose:
 *
 *   1. CPU slots      - how many requests can *compute* at the same instant.
 *   2. Concurrency    - how many requests the application holds open at once,
 *                       including those that are only waiting on a database.
 *   3. Memory         - a budget in megabytes, charged per admitted request
 *                       and (at a smaller, explicit rate) per queued request.
 *
 * A request that is waiting for the database gives its CPU slot back but keeps
 * its concurrency slot and its memory. That is why adding RAM to a CPU-bound
 * server changes nothing, and why adding CPU slots does.
 *
 * "CPU slots" is an explicit simplification of usable compute capacity. It is
 * not a core count, a thread count or a cgroup quota.
 */
import { TimeWeightedAccumulator } from '../metrics';
import { RingQueue } from '../ring-queue';
import type { ServerNode, ServerlessNode } from '../../domain/types';

/** How a compute node is configured for the model, whichever kind it is. */
export interface ComputeShape {
  cpuSlots: number;
  ramMb: number;
  cpuMsPerRequest: number;
  concurrencyLimit: number;
  baselineMemoryMb: number;
  memoryPerRequestMb: number;
  memoryPerQueuedRequestMb: number;
  queueLimit: number;
}

/**
 * A serverless function as the same three-resource model, with the knobs a
 * platform sets for you: every invocation computes at once (a slot each, up
 * to the concurrency limit), memory is what you allotted per invocation, and
 * nothing ever waits in line — over the limit is refused, not queued.
 */
export function shapeOfFunction(node: ServerlessNode): ComputeShape {
  const s = node.settings;
  return {
    cpuSlots: s.maxConcurrentInvocations,
    ramMb: Number.MAX_SAFE_INTEGER,
    cpuMsPerRequest: s.cpuMsPerRequest,
    concurrencyLimit: s.maxConcurrentInvocations,
    baselineMemoryMb: 0,
    memoryPerRequestMb: s.memoryMb,
    memoryPerQueuedRequestMb: 0,
    queueLimit: 0,
  };
}

export interface WaitingRequest {
  requestId: number;
  queuedAt: number;
}

export class ServerModel {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: 'server' | 'serverless';
  readonly cpuSlots: number;
  readonly ramMb: number;
  readonly cpuMsPerRequest: number;
  readonly concurrencyLimit: number;
  readonly baselineMemoryMb: number;
  readonly memoryPerRequestMb: number;
  readonly memoryPerQueuedRequestMb: number;
  readonly queueLimit: number;

  cpuBusy = 0;
  admittedCount = 0;
  readonly cpuQueue = new RingQueue<WaitingRequest>();
  readonly admissionQueue = new RingQueue<WaitingRequest>();

  readonly cpuBusyAcc = new TimeWeightedAccumulator(0);
  readonly concurrencyAcc = new TimeWeightedAccumulator(0);
  readonly admissionQueueAcc = new TimeWeightedAccumulator(0);
  readonly cpuQueueAcc = new TimeWeightedAccumulator(0);
  readonly memoryAcc = new TimeWeightedAccumulator(0);

  admitted = 0;
  completed = 0;
  rejected = 0;
  cpuServiceMsTotal = 0;
  admissionWaitMsTotal = 0;
  cpuWaitMsTotal = 0;
  // Serverless only: invocations that paid a cold start, invocations refused
  // over the concurrency limit, and the wall-clock time invocations were
  // alive — which is what the provider bills, waiting included.
  coldStarts = 0;
  throttled = 0;
  busyMsTotal = 0;

  constructor(node: ServerNode | ServerlessNode) {
    const s = node.kind === 'serverless' ? shapeOfFunction(node) : node.settings;
    this.nodeId = node.id;
    this.name = node.name;
    this.kind = node.kind;
    this.cpuSlots = s.cpuSlots;
    this.ramMb = s.ramMb;
    this.cpuMsPerRequest = s.cpuMsPerRequest;
    this.concurrencyLimit = s.concurrencyLimit;
    this.baselineMemoryMb = s.baselineMemoryMb;
    this.memoryPerRequestMb = s.memoryPerRequestMb;
    this.memoryPerQueuedRequestMb = s.memoryPerQueuedRequestMb;
    this.queueLimit = s.queueLimit;
    this.memoryAcc.set(0, this.baselineMemoryMb);
  }

  /** Memory in use right now, given a hypothetical extra admitted/queued request. */
  memoryFor(extraAdmitted: number, extraQueued: number): number {
    return (
      this.baselineMemoryMb +
      (this.admittedCount + extraAdmitted) * this.memoryPerRequestMb +
      (this.admissionQueue.length + extraQueued) * this.memoryPerQueuedRequestMb
    );
  }

  get memoryUsedMb(): number {
    return this.memoryFor(0, 0);
  }

  syncMemory(now: number): void {
    this.memoryAcc.set(now, this.memoryUsedMb);
  }

  canAdmitNow(): boolean {
    return (
      this.admittedCount < this.concurrencyLimit && this.memoryFor(1, 0) <= this.ramMb
    );
  }

  canQueueNow(): boolean {
    return this.admissionQueue.length < this.queueLimit && this.memoryFor(0, 1) <= this.ramMb;
  }

  /**
   * Whether the request at the head of the waiting queue can be promoted.
   * The memory check counts the request as admitted and no longer queued,
   * which is why it uses (+1 admitted, -1 queued).
   */
  canPromoteFromQueue(): boolean {
    if (this.admissionQueue.length === 0) return false;
    if (this.admittedCount >= this.concurrencyLimit) return false;
    return this.memoryFor(1, -1) <= this.ramMb;
  }

  admit(now: number): void {
    this.admittedCount += 1;
    this.admitted += 1;
    this.concurrencyAcc.set(now, this.admittedCount);
    this.syncMemory(now);
  }

  releaseAdmission(now: number): void {
    this.admittedCount -= 1;
    this.concurrencyAcc.set(now, this.admittedCount);
    this.syncMemory(now);
  }

  queueForAdmission(requestId: number, now: number): void {
    this.admissionQueue.push({ requestId, queuedAt: now });
    this.admissionQueueAcc.set(now, this.admissionQueue.length);
    this.syncMemory(now);
  }

  dequeueForAdmission(now: number): WaitingRequest | undefined {
    const item = this.admissionQueue.shift();
    if (!item) return undefined;
    this.admissionQueueAcc.set(now, this.admissionQueue.length);
    this.admissionWaitMsTotal += now - item.queuedAt;
    return item;
  }

  get hasFreeCpu(): boolean {
    return this.cpuBusy < this.cpuSlots;
  }

  occupyCpu(now: number, serviceMs: number): void {
    this.cpuBusy += 1;
    this.cpuBusyAcc.set(now, this.cpuBusy);
    this.cpuServiceMsTotal += serviceMs;
  }

  releaseCpu(now: number): void {
    this.cpuBusy -= 1;
    this.cpuBusyAcc.set(now, this.cpuBusy);
  }

  queueForCpu(requestId: number, now: number): void {
    this.cpuQueue.push({ requestId, queuedAt: now });
    this.cpuQueueAcc.set(now, this.cpuQueue.length);
  }

  dequeueForCpu(now: number): WaitingRequest | undefined {
    const item = this.cpuQueue.shift();
    if (!item) return undefined;
    this.cpuQueueAcc.set(now, this.cpuQueue.length);
    this.cpuWaitMsTotal += now - item.queuedAt;
    return item;
  }
}
