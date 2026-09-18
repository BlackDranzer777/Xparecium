/**
 * A FIFO queue with O(1) push and pop.
 *
 * `Array.prototype.shift()` is O(n) in the general case, and a busy simulated
 * queue can hold thousands of waiting requests. This uses a fixed-capacity
 * circular buffer that doubles when full, so dequeueing never re-indexes the
 * whole array.
 *
 * Every waiting line in Aparecium (server admission queue, database queue,
 * cache queue, link transmission queue, CPU wait queue) uses this.
 */
export class RingQueue<T> {
  private items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(initialCapacity = 16) {
    this.items = new Array<T | undefined>(Math.max(1, initialCapacity));
  }

  get length(): number {
    return this.count;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  push(item: T): void {
    if (this.count === this.items.length) this.grow();
    const index = (this.head + this.count) % this.items.length;
    this.items[index] = item;
    this.count += 1;
  }

  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.items.length;
    this.count -= 1;
    return item;
  }

  peek(): T | undefined {
    return this.count === 0 ? undefined : this.items[this.head];
  }

  clear(): void {
    this.items = new Array<T | undefined>(16);
    this.head = 0;
    this.count = 0;
  }

  private grow(): void {
    const next = new Array<T | undefined>(this.items.length * 2);
    for (let i = 0; i < this.count; i += 1) {
      next[i] = this.items[(this.head + i) % this.items.length];
    }
    this.items = next;
    this.head = 0;
  }
}
