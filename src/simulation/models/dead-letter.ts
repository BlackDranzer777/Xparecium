import type { DeadLetterNode } from '../../domain/job-services';
import { QueueModel } from './queue';
import type { PendingMessage } from './queue';

/** Holding a failed job is separate from deciding when to replay it. */
export class DeadLetterModel extends QueueModel {
  expired = 0;
  constructor(readonly node: DeadLetterNode) { super(node); }
  override push(message: PendingMessage, now: number): boolean {
    this.expire(now);
    return super.push({ ...message, deadLetterAt: now }, now);
  }
  override take(now: number): PendingMessage | undefined {
    this.expire(now);
    const first = this.backlog.peek();
    if (!this.node.settings.replayEnabled || !first || (first.deadLetterAt ?? first.enqueuedAt) + this.node.settings.replayDelaySeconds * 1000 > now) return undefined;
    return super.take(now);
  }
  expire(now: number): void {
    while (this.backlog.peek() && (this.backlog.peek()!.deadLetterAt ?? this.backlog.peek()!.enqueuedAt) + this.node.settings.retentionSeconds * 1000 <= now) {
      this.backlog.shift(); this.expired++;
    }
    this.depthAcc.set(now, this.backlog.length);
  }
  get nextExpiryAt(): number | null {
    const first = this.backlog.peek();
    return first ? (first.deadLetterAt ?? first.enqueuedAt) + this.node.settings.retentionSeconds * 1000 : null;
  }
}
