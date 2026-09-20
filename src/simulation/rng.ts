/**
 * Seeded pseudorandom numbers.
 *
 * Two rules make runs reproducible:
 *   1. Never touch Math.random anywhere in the engine.
 *   2. Give every independent source of randomness its own stream, so that
 *      adding a component (or changing how often one of them draws a number)
 *      cannot shift the numbers another component sees.
 *
 * Streams are derived from the run seed plus a stable name, so the stream for
 * "cache:cache_1" is the same on every machine for the same seed.
 */

/** FNV-1a, 32-bit. Small, fast, and stable across platforms. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32: a 32-bit generator with a period of 2^32. Plenty for the sample
 * sizes Xparecium produces, and short enough to read and verify.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** True with probability `p`. p <= 0 is always false, p >= 1 always true. */
  bernoulli(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }
}

/** Lazily creates one independent generator per named stream. */
export class RandomStreams {
  private readonly seed: number;
  private readonly streams = new Map<string, Rng>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  stream(name: string): Rng {
    const existing = this.streams.get(name);
    if (existing) return existing;
    // Mixing the seed with the name hash keeps streams independent.
    const derived = (Math.imul(this.seed ^ hashString(name), 0x9e3779b1) ^ hashString(name)) >>> 0;
    const rng = new Rng(derived);
    this.streams.set(name, rng);
    return rng;
  }
}
