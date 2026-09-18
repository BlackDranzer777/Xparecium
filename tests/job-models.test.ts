import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_STREAM, DEFAULT_DEAD_LETTER } from '../src/domain/job-services';
import type { EventStreamNode, DeadLetterNode } from '../src/domain/job-services';
import type { QueueNode } from '../src/domain/types';
import { QueueModel } from '../src/simulation/models/queue';
import { StreamBacklog } from '../src/simulation/models/stream-backlog';
import { RetainedLog } from '../src/simulation/models/retained-log';
import { DeadLetterModel } from '../src/simulation/models/dead-letter';
import { queue } from './helpers';

const base = { id: 'jobs', name: 'Jobs', position: { x: 0, y: 0 }, cloud: { profileId: null } };

describe('job buffers', () => {
  it('reserves queue capacity for backoff and does not count retries as new publishes', () => {
    const model = new QueueModel(queue('q', { maxDepth: 1 }) as QueueNode);
    model.push({ publishedBy: 1, enqueuedAt: 0 }, 0);
    const message = model.take(10)!;
    expect(model.reserveRetry()).toBe(true);
    expect(model.outstanding).toBe(1);
    expect(model.push({ publishedBy: 2, enqueuedAt: 20 }, 20)).toBe(false);
    model.restoreRetry({ ...message, attempts: 2 }, 100);
    const retried = model.take(110)!;
    expect(retried.attempts).toBe(2);
    expect(model.backlogWaitMsTotal).toBe(20);
    model.finish(retried.enqueuedAt, 120);
    expect(model.enqueued).toBe(1);
    expect(model.retries).toBe(1);
    expect(model.processed).toBe(1);
    expect(model.outstanding).toBe(0);
    expect(model.latency.mean).toBe(120);
  });
  it('cannot exceed capacity when a new publish filled the space before a failure', () => {
    const model = new QueueModel(queue('q', { maxDepth: 1 }) as QueueNode);
    model.push({ publishedBy: 1, enqueuedAt: 0 }, 0); model.take(0);
    model.push({ publishedBy: 2, enqueuedAt: 1 }, 1);
    expect(model.reserveRetry()).toBe(false);
    model.fail();
    expect(model.failed).toBe(1);
    expect(model.outstanding).toBe(1);
  });
  it('a dead-letter queue holds jobs until replay is enabled and its delay elapsed', () => {
    const node: DeadLetterNode = { ...base, kind: 'deadLetter', settings: { ...DEFAULT_DEAD_LETTER, replayDelaySeconds: 1 } };
    const model = new DeadLetterModel(node);
    model.push({ publishedBy: 5, enqueuedAt: 0, attempts: 3 }, 100);
    expect(model.take(1200)).toBeUndefined();
    node.settings.replayEnabled = true;
    expect(model.take(1000)).toBeUndefined();
    expect(model.take(1200)!.attempts).toBe(3);
    expect(model.inFlight).toBe(1);
  });
  it('dead-letter retention begins when the failed job arrives, rather than its original publish time', () => {
    const node: DeadLetterNode = { ...base, kind: 'deadLetter', settings: { ...DEFAULT_DEAD_LETTER, retentionSeconds: 1 } };
    const model = new DeadLetterModel(node);
    model.push({ publishedBy: 5, enqueuedAt: 0 }, 10000);
    model.expire(10500);
    expect(model.depth).toBe(1);
    model.expire(11000);
    expect(model.depth).toBe(0);
    expect(model.expired).toBe(1);
  });
  it('a delayed stream reader starts at the configured position', () => {
    const node: EventStreamNode = { ...base, kind: 'eventStream', settings: { ...DEFAULT_EVENT_STREAM, consumerStartSeconds: 1, startPosition: 'latest' } };
    const log = new RetainedLog(4, 10, 10000);
    const backlog = new StreamBacklog(node, 'group', log);
    log.append(1, 0);
    expect(backlog.activate(999)).toBe(false);
    expect(backlog.activate(1000)).toBe(true);
    expect(backlog.take(1000)).toBeUndefined();
    log.append(2, 1001);
    const message = backlog.take(1010)!;
    expect(message.publishedBy).toBe(2);
    backlog.finish(message.enqueuedAt, 1020, message);
    expect(backlog.processed).toBe(1);
    expect(backlog.enqueued).toBe(1);
    expect(backlog.outstanding).toBe(0);
    expect(log.retained).toBe(2);
  });
  it('stream workers release failed partitions and report expired unread records', () => {
    const node: EventStreamNode = { ...base, kind: 'eventStream', settings: { ...DEFAULT_EVENT_STREAM } };
    const log = new RetainedLog(1, 10, 100);
    const backlog = new StreamBacklog(node, 'group', log);
    backlog.activate(0);
    log.append(1, 0); log.append(2, 1);
    const message = backlog.take(2)!;
    backlog.fail(message);
    log.expire(101);
    expect(backlog.failed).toBe(1);
    expect(backlog.refused).toBe(1);
    expect(backlog.outstanding).toBe(0);
    expect(backlog.enqueued).toBe(2);
  });
});
