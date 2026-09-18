import type { EventStreamNode } from '../../domain/job-services';
import { StreamingStat, TimeWeightedAccumulator } from '../metrics';
import type { PendingMessage } from './queue';
import { RetainedLog } from './retained-log';

/** Gives the existing worker dispatcher a consumer group's view of a shared log. */
export class StreamBacklog {
  readonly nodeId: string;
  readonly name: string;
  readonly maxDepth: number;
  readonly messageBytes: number;
  readonly depthAcc = new TimeWeightedAccumulator(0);
  readonly latency = new StreamingStat();
  readonly startAt: number;
  backlogWaitMsTotal = 0;
  private active = false;
  private initialPublished = 0;
  constructor(readonly node: EventStreamNode, readonly key: string, readonly log: RetainedLog) {
    this.nodeId = node.id; this.name = node.name; this.maxDepth = node.settings.maxDepth;
    this.messageBytes = node.settings.messageBytes;
    this.startAt = node.settings.consumerStartSeconds * 1000;
  }
  activate(now: number): boolean {
    if (now < this.startAt) return false;
    if (!this.active) {
      this.log.expire(now);
      this.log.addGroup(this.key, this.node.settings.startPosition);
      this.initialPublished = this.node.settings.startPosition === 'latest' ? this.log.published : this.log.published - this.log.retained;
      this.active = true;
      this.changed(now);
    }
    return true;
  }
  private get state() { return this.log.groupSnapshot(this.key); }
  get depth(): number { return this.state?.unread ?? 0; }
  get inFlight(): number { return this.state?.inFlight ?? 0; }
  get processed(): number { return this.state?.processed ?? 0; }
  get failed(): number { return this.state?.failed ?? 0; }
  get refused(): number { return this.state?.missed ?? 0; }
  get enqueued(): number { return this.active ? this.log.published - this.initialPublished : 0; }
  get hasRoom(): boolean { return true; }
  get outstanding(): number { return this.depth + this.inFlight; }
  changed(now: number): void { this.depthAcc.set(now, this.depth); }
  /** Appending belongs to the shared log, never to a single group. */
  push(_message: PendingMessage, _now: number): boolean { throw new Error('Publish to the shared event log.'); }
  take(now: number): PendingMessage | undefined {
    if (!this.activate(now)) return undefined;
    const record = this.log.take(this.key, now);
    if (record) this.backlogWaitMsTotal += now - record.enqueuedAt;
    this.changed(now);
    return record;
  }
  finish(publishedAt: number, now: number, message?: PendingMessage): void {
    if (message?.sequence !== undefined && this.log.settle(this.key, message.sequence, true)) this.latency.record(now - publishedAt);
    this.changed(now);
  }
  fail(message?: PendingMessage): void {
    if (message?.sequence !== undefined) this.log.settle(this.key, message.sequence, false);
  }
}
