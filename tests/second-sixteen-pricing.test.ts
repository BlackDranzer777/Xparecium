import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { DEFAULT_CLOUD_PROFILE_BY_KIND, makeNode } from '../src/domain/defaults';
import type { ArchEdge, ArchNode, ArchitectureDocument, ComponentKind } from '../src/domain/types';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation } from '../src/simulation/engine';
import { createRunRecord } from '../src/storage/runs';
import { runRecordSchema } from '../src/storage/run-schema';
import { client, doc, edge, server, INSTANT } from './helpers';

/**
 * Real prices for the sixteen newest components.
 *
 * Each default profile was read from the AWS Price List Bulk API. These tests
 * hold two things: that the rate on the line is the provider's own number, and
 * that the quantity it multiplies comes from the run — records counted, bytes
 * drawn on the canvas, partitions drawn on the canvas — never from a guess.
 * Three components stay unpriced on purpose, and the tests say which.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);
const HOURS = 730;

const openServer = () =>
  server('s1', { profile: 'custom', cpuSlots: 8, cpuMsPerRequest: 5, concurrencyLimit: 10_000, ramMb: 1_000_000, baselineMemoryMb: 0, memoryPerRequestMb: 1, memoryPerQueuedRequestMb: 0, queueLimit: 100_000 });

/** A component of this kind, on its default profile, wired the way it is meant to be. */
function design(kind: ComponentKind, settings: Record<string, unknown> = {}): ArchitectureDocument {
  const node = makeNode(kind, 'x', kind, { x: 0, y: 0 });
  Object.assign(node.settings as Record<string, unknown>, settings);
  const users = client('c1', { requestRateOverridePerSecond: 20, requestBytes: 0, responseBytes: 0 });
  const nodes: ArchNode[] = [users, openServer(), node];
  const edges: ArchEdge[] = [];
  switch (kind) {
    case 'websocket':
    case 'rateLimiter':
    case 'serviceMesh':
      edges.push(edge('c1', 'x', INSTANT), edge('x', 's1', INSTANT));
      break;
    case 'scheduler':
      edges.push(edge('c1', 's1', INSTANT), edge('x', 's1', INSTANT));
      break;
    case 'eventStream': {
      nodes.push(server('reader', { cpuMsPerRequest: 2 }));
      edges.push(edge('c1', 's1', INSTANT), edge('s1', 'x', INSTANT), edge('x', 'reader', INSTANT));
      break;
    }
    case 'deadLetter': {
      const queue = makeNode('queue', 'q', 'q', { x: 0, y: 0 });
      if (queue.kind === 'queue') queue.settings.processingFailureShare = 1;
      nodes.push(queue, server('w1', { cpuMsPerRequest: 2 }));
      edges.push(edge('c1', 's1', INSTANT), edge('s1', 'q', INSTANT), edge('q', 'w1', INSTANT), edge('q', 'x', INSTANT));
      break;
    }
    default:
      edges.push(edge('c1', 's1', INSTANT), edge('s1', 'x', INSTANT));
  }
  return doc(nodes, edges, { durationSeconds: 30, drainSeconds: 20, seed: 3 });
}

function priced(kind: ComponentKind, settings: Record<string, unknown> = {}) {
  const d = design(kind, settings);
  const r = runSimulation(d);
  const estimate = estimateCost({ document: d, catalog, usage: r.usage });
  const lines = estimate.lines.filter((l) => l.nodeId === 'x');
  const line = (type: string) => lines.find((l) => l.chargeType === type)!;
  const perMonth = (n: number) => (n / r.usage.measuredSeconds) * HOURS * 3600;
  return { d, r, lines, line, perMonth };
}

