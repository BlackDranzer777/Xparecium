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
import type { ChainNodeOf } from '../../domain/chain-services';

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

/**
 * A hosted RPC node as the same model. It processes a request in a CPU slot;
 * a request waiting for its transaction's block does not hold one of the
 * node's own limits — the person's client polls for the receipt — so
 * concurrency is not what bounds a node. Its plan's rate is, and that is
 * checked before admission, like a gateway's.
 */
export function shapeOfRpcNode(node: ChainNodeOf<'rpcNode'>): ComputeShape {
  const s = node.settings;
  return {
    cpuSlots: s.maxConcurrentRequests,
    ramMb: Number.MAX_SAFE_INTEGER,
    cpuMsPerRequest: s.requestMs,
    concurrencyLimit: Number.MAX_SAFE_INTEGER,
    baselineMemoryMb: 0,
    memoryPerRequestMb: 0,
    memoryPerQueuedRequestMb: 0,
    queueLimit: 0,
  };
}

export interface WaitingRequest {
  requestId: number;
  queuedAt: number;
}

/** An auto-scaled group's policy, in milliseconds. */
export interface ScalingPolicy {
  min: number;
  max: number;
  target: number;
  warmupMs: number;
  checkMs: number;
}

export class ServerModel {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: 'server' | 'serverless' | 'rpcNode';
  readonly cpuMsPerRequest: number;
  readonly memoryPerRequestMb: number;
  readonly memoryPerQueuedRequestMb: number;
  // One instance's resources. A server that is not auto-scaled is one
  // instance, so these are its whole capacity, exactly as before.
  private readonly perInstance: { cpuSlots: number; ramMb: number; concurrencyLimit: number; baselineMemoryMb: number; queueLimit: number };
  /** Null unless the server is auto-scaled. */
  readonly scaling: ScalingPolicy | null;
  /** Instances serving requests. */
  instances = 1;
  /** Instances started and still warming up: billed, not yet serving. */
  pending = 0;
  scaleOuts = 0;
  scaleIns = 0;
  /** Serving capacity over time, so CPU use is a share of what existed. */
  readonly slotsAcc = new TimeWeightedAccumulator(0);
  /** Billed instances over time — serving plus warming up. */
  readonly billedAcc = new TimeWeightedAccumulator(0);
  /** CPU and slot areas at the last scaling check. */
  lastCheck = { busyArea: 0, slotArea: 0 };

  get cpuSlots(): number { return this.perInstance.cpuSlots * this.instances; }
  get ramMb(): number { return this.perInstance.ramMb * this.instances; }
  get concurrencyLimit(): number { return this.perInstance.concurrencyLimit * this.instances; }
  get baselineMemoryMb(): number { return this.perInstance.baselineMemoryMb * this.instances; }
  get queueLimit(): number { return this.perInstance.queueLimit * this.instances; }

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

  constructor(node: ServerNode | ServerlessNode | ChainNodeOf<'rpcNode'>) {
    const s = node.kind === 'serverless' ? shapeOfFunction(node) : node.kind === 'rpcNode' ? shapeOfRpcNode(node) : node.settings;
    this.nodeId = node.id;
    this.name = node.name;
    this.kind = node.kind;
    this.perInstance = { cpuSlots: s.cpuSlots, ramMb: s.ramMb, concurrencyLimit: s.concurrencyLimit,
      baselineMemoryMb: s.baselineMemoryMb, queueLimit: s.queueLimit };
    this.cpuMsPerRequest = s.cpuMsPerRequest;
    this.memoryPerRequestMb = s.memoryPerRequestMb;
    this.memoryPerQueuedRequestMb = s.memoryPerQueuedRequestMb;
    const settings = node.kind === 'server' ? node.settings : null;
    this.scaling = settings?.autoscaleEnabled
      ? { min: settings.minInstances, max: Math.max(settings.minInstances, settings.maxInstances),
          target: settings.targetCpuShare, warmupMs: settings.instanceWarmupSeconds * 1000,
          checkMs: settings.scaleCheckSeconds * 1000 }
      : null;
    this.instances = this.scaling ? this.scaling.min : 1;
    this.slotsAcc.set(0, this.cpuSlots);
    this.billedAcc.set(0, this.instances);
    this.memoryAcc.set(0, this.baselineMemoryMb);
  }

  /**
   * Change how many instances serve. Requests already running keep going on
   * the capacity they had; only new admissions and CPU starts see the change.
   */
  setInstances(count: number, now: number): void {
    this.instances = count;
    this.slotsAcc.set(now, this.cpuSlots);
    this.billedAcc.set(now, this.instances + this.pending);
    this.syncMemory(now);
  }

  /** An instance has been started; it bills from now and serves after warming up. */
  startInstance(now: number): void {
    this.pending += 1;
    this.scaleOuts += 1;
    this.billedAcc.set(now, this.instances + this.pending);
  }

  /** A started instance has warmed up and takes requests. */
  instanceReady(now: number): void {
    this.pending -= 1;
    this.setInstances(this.instances + 1, now);
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
