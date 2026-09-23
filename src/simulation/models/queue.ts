/**
 * The backlog of a message queue.
 *
 * Deliberately not a `StationModel`. A station is "N things in progress at once,
 * each taking about T milliseconds"; a queue holds work that nobody is doing
 * yet, and how much of it there is at the end of the run is the number people
 * draw a queue in order to see. The broker that *accepts* publishes is a
 * station and is modelled as one — this is only the pile of messages waiting.
 *
 * What this models: messages arrive, wait in order, and are taken one at a time
 * by a consumer that has capacity for another. A publish beyond `maxDepth` is
 * refused rather than silently dropped, which is what makes backpressure show
 * up instead of hiding.
 *
 * What this does NOT model: retries, dead-letter queues, acknowledgement
 * timeouts, ordering guarantees across partitions, or more than one consumer.
 */
import { StreamingStat, TimeWeightedAccumulator } from '../metrics';
import { RingQueue } from '../ring-queue';
import type { PubSubNode, QueueNode } from '../../domain/types';
import type { DeadLetterNode, WorkflowNode } from '../../domain/job-services';

export interface PendingMessage {
  /** The request that published it, for the journey trace. */
  publishedBy: number;
  enqueuedAt: number;
  /** Attempts include the first delivery. Older messages default to one. */
  attempts?: number;
  sequence?: number;
  deadLetterAt?: number;
  availableAt?: number;
}

export class QueueModel {
  /** The queue or topic this backlog belongs to. */
  readonly nodeId: string;
  readonly name: string;
  /** Backlogs are keyed by this: the queue's id, or `topic|subscriber`. */
  readonly key: string;
  readonly maxDepth: number;
  readonly messageBytes: number;

  protected readonly backlog = new RingQueue<PendingMessage>();
  readonly depthAcc = new TimeWeightedAccumulator(0);

  enqueued = 0;
  processed = 0;
  failed = 0;
  retries = 0;
  retrying = 0;
  /** Workflow steps only: jobs moving here from the step before, space reserved. */
  arriving = 0;
  refused = 0;
  /** Total time messages spent waiting to be picked up. */
  backlogWaitMsTotal = 0;
  /** Taken by the consumer and not finished: in transit, or being worked on. */
  inFlight = 0;
  /** Published-to-finished time, for messages that were finished. */
  readonly latency = new StreamingStat();

  constructor(node: QueueNode | PubSubNode | DeadLetterNode | WorkflowNode, key: string = node.id, name: string = node.name) {
    this.nodeId = node.id;
    this.name = name;
    this.key = key;
    this.maxDepth = node.settings.maxDepth;
    this.messageBytes = node.settings.messageBytes;
  }

  get depth(): number {
    return this.backlog.length;
  }

  get hasRoom(): boolean {
    return this.backlog.length + this.retrying + this.arriving < this.maxDepth;
  }

  /** Accepts the message, or returns false when the queue is full. */
  push(message: PendingMessage, now: number): boolean {
    if (!this.hasRoom) {
      this.refused += 1;
      return false;
    }
    this.backlog.push(message);
    this.enqueued += 1;
    this.depthAcc.set(now, this.backlog.length);
    return true;
  }

  /** Hands the oldest message to a consumer that has room for it. */
  take(now: number): PendingMessage | undefined {
    const message = this.backlog.shift();
    if (!message) return undefined;
    this.depthAcc.set(now, this.backlog.length);
    this.backlogWaitMsTotal += now - (message.availableAt ?? message.enqueuedAt);
    this.inFlight += 1;
    return message;
  }

  fail(_message?: PendingMessage): void {
    this.failed++;
    this.inFlight--;
  }

  /** Reserve bounded waiting space before scheduling a delayed retry. */
  reserveRetry(): boolean {
    if (!this.hasRoom) return false;
    this.inFlight--;
    this.retrying++;
    this.retries++;
    return true;
  }

  restoreRetry(message: PendingMessage, now: number): void {
    if (this.retrying <= 0) throw new Error('Retry has no reserved queue space.');
    this.retrying--;
    this.backlog.push({ ...message, availableAt: now });
    this.depthAcc.set(now, this.backlog.length);
  }

  /**
   * Reserve room for a job arriving from a workflow's previous step, which
   * spends a moment saving its state before it gets here. A step with no room
   * refuses it, and the workflow fails there rather than waiting unbounded.
   */
  reserveArrival(): boolean {
    if (!this.hasRoom) {
      this.refused += 1;
      return false;
    }
    this.arriving += 1;
    return true;
  }

  restoreArrival(message: PendingMessage, now: number): void {
    if (this.arriving <= 0) throw new Error('An arriving step has no reserved space.');
    this.arriving -= 1;
    this.backlog.push({ ...message, availableAt: now });
    this.enqueued += 1;
    this.depthAcc.set(now, this.backlog.length);
  }

  finish(publishedAt: number, now: number, _message?: PendingMessage): void {
    this.processed += 1;
    this.inFlight -= 1;
    this.latency.record(now - publishedAt);
  }

  /**
   * Everything still outstanding when the run ended: waiting in the queue plus
   * being worked on. This is the figure that says whether the consumer was
   * keeping up.
   */
  get outstanding(): number {
    return this.backlog.length + this.inFlight + this.retrying + this.arriving;
  }
}