describe('the sixteen newest components on their default profiles', () => {
  it('thirteen start on a verified AWS rate, three stay unpriced with a reason', () => {
    const verified: ComponentKind[] = [];
    const unpriced: ComponentKind[] = [];
    for (const kind of ['documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries', 'eventStream', 'deadLetter', 'scheduler', 'websocket', 'rateLimiter', 'serviceMesh', 'identity', 'discovery', 'secrets', 'notification', 'monitoring'] as ComponentKind[]) {
      const profile = catalog.profiles.find((p) => p.id === DEFAULT_CLOUD_PROFILE_BY_KIND[kind])!;
      expect(profile, kind).toBeDefined();
      expect(profile.appliesTo, kind).toContain(kind);
      (profile.verified ? verified : unpriced).push(kind);
      if (!profile.verified) {
        expect(Object.values(profile.charges).every((c) => c.amount === null), kind).toBe(true);
        expect(`${profile.label} ${profile.priceNote}`, kind).toMatch(/no rates/i);
      } else {
        expect(profile.priceNote, kind).toMatch(/Read from the AWS Price List Bulk API/);
      }
    }
    expect(verified.sort()).toEqual(['deadLetter', 'discovery', 'documentDb', 'eventStream', 'monitoring', 'notification', 'scheduler', 'searchIndex', 'secrets', 'timeSeries', 'warehouse', 'websocket', 'wideColumn']);
    // Cognito bills per monthly active user, which the run does not measure;
    // nobody sells a rate limiter or a mesh proxy on its own.
    expect(unpriced.sort()).toEqual(['identity', 'rateLimiter', 'serviceMesh']);
  });

  it('Document database: one I/O-Optimized instance and its storage, no per-request charge', () => {
    const { lines, line } = priced('documentDb', { storedGb: 100 });
    expect(lines.map((l) => l.chargeType).sort()).toEqual(['compute', 'storage']);
    // The price list's PricePerUnit column carries 0.2895; its description
    // says $0.289465. The column is the machine-readable figure, so it wins.
    expect(line('compute').rate).toBe('0.2895');
    expect(Number(line('compute').monthly)).toBeCloseTo(0.2895 * HOURS, 1); // rounded to cents
    expect(line('storage').rate).toBe('0.30');
    expect(Number(line('storage').monthly)).toBeCloseTo(30, 6);
    expect(lines.every((l) => l.verified && !l.unpriced)).toBe(true);
  });

  it('Wide-column store: reads, writes and storage at the Keyspaces rates', () => {
    const { r, line, perMonth } = priced('wideColumn', { readShare: 0.7, storedGb: 10 });
    const svc = r.dataServices!.find((s) => s.nodeId === 'x')!;
    expect(line('requests').rate).toBe('0.125');
    expect(line('writes').rate).toBe('0.625');
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(svc.reads) / 1e6, 4);
    expect(Number(line('writes').quantity)).toBeCloseTo(perMonth(svc.writes) / 1e6, 4);
    expect(Number(line('storage').monthly)).toBeCloseTo(10 * 0.25, 6);
  });

  it('Search index: one data node and its gp3 storage', () => {
    const { lines, line } = priced('searchIndex', { storedGb: 50 });
    expect(lines.map((l) => l.chargeType).sort()).toEqual(['compute', 'storage']);
    expect(line('compute').rate).toBe('0.167');
    expect(Number(line('storage').monthly)).toBeCloseTo(50 * 0.122, 6);
  });

  it('Data warehouse: Athena bills what the reports scanned, per GB, plus S3 for the data', () => {
    const { r, line, perMonth } = priced('warehouse', { readShare: 1, scanGbPerQuery: 2, storedGb: 1000 });
    const scanned = r.dataServices!.find((s) => s.nodeId === 'x')!.details.scannedGb!;
    expect(scanned).toBeGreaterThan(0);
    expect(line('scan').rate).toBe('0.004883'); // 5.00 per TB of 1,024 GB
    expect(Number(line('scan').quantity)).toBeCloseTo(perMonth(scanned), 2);
    expect(Number(line('scan').monthly)).toBeCloseTo(perMonth(scanned) * 0.004883, 1);
    expect(Number(line('storage').monthly)).toBeCloseTo(1000 * 0.023, 6);
    // The provisioned alternative charges the node, not the scan.
    const redshift = catalog.profiles.find((p) => p.id === 'aws.redshift.ra3-xlplus.us-east-1')!;
    expect(Object.keys(redshift.charges).sort()).toEqual(['compute', 'storage']);
    expect(redshift.charges.compute!.amount).toBe('1.086');
  });

  it('Time-series database: ingestion is the bytes the writes carried, per GB', () => {
    // A write is `pointsPerWrite` points of `itemBytes` each, and that is
    // what the link carried and what Timestream bills.
    const { r, line, perMonth } = priced('timeSeries', { readShare: 0, itemBytes: 4096, pointsPerWrite: 25, storedGb: 20 });
    const writes = r.dataServices!.find((s) => s.nodeId === 'x')!.writes;
    expect(writes).toBeGreaterThan(0);
    expect(r.usage.writesByNodeId['x']).toBe(writes);
    expect(r.usage.ingestedBytesByNodeId!['x']).toBe(writes * 25 * 4096);
    expect(line('ingest').rate).toBe('0.50');
    expect(Number(line('ingest').quantity)).toBeCloseTo(perMonth((writes * 25 * 4096) / 1e9), 4);
    expect(line('ingest').basis).toContain(`${writes} writes of 25 points at 4096 bytes each`);
    expect(Number(line('storage').monthly)).toBeCloseTo(20 * 0.03, 6);
  });

  it('Time-series database: a hundred points per write is a hundred times the ingestion charge', () => {
    // Codex regression. The engine already sent itemBytes × pointsPerWrite
    // over the link; pricing counted only itemBytes, so this pair matched.
    const one = priced('timeSeries', { readShare: 0, pointsPerWrite: 1 });
    const hundred = priced('timeSeries', { readShare: 0, pointsPerWrite: 100 });
    const carried = (x: typeof one) => x.r.links.find((l) => l.fromId === 's1' && l.toId === 'x')!.bytes;
    expect(one.r.dataServices![0]!.writes).toBe(hundred.r.dataServices![0]!.writes);
    expect(carried(hundred)).toBe(carried(one) * 100);
    expect(Number(hundred.line('ingest').quantity)).toBeCloseTo(Number(one.line('ingest').quantity) * 100, 2);
    expect(Number(hundred.line('ingest').monthly)).toBeCloseTo(Number(one.line('ingest').monthly) * 100, 0);
    // The billed bytes are the bytes the link carried, projected to the month.
    expect(Number(hundred.line('ingest').quantity)).toBeCloseTo(hundred.perMonth(carried(hundred) / 1e9), 4);
  });

  it('Time-series database: a run saved before ingested bytes were measured is priced from the canvas', () => {
    // Historical ledgers have no `ingestedBytesByNodeId`. The same product —
    // writes × points × bytes — comes from the canvas, so the old run's
    // estimate agrees with a new one and is never zero.
    const { d, r, line } = priced('timeSeries', { readShare: 0, pointsPerWrite: 100 });
    const { ingestedBytesByNodeId: _dropped, ...older } = r.usage;
    const legacy = estimateCost({ document: d, catalog, usage: older }).lines.find((l) => l.nodeId === 'x' && l.chargeType === 'ingest')!;
    expect(legacy.quantity).toBe(line('ingest').quantity);
    expect(legacy.monthly).toBe(line('ingest').monthly);
    // Both shapes of saved run still read back.
    const cost = estimateCost({ document: d, catalog, usage: r.usage });
    const record = createRunRecord({ projectId: 'p', label: 'ts', document: d, catalog, result: r, cost });
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record))).result.usage.ingestedBytesByNodeId).toEqual(r.usage.ingestedBytesByNodeId);
    const saved = JSON.parse(JSON.stringify(record));
    delete saved.result.usage.ingestedBytesByNodeId;
    expect(runRecordSchema.safeParse(saved).success).toBe(true);
  });

  it('Event stream: one Kinesis shard per partition, plus a payload unit per record', () => {
    const { r, line, perMonth } = priced('eventStream', { partitions: 4 });
    const published = r.jobServices!.find((s) => s.nodeId === 'x')!.accepted;
    expect(published).toBeGreaterThan(0);
    expect(line('compute').rate).toBe('0.015');
    expect(Number(line('compute').quantity)).toBe(4 * HOURS);
    expect(Number(line('compute').monthly)).toBeCloseTo(4 * HOURS * 0.015, 6);
    expect(line('requests').rate).toBe('0.014');
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(published) / 1e6, 4);
  });

  it('Dead-letter queue: the SQS rate, three billed requests per message', () => {
    const { r, line, perMonth } = priced('deadLetter');
    const received = r.jobServices!.find((s) => s.nodeId === 'x')!.accepted;
    expect(received).toBeGreaterThan(0);
    expect(line('requests').rate).toBe('0.40');
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(received * 3) / 1e6, 4);
  });

  it('Scheduler: one EventBridge invocation per job started', () => {
    const { r, line, perMonth } = priced('scheduler', { intervalSeconds: 1, batchSize: 5 });
    const started = r.jobServices!.find((s) => s.nodeId === 'x')!.accepted;
    expect(started).toBeGreaterThan(0);
    expect(line('requests').rate).toBe('1.00');
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(started) / 1e6, 4);
  });

  it('WebSocket server: one API Gateway message per message', () => {
    const { r, line, perMonth } = priced('websocket');
    const handled = r.supportServices!.find((s) => s.nodeId === 'x')!.details.attempts ?? 0;
    expect(handled).toBeGreaterThan(0);
    expect(line('requests').rate).toBe('1.00');
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(handled) / 1e6, 4);
  });

  it('Discovery, secrets: a monthly item spread over the hours, plus a call per lookup', () => {
    const discovery = priced('discovery');
    expect(discovery.line('compute').rate).toBe('0.000137'); // $0.10 a month / 730
    expect(discovery.line('requests').rate).toBe('1.00');
    const secrets = priced('secrets');
    expect(secrets.line('compute').rate).toBe('0.000548'); // $0.40 a month / 730
    expect(secrets.line('requests').rate).toBe('5.00'); // $0.05 per 10,000
    for (const { r, line, perMonth } of [discovery, secrets]) {
      const calls = r.supportServices!.find((s) => s.nodeId === 'x')!.details.attempts ?? 0;
      expect(calls).toBeGreaterThan(0);
      expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(calls) / 1e6, 4);
    }
  });

  it('Notification service: one SES recipient per delivery attempt', () => {
    const { r, line, perMonth } = priced('notification');
    const attempts = r.supportServices!.find((s) => s.nodeId === 'x')!.details.attempts ?? 0;
    expect(attempts).toBeGreaterThan(0);
    expect(line('requests').rate).toBe('100.00'); // $0.0001 per recipient
    expect(Number(line('requests').quantity)).toBeCloseTo(perMonth(attempts) / 1e6, 4);
  });

  it('Monitoring: CloudWatch Logs bills the records taken in, times their size, per GB', () => {
    const { r, lines, line, perMonth } = priced('monitoring', { recordBytes: 512, sampleShare: 1 });
    const records = r.supportServices!.find((s) => s.nodeId === 'x')!.details.attempts ?? 0;
    expect(records).toBeGreaterThan(0);
    expect(lines.map((l) => l.chargeType)).toEqual(['ingest']);
    expect(line('ingest').rate).toBe('0.50');
    expect(Number(line('ingest').quantity)).toBeCloseTo(perMonth((records * 512) / 1e9), 3);
    expect(line('ingest').basis).toContain(`${records} records of 512 bytes`);
  });

  it('Identity, rate limiter, service mesh: an unpriced line with the reason, never zero', () => {
    for (const kind of ['identity', 'rateLimiter', 'serviceMesh'] as ComponentKind[]) {
      const { lines } = priced(kind);
      expect(lines.length, kind).toBeGreaterThan(0);
      expect(lines.every((l) => l.unpriced && l.monthly === null), kind).toBe(true);
    }
    const cognito = catalog.profiles.find((p) => p.id === 'aws.cognito.us-east-1')!;
    expect(cognito.verified).toBe(false);
    expect(cognito.priceNote).toMatch(/per monthly active user/);
    expect(cognito.priceNote).toMatch(/\$0\.0055 per MAU/);
  });
});
