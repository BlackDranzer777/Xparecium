/**
 * The event queue: a binary min-heap ordered by simulated time, then by
 * insertion sequence number.
 *
 * Discrete-event simulation always needs "what happens next?". A heap answers
 * that in O(log n) for both push and pop, without ever sorting the whole set.
 *
 * The sequence number is not decoration: two events scheduled for the exact
 * same simulated millisecond must still be processed in a defined order, or
 * results stop being reproducible.
 */

export interface ScheduledEvent<T> {
  time: number;
  seq: number;
  payload: T;
}

export class EventQueue<T> {
  private heap: ScheduledEvent<T>[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  /** Sequence numbers issued so far. Useful as a cheap "events created" counter. */
  get issued(): number {
    return this.nextSeq;
  }

  push(time: number, payload: T): void {
    const event: ScheduledEvent<T> = { time, seq: this.nextSeq, payload };
    this.nextSeq += 1;
    this.heap.push(event);
    this.siftUp(this.heap.length - 1);
  }

  peekTime(): number | null {
    const top = this.heap[0];
    return top ? top.time : null;
  }

  pop(): ScheduledEvent<T> | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.heap.length = 0;
  }

  private less(a: ScheduledEvent<T>, b: ScheduledEvent<T>): boolean {
    if (a.time !== b.time) return a.time < b.time;
    return a.seq < b.seq;
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    const item = this.heap[index]!;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = this.heap[parentIndex]!;
      if (!this.less(item, parent)) break;
      this.heap[index] = parent;
      index = parentIndex;
    }
    this.heap[index] = item;
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    const length = this.heap.length;
    const item = this.heap[index]!;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      let childIndex = left;
      if (right < length && this.less(this.heap[right]!, this.heap[left]!)) {
        childIndex = right;
      }
      const child = this.heap[childIndex]!;
      if (!this.less(child, item)) break;
      this.heap[index] = child;
      index = childIndex;
    }
    this.heap[index] = item;
  }
}
