import type { DataServiceNode } from '../../domain/data-services';
import type { DataServiceMetrics } from '../types';
import { TimeWeightedAccumulator } from '../metrics';
import { RingQueue } from '../ring-queue';
import type { RandomStreams, Rng } from '../rng';

export interface DataOperation {
  write: boolean;
  serviceMs: number;
  requestBytes: number;
  responseBytes: number;
  partition: number;
  examined: number;
  scannedGb: number;
  indexed: boolean;
}
interface Job { id: number; op: DataOperation; queuedAt: number }

/** Bounded resources, with explicitly different work and state for each store. */
export class DataServiceModel {
  readonly busyAcc = new TimeWeightedAccumulator(0);
  readonly queueAcc = new TimeWeightedAccumulator(0);
  readonly slots: number;
  private readonly lanes: { busy: number; queue: RingQueue<Job> }[];
  private readonly laneSlots: number;
  private readonly readStream: Rng;
  private readonly indexStream: Rng;
  private readonly partitionStream: Rng;
  private readonly active = new Map<number, Job>();
  private queued = 0;
  private serviceMs = 0;
  private waitMs = 0;
  private reads = 0;
  private writes = 0;
  private completed = 0;
  private rejected = 0;
  private examined = 0;
  private scannedGb = 0;
  private indexedReads = 0;
  private scans = 0;
  private visibleWrites = 0;
  private pendingWrites = 0;
  private refreshAt = Infinity;
  private ingestedPoints = 0;
  // Retention is bucketed to 1/512 of the configured interval, bounding memory.
  private readonly points = Array.from({ length: 512 }, () => ({ epoch: -1, count: 0 }));

  constructor(readonly node: DataServiceNode, streams: RandomStreams) {
    const partitions = node.kind === 'wideColumn' ? node.settings.partitions : 1;
    this.laneSlots = node.kind === 'wideColumn' ? node.settings.slotsPerPartition : node.settings.maxConcurrentRequests;
    this.slots = partitions * this.laneSlots;
    this.lanes = Array.from({ length: partitions }, () => ({ busy: 0, queue: new RingQueue<Job>() }));
    this.readStream = streams.stream(`data-read:${node.id}`);
    this.indexStream = streams.stream(`data-index:${node.id}`);
    this.partitionStream = streams.stream(`data-partition:${node.id}`);
  }

  prepare(now: number): DataOperation {
    const n = this.node;
    const write = !this.readStream.bernoulli(n.settings.readShare);
    const op: DataOperation = { write, serviceMs: 0, partition: 0, examined: 0, scannedGb: 0, indexed: false,
      requestBytes: write ? n.settings.itemBytes : 256, responseBytes: write ? 256 : n.settings.itemBytes };
    switch (n.kind) {
      case 'documentDb':
        op.indexed = !write && this.indexStream.bernoulli(n.settings.indexHitShare);
        op.examined = write ? 0 : op.indexed ? 1 : n.settings.documentsPerScan;
        op.serviceMs = write ? n.settings.writeMs : op.indexed ? n.settings.indexedReadMs : op.examined * n.settings.scanMsPerDocument;
        break;
      case 'wideColumn':
        op.partition = this.partitionStream.bernoulli(n.settings.hotPartitionShare) ? 0 : Math.floor(this.partitionStream.next() * n.settings.partitions);
        op.serviceMs = write ? n.settings.writeMs * n.settings.replicas : n.settings.readMs;
        break;
      case 'searchIndex':
        op.serviceMs = write ? n.settings.indexMs : n.settings.queryMs * n.settings.shardsPerQuery;
        break;
      case 'warehouse':
        op.scannedGb = write ? 0 : n.settings.scanGbPerQuery;
        op.serviceMs = write ? n.settings.ingestMs : n.settings.setupMs + op.scannedGb / n.settings.scanGbPerSecond * 1000;
        break;
      case 'timeSeries':
        op.examined = write ? 0 : this.retained(now, n.settings.queryWindowSeconds);
        op.serviceMs = write ? n.settings.pointsPerWrite * n.settings.ingestMsPerPoint : n.settings.queryBaseMs + op.examined * n.settings.queryMsPerPoint;
        if (write) op.requestBytes *= n.settings.pointsPerWrite;
        break;
    }
    return op;
  }

