/**
 * Streaming metric accumulators.
 *
 * A run can produce millions of events. Keeping every latency sample would
 * cost memory proportional to the run length, so instead:
 *
 *   - simple statistics (count, sum, min, max) are updated in place;
 *   - the latency distribution goes into a fixed number of histogram buckets,
 *     which gives an approximate p95 whose precision we can state honestly;
 *   - anything that is "a level over time" (CPU busy slots, queue length) is
 *     integrated as area under the curve, so the average is time-weighted
 *     rather than sampled.
 */

export class StreamingStat {
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  record(value: number): void {
    this.count += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  get mean(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  snapshot(): { count: number; sum: number; mean: number; min: number; max: number } {
    return {
      count: this.count,
      sum: this.sum,
      mean: this.mean,
      min: this.count === 0 ? 0 : this.min,
      max: this.count === 0 ? 0 : this.max,
    };
  }
}

export interface QuantileEstimate {
  /** Best single estimate: the upper edge of the bucket the quantile falls in. */
  value: number;
  /** The quantile is somewhere in [lowerBound, upperBound]. */
  lowerBound: number;
  upperBound: number;
  /** Relative width of the bucket, e.g. 0.15 means the estimate is within +/-15%. */
  relativePrecision: number;
  sampleCount: number;
}

/**
 * Exponentially spaced buckets. Bucket i covers [minValue * ratio^i,
 * minValue * ratio^(i+1)), so every bucket has the same *relative* width.
 * That is the right trade-off for latency, where being 15% out at 400 ms
 * matters about as much as being 15% out at 4 ms.
 */
export class BoundedHistogram {
  private readonly counts: Float64Array;
  private readonly logRatio: number;
  private underflow = 0;
  private overflow = 0;
  private total = 0;

  constructor(
    private readonly minValue = 0.1,
    private readonly ratio = 1.15,
    private readonly bucketCount = 120,
  ) {
    this.counts = new Float64Array(bucketCount);
    this.logRatio = Math.log(ratio);
  }

  get relativePrecision(): number {
    return this.ratio - 1;
  }

  record(value: number): void {
    this.total += 1;
    if (!Number.isFinite(value) || value < this.minValue) {
      this.underflow += 1;
      return;
    }
    const index = Math.floor(Math.log(value / this.minValue) / this.logRatio);
    if (index >= this.bucketCount) {
      this.overflow += 1;
      return;
    }
    this.counts[index] = (this.counts[index] ?? 0) + 1;
  }

  private edge(index: number): number {
    return this.minValue * Math.pow(this.ratio, index);
  }

  quantile(q: number): QuantileEstimate {
    const empty: QuantileEstimate = {
      value: 0,
      lowerBound: 0,
      upperBound: 0,
      relativePrecision: this.relativePrecision,
      sampleCount: this.total,
    };
    if (this.total === 0) return empty;

    const target = q * this.total;
    let cumulative = this.underflow;
    if (cumulative >= target) {
      return { ...empty, value: this.minValue, lowerBound: 0, upperBound: this.minValue };
    }
    for (let i = 0; i < this.bucketCount; i += 1) {
      cumulative += this.counts[i] ?? 0;
      if (cumulative >= target) {
        return {
          value: this.edge(i + 1),
          lowerBound: this.edge(i),
          upperBound: this.edge(i + 1),
          relativePrecision: this.relativePrecision,
          sampleCount: this.total,
        };
      }
    }
    const last = this.edge(this.bucketCount);
    return {
      value: last,
      lowerBound: last,
      upperBound: Number.POSITIVE_INFINITY,
      relativePrecision: this.relativePrecision,
      sampleCount: this.total,
    };
  }
}

/**
 * Integrates a step function over simulated time.
 *
 * Call `set` whenever the level changes. `timeAverage` then returns
 * (area under the curve) / (elapsed time), which is what "time-weighted
 * utilisation" and "average queue length" actually mean.
 */
export class TimeWeightedAccumulator {
  private level = 0;
  private area = 0;
  private lastTime: number;
  private readonly startTime: number;
  private endTime = Number.POSITIVE_INFINITY;
  peak = 0;

  constructor(startTime = 0) {
    this.lastTime = startTime;
    this.startTime = startTime;
  }

  get current(): number {
    return this.level;
  }

  advanceTo(time: number): void {
    const until = Math.min(time, this.endTime);
    if (until > this.lastTime) {
      this.area += this.level * (until - this.lastTime);
      this.lastTime = until;
    }
  }

  /**
   * The measurement ends at `time`. A change before it is integrated as ever;
   * a change after it integrates the level that held up to `time` and no
   * further, and `timeAverage` never looks past it. The engine calls this
   * once the workload is over and only retention housekeeping is left, with
   * the end of the interval the result is measured over: an expiry inside
   * that interval still counts for every millisecond the record sat there,
   * and one after it changes the state but not the average.
   */
  endAt(time: number): void {
    this.endTime = Math.min(this.endTime, time);
  }

  set(time: number, level: number): void {
    this.advanceTo(time);
    this.level = level;
    if (level > this.peak) this.peak = level;
  }

  add(time: number, delta: number): void {
    this.set(time, this.level + delta);
  }

  timeAverage(endTime: number): number {
    const until = Math.min(endTime, this.endTime);
    const elapsed = until - this.startTime;
    const area = this.area + this.level * Math.max(0, until - this.lastTime);
    return elapsed > 0 ? area / elapsed : 0;
  }
}
