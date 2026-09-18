import { describe, expect, it } from 'vitest';
import { RetainedLog } from '../src/simulation/models/retained-log';

describe('retained event log', () => {
  it('consumers progress independently and acknowledgements retain the history', () => {
    const log = new RetainedLog(2, 10, 1000);
    log.addGroup('email'); log.addGroup('analytics');
    for (let i = 0; i < 4; i++) log.append(i, i);
    const first = log.take('email', 10)!;
    expect(log.take('analytics', 10)!.sequence).toBe(first.sequence);
    expect(log.settle('email', first.sequence, true)).toBe(true);
    expect(log.retained).toBe(4);
    expect(log.groupSnapshot('email')!.processed).toBe(1);
    expect(log.groupSnapshot('analytics')!.processed).toBe(0);
  });
  it('does not pass an in-flight record within the same partition', () => {
    const log = new RetainedLog(1, 10, 1000);
    log.addGroup('worker'); log.append(1, 0); log.append(2, 0);
    const one = log.take('worker', 0)!;
    expect(log.take('worker', 0)).toBeUndefined();
    log.settle('worker', one.sequence, true);
    expect(log.take('worker', 0)!.sequence).toBe(one.sequence + 1);
  });
  it('allows independent partitions to be in flight together', () => {
    const log = new RetainedLog(2, 10, 1000);
    log.addGroup('worker'); log.append(1, 0); log.append(2, 0);
    expect(log.take('worker', 0)!.partition).toBe(0);
    expect(log.take('worker', 0)!.partition).toBe(1);
    expect(log.groupSnapshot('worker')!.inFlight).toBe(2);
  });
  it('retention can overtake a slow reader and reports the missed records', () => {
    const log = new RetainedLog(1, 10, 100);
    log.addGroup('late'); log.append(1, 0); log.append(2, 80);
    const next = log.take('late', 100)!;
    expect(next.publishedBy).toBe(2);
    expect(log.expired).toBe(1);
    expect(log.groupSnapshot('late')!.missed).toBe(1);
  });
  it('capacity eviction stays bounded and does not count active work as missed', () => {
    const log = new RetainedLog(1, 2, 1000);
    log.addGroup('worker'); log.append(1, 0);
    const active = log.take('worker', 0)!;
    log.append(2, 0); log.append(3, 0); log.append(4, 0);
    expect(log.retained).toBe(2);
    expect(log.evicted).toBe(2);
    expect(log.groupSnapshot('worker')!.missed).toBe(1);
    expect(log.settle('worker', active.sequence, true)).toBe(true);
    expect(log.take('worker', 0)!.publishedBy).toBe(3);
  });
  it('can replay retained events after finishing active work', () => {
    const log = new RetainedLog(1, 10, 1000);
    log.addGroup('worker'); log.append(7, 0);
    const first = log.take('worker', 0)!;
    expect(log.rewind('worker')).toBe(false);
    log.settle('worker', first.sequence, true);
    expect(log.rewind('worker')).toBe(true);
    expect(log.take('worker', 0)!.publishedBy).toBe(7);
  });
  it('a latest-start group skips existing history and reads new events', () => {
    const log = new RetainedLog(2, 10, 1000);
    log.append(1, 0); log.addGroup('new', 'latest');
    expect(log.take('new', 0)).toBeUndefined();
    log.append(2, 1);
    expect(log.take('new', 1)!.publishedBy).toBe(2);
  });
  it('snapshots are independent and settling twice cannot change counters twice', () => {
    const log = new RetainedLog(1, 10, 1000);
    log.addGroup('worker'); log.append(1, 0);
    const before = log.groupSnapshot('worker')!;
    const record = log.take('worker', 0)!;
    expect(log.settle('worker', record.sequence, false)).toBe(true);
    expect(log.settle('worker', record.sequence, false)).toBe(false);
    expect(before).toMatchObject({ unread: 1, inFlight: 0, failed: 0, nextOffsets: [0] });
    expect(log.groupSnapshot('worker')!.failed).toBe(1);
  });
});
