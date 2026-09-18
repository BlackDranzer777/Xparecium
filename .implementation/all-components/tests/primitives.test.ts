import { describe, expect, it } from 'vitest';
import { EventQueue } from '../src/simulation/event-queue';
import { RingQueue } from '../src/simulation/ring-queue';
import { RandomStreams, Rng } from '../src/simulation/rng';
import { BoundedHistogram, TimeWeightedAccumulator } from '../src/simulation/metrics';

describe('EventQueue', () => {
  it('returns events in timestamp order', () => {
    const q = new EventQueue<string>();
    q.push(30, 'c');
    q.push(10, 'a');
    q.push(20, 'b');
    expect(q.pop()?.payload).toBe('a');
    expect(q.pop()?.payload).toBe('b');
    expect(q.pop()?.payload).toBe('c');
    expect(q.pop()).toBeNull();
  });

  it('breaks ties by insertion order, not by heap position', () => {
    const q = new EventQueue<string>();
    for (const label of ['first', 'second', 'third', 'fourth']) q.push(5, label);
    expect([q.pop()?.payload, q.pop()?.payload, q.pop()?.payload, q.pop()?.payload]).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
  });

  it('keeps ordering under interleaved pushes and pops', () => {
    const q = new EventQueue<number>();
    const times = [7, 3, 9, 1, 8, 2, 5, 4, 6, 0];
    for (const t of times) q.push(t, t);
    const out: number[] = [];
    while (q.size > 0) {
      const e = q.pop()!;
      out.push(e.time);
      if (e.time === 5) q.push(5.5, 5.5);
    }
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9]);
  });
});

describe('RingQueue', () => {
  it('is first in, first out and grows past its initial capacity', () => {
    const q = new RingQueue<number>(2);
    for (let i = 0; i < 100; i += 1) q.push(i);
    expect(q.length).toBe(100);
    const out: number[] = [];
    while (!q.isEmpty) out.push(q.shift()!);
    expect(out[0]).toBe(0);
    expect(out[99]).toBe(99);
    expect(out).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('handles wrap-around after interleaved pushes and shifts', () => {
    const q = new RingQueue<string>(4);
    q.push('a');
    q.push('b');
    expect(q.shift()).toBe('a');
    q.push('c');
    q.push('d');
    q.push('e');
    expect(q.shift()).toBe('b');
    expect(q.shift()).toBe('c');
    expect(q.length).toBe(2);
  });
});

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 20; i += 1) expect(a.next()).toBe(b.next());
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('gives independent streams per name', () => {
    const streams = new RandomStreams(7);
    const first = streams.stream('cache:a').next();
    const second = streams.stream('cache:b').next();
    expect(first).not.toBe(second);
    // Asking again returns the same generator, continuing the sequence.
    expect(streams.stream('cache:a').next()).not.toBe(first);
  });

  it('approximates the requested Bernoulli probability', () => {
    const rng = new Rng(99);
    let hits = 0;
    const trials = 20_000;
    for (let i = 0; i < trials; i += 1) if (rng.bernoulli(0.8)) hits += 1;
    expect(hits / trials).toBeGreaterThan(0.78);
    expect(hits / trials).toBeLessThan(0.82);
  });
});

describe('BoundedHistogram', () => {
  it('brackets the true quantile inside the reported bounds', () => {
    const h = new BoundedHistogram(0.1, 1.15, 120);
    for (let i = 1; i <= 1000; i += 1) h.record(i);
    const p95 = h.quantile(0.95);
    expect(p95.lowerBound).toBeLessThanOrEqual(950);
    expect(p95.upperBound).toBeGreaterThanOrEqual(950);
    expect(p95.sampleCount).toBe(1000);
    expect(p95.relativePrecision).toBeCloseTo(0.15, 10);
  });

  it('reports zero for an empty histogram', () => {
    expect(new BoundedHistogram().quantile(0.95).value).toBe(0);
  });
});

describe('TimeWeightedAccumulator', () => {
  it('averages by time, not by sample count', () => {
    const acc = new TimeWeightedAccumulator(0);
    acc.set(0, 0);
    acc.set(10, 4); // level 4 from t=10 to t=100
    // area = 4 * 90 = 360 over 100 ms => 3.6
    expect(acc.timeAverage(100)).toBeCloseTo(3.6, 10);
    expect(acc.peak).toBe(4);
  });
});
