/** Validate historical data before it reaches the result views. */
import { z } from 'zod';
import { architectureDocumentSchema } from '../domain/schema';
import { DOCUMENT_SCHEMA_VERSION } from '../domain/types';
import { cloudProfileSchema } from '../catalogs/types';

const number = z.number().finite().nonnegative();
const text = z.string().max(8000);
const strings = z.array(text).max(5000);
const numbers = <const K extends readonly string[]>(keys: K) =>
  Object.fromEntries(keys.map((key) => [key, number])) as { [P in K[number]]: typeof number };
const decimal = z.string().max(200).regex(/^\d+(\.\d+)?$/);

const resultSchema = z.object({
  engineVersion: text, seed: number.int(),
  status: z.enum(['running', 'completed', 'incomplete', 'cancelled', 'invalid']), statusReason: text.optional(),
  ...numbers(['simulatedMs', 'arrivalWindowMs', 'drainMs', 'eventsProcessed', 'offered', 'completed',
    'rejected', 'unfinished', 'offeredRatePerSecond', 'throughputPerSecond', 'throughputWindowMs',
    'meanServiceMs', 'meanWaitMs', 'databaseQueries', 'cacheHits', 'cacheMisses', 'cachePopulates',
    'bytesTransferred', 'bytesEgressToClients']),
  // Defaulted: records written before queues existed do not carry them.
  messagesPublished: number.default(0),
  messagesProcessed: number.default(0),
  // Every reason the engine can emit has to be listed: an unknown key fails the
  // whole record, and a missing one is silently dropped on import.
  rejectionsByReason: z.record(z.enum(['balancer-queue-full', 'server-queue-full',
    'server-memory-full', 'database-queue-full', 'cache-queue-full',
    'queue-publish-full', 'queue-full',
    'dns-queue-full', 'cdn-queue-full', 'waf-queue-full', 'gateway-queue-full',
    'waf-blocked', 'gateway-throttled',
    'replica-queue-full', 'kv-queue-full', 'storage-queue-full', 'pubsub-publish-full',
    'function-throttled', 'data-service-full', 'stream-publish-full', 'worker-failed', 'support-queue-full', 'identity-denied', 'dependency-unavailable', 'secret-expired', 'rate-limited', 'connection-limit', 'circuit-open', 'mesh-unavailable']), number),
  // Absent from records written before the arrival pattern was configurable.
  arrivalPattern: z.enum(['constant', 'poisson', 'ramp', 'burst']).default('constant'),
  responseTime: z.object({ ...numbers(['meanMs', 'minMs', 'maxMs']),
    p95: z.object({ ...numbers(['value', 'lowerBound', 'relativePrecision', 'sampleCount']),
      // JSON encodes the histogram's open-ended overflow bound as null.
      upperBound: z.union([number, z.literal(Infinity), z.null().transform(() => Infinity)]) }) }),
  waitByStageMs: z.object({
    ...numbers(['serverAdmission', 'serverCpu', 'database', 'cache', 'network']),
    balancer: number.default(0),
    queue: number.default(0),
    // Absent from records written before the edge components existed.
    edge: number.default(0),
    dns: number.default(0),
    replica: number.default(0),
    kv: number.default(0),
    storage: number.default(0),
    pubsub: number.default(0),
  }),
  // Per-client figures. Defaulted because records written before they existed
  // do not carry them, and an empty list reads correctly everywhere.
  clients: z.array(z.object({ nodeId: text, name: text,
    mode: z.enum(['open', 'closed']).default('open'),
    ...numbers(['offeredRatePerSecond', 'offered', 'completed', 'rejected', 'unfinished',
      'meanResponseMs']),
    achievedRatePerSecond: number.default(0) })).max(400).default([]),
  servers: z.array(z.object({ nodeId: text, name: text,
    ...numbers(['admitted', 'completed', 'rejected', 'cpuUtilisation', 'cpuSlots', 'busySlotsAverage',
      'concurrencyAverage', 'concurrencyPeak', 'concurrencyLimit', 'admissionQueueAverage',
      'admissionQueuePeak', 'cpuQueueAverage', 'cpuQueuePeak', 'peakMemoryMb', 'memoryLimitMb',
      'cpuServiceMsTotal', 'admissionWaitMsTotal', 'cpuWaitMsTotal']),
    // Absent from records written before serverless functions existed.
    kind: z.enum(['server', 'serverless']).optional(),
    coldStarts: number.optional(), throttled: number.optional(), busyMsTotal: number.optional() })).max(400),
  supportServices: z.array(z.object({ nodeId: text, name: text, kind: z.enum(['websocket', 'notification', 'identity', 'rateLimiter', 'discovery', 'secrets', 'monitoring', 'serviceMesh']),
    ...numbers(['accepted', 'completed', 'rejected', 'waiting', 'active', 'utilisation', 'waitMsTotal']), details: z.record(number) })).max(400).default([]),
  jobServices: z.array(z.object({ nodeId: text, name: text, kind: z.enum(['eventStream', 'deadLetter', 'scheduler']),
    accepted: number, completed: number, failed: number, waiting: number, details: z.record(number) })).default([]),
  dataServices: z.array(z.object({ nodeId: text, name: text, kind: z.enum(['documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries']),
    ...numbers(['reads', 'writes', 'completed', 'rejected', 'inFlight', 'waiting', 'utilisation', 'queuePeak', 'serviceMsTotal', 'waitMsTotal']),
    details: z.record(number) })).max(400).default([]),
  stations: z.array(z.object({ nodeId: text, name: text,
    kind: z.enum(['database', 'cache', 'loadBalancer', 'queue', 'dns', 'cdn', 'waf', 'apiGateway',
      'readReplica', 'kvStore', 'objectStorage', 'pubsub', 'eventStream']),
    ...numbers(['operations', 'rejected', 'utilisation', 'slots', 'queueAverage', 'queuePeak', 'serviceMsTotal', 'waitMsTotal']),
    hits: number.optional(), misses: number.optional(), populates: number.optional(), achievedHitRate: number.optional(),
    blocked: number.optional(), throttled: number.optional(),
    reads: number.optional(), writes: number.optional(), applied: number.optional(), dropped: number.optional() })).max(400),
  queues: z.array(z.object({
    kind: z.enum(['queue', 'pubsub', 'eventStream', 'deadLetter']).optional(), retries: number.default(0), retrying: number.default(0), expired: number.default(0), nodeId: text, name: text,
    consumerId: text.nullable(), consumerName: text.nullable(), failed: number.default(0),
    ...numbers(['enqueued', 'processed', 'refused', 'outstanding', 'maxDepth', 'depthAverage',
      'depthPeak', 'backlogWaitMsTotal', 'meanLatencyMs']) })).max(400).default([]),
  links: z.array(z.object({ channelKey: text, edgeId: text, fromId: text, toId: text, fromName: text, toName: text,
    ...numbers(['messages', 'bytes', 'utilisation', 'queueAverage', 'queuePeak', 'transmissionMsTotal',
      'waitMsTotal', 'bandwidthMbps', 'propagationDelayMs']) })).max(2400),
  journeys: z.array(z.object({ requestId: number.int(), clientName: text, startMs: number,
    endMs: number.nullable(), outcome: z.enum(['completed', 'rejected', 'unfinished']),
    totalMs: number.nullable(), waitMs: number,
    steps: z.array(z.object({ atMs: number, label: text, detail: text.optional() })).max(1000) })).max(1000),
  usage: z.object({ ...numbers(['measuredSeconds', 'egressBytes', 'totalBytes', 'completedRequests']),
    scannedGbByNodeId: z.record(number).default({}),
    // Runs saved before ingested bytes were measured have none; pricing then
    // falls back to the writes and the record size on the canvas.
    ingestedBytesByNodeId: z.record(number).optional(),
    egressByNodeId: z.record(number), requestsByNodeId: z.record(number).default({}),
    writesByNodeId: z.record(number).default({}), busyMsByNodeId: z.record(number).default({}) }),
  assumptions: strings,
  findings: z.array(z.object({ id: text, severity: z.enum(['info', 'warning']), title: text, detail: text })).max(5000),
  issues: z.array(z.object({ severity: z.enum(['error', 'warning']), code: text, message: text,
    hint: text.optional(), nodeIds: strings.optional(), edgeIds: strings.optional() })).max(5000),
});

