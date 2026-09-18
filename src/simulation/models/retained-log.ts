import { RingQueue } from '../ring-queue';

export interface LogRecord {
  sequence: number;
  partition: number;
  offset: number;
  publishedBy: number;
  enqueuedAt: number;
}
interface LogGroup {
  next: number[];
  active: Map<number, LogRecord>;
  cursor: number;
  processed: number;
  failed: number;
  missed: number;
}

/** A bounded retained history. Consuming a record does not delete it. */
export class RetainedLog {
  private readonly ordered = new RingQueue<LogRecord>();
  private readonly records: Map<number, LogRecord>[];
  private readonly nextOffsets: number[];
  private readonly oldestOffsets: number[];
  private readonly groups = new Map<string, LogGroup>();
  published = 0;
  expired = 0;
  evicted = 0;

  constructor(readonly partitions: number, readonly maxRecords: number, readonly retentionMs: number) {
    if (!Number.isInteger(partitions) || partitions < 1 || !Number.isInteger(maxRecords) || maxRecords < 1 || !Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error('A log requires positive partitions, record capacity and retention.');
    }
    this.records = Array.from({ length: partitions }, () => new Map());
    this.nextOffsets = Array.from({ length: partitions }, () => 0);
    this.oldestOffsets = Array.from({ length: partitions }, () => 0);
  }

  addGroup(id: string, start: 'earliest' | 'latest' = 'earliest'): void {
    if (this.groups.has(id)) throw new Error(`Duplicate consumer group: ${id}`);
    this.groups.set(id, { next: [...(start === 'earliest' ? this.oldestOffsets : this.nextOffsets)],
      active: new Map(), cursor: 0, processed: 0, failed: 0, missed: 0 });
  }

  append(publishedBy: number, now: number): LogRecord {
    this.expire(now);
    while (this.ordered.length >= this.maxRecords) this.removeOldest(false);
    const partition = this.published % this.partitions;
    const record: LogRecord = { sequence: this.published++, partition, offset: this.nextOffsets[partition]!, publishedBy, enqueuedAt: now };
    this.nextOffsets[partition]!++;
    this.records[partition]!.set(record.offset, record);
    this.ordered.push(record);
    return record;
  }

  /** Retention maintenance is driven by simulated events, never a real timer. */
  expire(now: number): void {
    while (this.ordered.peek() && this.ordered.peek()!.enqueuedAt + this.retentionMs <= now) this.removeOldest(true);
  }

  private removeOldest(expired: boolean): void {
    const record = this.ordered.shift();
    if (!record) return;
    this.records[record.partition]!.delete(record.offset);
    this.oldestOffsets[record.partition] = record.offset + 1;
    if (expired) this.expired++; else this.evicted++;
    for (const group of this.groups.values()) {
      const next = group.next[record.partition]!;
      if (next <= record.offset) {
        group.missed += record.offset + 1 - next;
        group.next[record.partition] = record.offset + 1;
      }
    }
  }

  /** One in-flight record per partition per group preserves partition order. */
  take(groupId: string, now: number): LogRecord | undefined {
    this.expire(now);
    const group = this.groups.get(groupId);
    if (!group) return undefined;
    for (let i = 0; i < this.partitions; i++) {
      const partition = (group.cursor + i) % this.partitions;
      if (group.active.has(partition)) continue;
      const record = this.records[partition]!.get(group.next[partition]!);
      if (!record) continue;
      group.next[partition] = record.offset + 1;
      group.active.set(partition, record);
      group.cursor = (partition + 1) % this.partitions;
      return record;
    }
    return undefined;
  }

  settle(groupId: string, sequence: number, success: boolean): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    const partition = sequence % this.partitions;
    if (group.active.get(partition)?.sequence !== sequence) return false;
    group.active.delete(partition);
    if (success) group.processed++; else group.failed++;
    return true;
  }

  /** Replaying starts at the oldest retained record; already running work must finish first. */
  rewind(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group || group.active.size > 0) return false;
    group.next = [...this.oldestOffsets];
    return true;
  }

  get retained(): number { return this.ordered.length; }
  get nextExpiryAt(): number | null {
    const first = this.ordered.peek();
    return first ? first.enqueuedAt + this.retentionMs : null;
  }
  groupSnapshot(groupId: string) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const unread = group.next.reduce((sum, offset, p) => sum + this.nextOffsets[p]! - offset, 0);
    return { unread, inFlight: group.active.size, processed: group.processed, failed: group.failed, missed: group.missed,
      nextOffsets: [...group.next] };
  }
}