  admit(id: number, op: DataOperation, now: number, start: (id: number, ms: number, waited: number) => void): boolean {
    const lane = this.lanes[op.partition]!;
    const job = { id, op, queuedAt: now };
    if (lane.busy < this.laneSlots) this.start(job, now, start);
    else if (this.queued < this.node.settings.queueLimit) {
      lane.queue.push(job);
      this.queued++;
      this.queueAcc.set(now, this.queued);
    } else { this.rejected++; return false; }
    return true;
  }

  private start(job: Job, now: number, schedule: (id: number, ms: number, waited: number) => void): void {
    const lane = this.lanes[job.op.partition]!;
    lane.busy++;
    this.active.set(job.id, job);
    this.busyAcc.set(now, this.active.size);
    this.waitMs += now - job.queuedAt;
    this.serviceMs += job.op.serviceMs;
    if (job.op.write) this.writes++; else this.reads++;
    this.examined += job.op.examined;
    this.scannedGb += job.op.scannedGb;
    if (this.node.kind === 'documentDb' && !job.op.write) {
      if (job.op.indexed) this.indexedReads++; else this.scans++;
    }
    schedule(job.id, job.op.serviceMs, now - job.queuedAt);
  }

  finish(id: number, now: number, schedule: (id: number, ms: number, waited: number) => void): DataOperation | null {
    const job = this.active.get(id);
    if (!job) return null;
    const lane = this.lanes[job.op.partition]!;
    this.active.delete(id);
    lane.busy--;
    this.busyAcc.set(now, this.active.size);
    this.completed++;
    if (this.node.kind === 'searchIndex') {
      if (now >= this.refreshAt) { this.visibleWrites += this.pendingWrites; this.pendingWrites = 0; this.refreshAt = Infinity; }
      if (job.op.write) {
        this.pendingWrites++;
        this.refreshAt = (Math.floor(now / this.node.settings.refreshMs) + 1) * this.node.settings.refreshMs;
      }
    }
    if (this.node.kind === 'timeSeries' && job.op.write) {
      const epoch = Math.floor(now / (this.node.settings.retentionSeconds * 1000 / 512));
      const bucket = this.points[epoch % 512]!;
      if (bucket.epoch !== epoch) { bucket.epoch = epoch; bucket.count = 0; }
      bucket.count += this.node.settings.pointsPerWrite;
      this.ingestedPoints += this.node.settings.pointsPerWrite;
    }
    const next = lane.queue.shift();
    if (next) { this.queued--; this.queueAcc.set(now, this.queued); this.start(next, now, schedule); }
    return job.op;
  }

  private retained(now: number, seconds: number): number {
    if (this.node.kind !== 'timeSeries') return 0;
    const width = this.node.settings.retentionSeconds * 1000 / 512;
    const cutoff = now - Math.min(seconds, this.node.settings.retentionSeconds) * 1000;
    return this.points.reduce((sum, b) => sum + (b.epoch >= 0 && (b.epoch + 1) * width > cutoff && b.epoch * width <= now ? b.count : 0), 0);
  }

  snapshot(now: number): DataServiceMetrics {
    const refreshed = now >= this.refreshAt;
    const details: Record<string, number> = {};
    switch (this.node.kind) {
      case 'documentDb': Object.assign(details, { indexedReads: this.indexedReads, scans: this.scans, documentsExamined: this.examined }); break;
      case 'wideColumn': Object.assign(details, { partitions: this.lanes.length, hotPartitionBusy: this.lanes[0]!.busy, writeCopies: this.writes * this.node.settings.replicas }); break;
      case 'searchIndex': Object.assign(details, { searchableWrites: this.visibleWrites + (refreshed ? this.pendingWrites : 0), pendingRefresh: refreshed ? 0 : this.pendingWrites }); break;
      case 'warehouse': Object.assign(details, { scannedGb: this.scannedGb }); break;
      case 'timeSeries': Object.assign(details, { ingestedPoints: this.ingestedPoints, retainedPoints: this.retained(now, this.node.settings.retentionSeconds), pointsExamined: this.examined }); break;
    }
    return { nodeId: this.node.id, name: this.node.name, kind: this.node.kind, reads: this.reads, writes: this.writes,
      completed: this.completed, rejected: this.rejected, inFlight: this.active.size, waiting: this.queued,
      utilisation: this.busyAcc.timeAverage(now) / this.slots, queuePeak: this.queueAcc.peak,
      serviceMsTotal: this.serviceMs, waitMsTotal: this.waitMs, details };
  }
}