const costSchema = z.object({
  currency: text, totalMonthly: decimal, ...numbers(['pricedLineCount', 'unpricedLineCount', 'hoursPerMonth']),
  hasRun: z.boolean(), hasIllustrativeRates: z.boolean(), projectionNote: text,
  included: strings, excluded: strings, warnings: strings, catalogPublishedAt: text,
  lines: z.array(z.object({ key: text, nodeId: text, nodeName: text,
    componentKind: z.enum(['client', 'dns', 'cdn', 'waf', 'apiGateway', 'loadBalancer', 'server', 'serverless',
      'database', 'readReplica', 'kvStore', 'objectStorage', 'cache', 'queue', 'pubsub', 'documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries', 'eventStream', 'deadLetter', 'scheduler', 'websocket', 'notification', 'identity', 'rateLimiter', 'discovery', 'secrets', 'monitoring', 'serviceMesh']),
    profileId: text.nullable(), profileLabel: text, chargeType: z.enum(['compute', 'storage', 'egress', 'requests', 'writes', 'duration', 'scan', 'ingest']), chargeLabel: text,
    basis: text, quantity: decimal, quantityUnit: text, rate: decimal.nullable(), rateUnit: text,
    monthly: decimal.nullable(), unpriced: z.boolean(), unpricedReason: text.nullable(),
    verified: z.boolean(), sourceUrl: text, sourceCheckedAt: text, edited: z.boolean() })).max(1200),
});

export const runRecordSchema = z.object({
  id: z.string().min(1).max(120), projectId: z.string().min(1).max(120), createdAt: number.int(),
  label: text, schemaVersion: z.literal(1), engineVersion: text, seed: number.int(),
  inputDocument: architectureDocumentSchema.refine((doc) => doc.schemaVersion <= DOCUMENT_SCHEMA_VERSION,
    'Unsupported future document schema'),
  catalogSnapshot: z.object({ catalogId: text, version: number.int(), publishedAt: text,
    currency: text, profiles: z.array(cloudProfileSchema).max(500) }),
  result: resultSchema, cost: costSchema,
});
