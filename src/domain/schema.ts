import { SUPPORT_SERVICES } from './support-services';
import type { SupportKind, SupportSettings } from './support-services';
import { JOB_SERVICES } from './job-services';
import type { JobKind, EventStreamSettings, DeadLetterSettings, SchedulerSettings, WorkflowSettings } from './job-services';
import { DATA_SERVICES } from './data-services';
import { CHAIN_SERVICES } from './chain-services';
import type { ChainKind, ChainSettings } from './chain-services';
import type { DataKind, DataSettings, NumericSetting } from './data-services';
/**
 * Runtime validation for everything that crosses a trust boundary:
 * imported JSON files, documents read back out of IndexedDB, and catalog
 * files fetched from the static host.
 *
 * TypeScript types vanish at runtime; Zod checks the shape of data we did not
 * create in this session.
 */
import { z } from 'zod';
import { DOCUMENT_SCHEMA_VERSION } from './types';

const finite = (min: number, max: number) =>
  z.number().finite().min(min).max(max);

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const cloudSchema = z.object({
  profileId: z.string().max(120).nullable(),
  pricingMode: z.enum(['automatic', 'manual']).optional(),
  previousProfileId: z.string().max(120).optional(),
});

export const clientSettingsSchema = z.object({
  // Defaulted rather than required: a document saved at schema version 1 has
  // neither of these, and refusing to open it would be the wrong answer.
  mode: z.enum(['open', 'closed']).default('open'),
  activeUsers: finite(0, 100_000_000),
  actionsPerUserPerMinute: finite(0, 100_000),
  thinkTimeMs: finite(0, 3_600_000).default(3_000),
  requestRateOverridePerSecond: finite(0, 10_000_000).nullable(),
  requestBytes: finite(0, 1_000_000_000),
  responseBytes: finite(0, 1_000_000_000),
});

export const loadBalancerSettingsSchema = z.object({
  maxConcurrentRequests: z.number().int().min(1).max(10_000_000),
  serviceTimeMs: finite(0, 3_600_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
  policy: z.enum(['round-robin', 'least-busy']),
});

export const serverSettingsSchema = z.object({
  profile: z.enum(['small', 'medium', 'large', 'xlarge', 'custom']),
  cpuSlots: z.number().int().min(1).max(4096),
  ramMb: finite(1, 100_000_000),
  cpuMsPerRequest: finite(0, 3_600_000),
  concurrencyLimit: z.number().int().min(1).max(1_000_000),
  baselineMemoryMb: finite(0, 100_000_000),
  memoryPerRequestMb: finite(0, 1_000_000),
  memoryPerQueuedRequestMb: finite(0, 1_000_000),
  queueLimit: z.number().int().min(0).max(1_000_000),
  // Absent from documents written before version 7: off, as they ran.
  autoscaleEnabled: z.boolean().default(false),
  minInstances: z.number().int().min(1).max(1000).default(1),
  maxInstances: z.number().int().min(1).max(1000).default(4),
  targetCpuShare: finite(0.05, 1).default(0.6),
  instanceWarmupSeconds: finite(0, 3600).default(15),
  scaleCheckSeconds: finite(0.1, 3600).default(5),
}).refine((s) => s.maxInstances >= s.minInstances, {
  message: 'The most instances cannot be fewer than the fewest.',
  path: ['maxInstances'],
});

export const databaseSettingsSchema = z.object({
  dataSizeGb: finite(0, 10_000_000),
  // Absent from documents written before version 5.
  readShare: finite(0, 1).default(0.9),
  queryServiceTimeMs: finite(0, 3_600_000),
  maxConcurrentQueries: z.number().int().min(1).max(1_000_000),
  queueLimit: z.number().int().min(0).max(1_000_000),
  queryRequestBytes: finite(0, 1_000_000_000),
  queryResultBytes: finite(0, 1_000_000_000),
});

export const cacheSettingsSchema = z.object({
  lookupServiceTimeMs: finite(0, 3_600_000),
  hitRate: finite(0, 1),
  maxConcurrentLookups: z.number().int().min(1).max(1_000_000),
  capacityGb: finite(0, 1_000_000),
  queueLimit: z.number().int().min(0).max(1_000_000),
  populateOnMiss: z.boolean(),
  populateServiceTimeMs: finite(0, 3_600_000),
  lookupRequestBytes: finite(0, 1_000_000_000),
  lookupResultBytes: finite(0, 1_000_000_000),
  populateBytes: finite(0, 1_000_000_000),
});

const nodeBase = {
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  position: positionSchema,
  cloud: cloudSchema,
};

export const queueSettingsSchema = z.object({
  processingFailureShare: finite(0, 1).default(0),
  maxAttempts: z.number().int().min(1).max(100).default(3),
  retryDelayMs: finite(0, 86400000).default(100),
  maxDepth: z.number().int().min(0).max(1_000_000_000),
  publishServiceTimeMs: finite(0, 3_600_000),
  maxConcurrentPublishes: z.number().int().min(1).max(10_000_000),
  publishQueueLimit: z.number().int().min(0).max(10_000_000),
  messageBytes: finite(0, 1_000_000_000),
});

const share = finite(0, 1);

export const dnsSettingsSchema = z.object({
  lookupServiceTimeMs: finite(0, 3_600_000),
  maxConcurrentLookups: z.number().int().min(1).max(10_000_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
  lookupShare: share,
  queryBytes: finite(0, 1_000_000_000),
  answerBytes: finite(0, 1_000_000_000),
});

export const cdnSettingsSchema = z.object({
  hitRate: share,
  serviceTimeMs: finite(0, 3_600_000),
  maxConcurrentRequests: z.number().int().min(1).max(10_000_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
});

export const wafSettingsSchema = z.object({
  serviceTimeMs: finite(0, 3_600_000),
  maxConcurrentRequests: z.number().int().min(1).max(10_000_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
  blockRate: share,
});

export const apiGatewaySettingsSchema = z.object({
  serviceTimeMs: finite(0, 3_600_000),
  maxConcurrentRequests: z.number().int().min(1).max(10_000_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
  rateLimitPerSecond: finite(0, 100_000_000).nullable(),
  burstCapacity: z.number().int().min(0).max(100_000_000),
});

export const serverlessSettingsSchema = z.object({
  cpuMsPerRequest: finite(0, 3_600_000),
  memoryMb: finite(1, 1_000_000),
  maxConcurrentInvocations: z.number().int().min(1).max(10_000_000),
  coldStartShare: share,
  coldStartMs: finite(0, 3_600_000),
});

export const readReplicaSettingsSchema = z.object({
  queryServiceTimeMs: finite(0, 3_600_000),
  maxConcurrentQueries: z.number().int().min(1).max(1_000_000),
  queueLimit: z.number().int().min(0).max(1_000_000),
  applyServiceTimeMs: finite(0, 3_600_000),
});

export const kvStoreSettingsSchema = z.object({
  readServiceTimeMs: finite(0, 3_600_000),
  writeServiceTimeMs: finite(0, 3_600_000),
  readShare: share,
  maxConcurrentRequests: z.number().int().min(1).max(10_000_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
  itemBytes: finite(0, 1_000_000_000),
  storedGb: finite(0, 10_000_000),
});

export const objectStorageSettingsSchema = z.object({
  getServiceTimeMs: finite(0, 3_600_000),
  putServiceTimeMs: finite(0, 3_600_000),
  writeShare: share,
  objectBytes: finite(0, 1_000_000_000),
  maxConcurrentRequests: z.number().int().min(1).max(10_000_000),
  queueLimit: z.number().int().min(0).max(10_000_000),
  storedGb: finite(0, 100_000_000),
});

export const pubSubSettingsSchema = z.object({
  publishServiceTimeMs: finite(0, 3_600_000),
  maxConcurrentPublishes: z.number().int().min(1).max(10_000_000),
  publishQueueLimit: z.number().int().min(0).max(10_000_000),
  messageBytes: finite(0, 1_000_000_000),
  maxDepth: z.number().int().min(0).max(100_000_000),
});

function supportSettingsSchema<K extends SupportKind>(kind: K): z.ZodType<SupportSettings<K>> {
  const fields = SUPPORT_SERVICES[kind].fields as Record<string, NumericSetting>;
  return z.object(Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.integer ? finite(f.min, f.max).int() : finite(f.min, f.max)]))) as unknown as z.ZodType<SupportSettings<K>>;
}

function chainSettingsSchema<K extends ChainKind>(kind: K): z.ZodType<ChainSettings<K>> {
  const fields = CHAIN_SERVICES[kind].fields as Record<string, NumericSetting>;
  return z.object(Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.integer ? finite(f.min, f.max).int() : finite(f.min, f.max)]))) as unknown as z.ZodType<ChainSettings<K>>;
}

function dataSettingsSchema<K extends DataKind>(kind: K): z.ZodType<DataSettings<K>> {
  const shape = Object.fromEntries(Object.entries(DATA_SERVICES[kind].fields).map(([key, spec]) => {
    const field: NumericSetting = spec;
    let value = z.number().finite().min(field.min).max(field.max);
    if (field.integer) value = value.int();
    return [key, value];
  }));
  return z.object(shape) as unknown as z.ZodType<DataSettings<K>>;
}

type JobSettingsByKind = {
  eventStream: EventStreamSettings; deadLetter: DeadLetterSettings; scheduler: SchedulerSettings; workflow: WorkflowSettings;
};
function jobSettingsSchema<K extends JobKind>(kind: K): z.ZodType<JobSettingsByKind[K]> {
  const shape = Object.fromEntries(Object.entries(JOB_SERVICES[kind].fields).map(([key, field]) => {
    if ('toggle' in field) return [key, z.boolean()];
    if ('options' in field) return [key, z.enum(field.options.map((o) => o.value) as [string, ...string[]])];
    let schema = z.number().finite().min(field.min).max(field.max);
    if (field.integer) schema = schema.int();
    return [key, schema];
  }));
  return z.object(shape) as unknown as z.ZodType<JobSettingsByKind[K]>;
}

export const archNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('eventStream'), settings: jobSettingsSchema('eventStream') }),
  z.object({ ...nodeBase, kind: z.literal('deadLetter'), settings: jobSettingsSchema('deadLetter') }),
  z.object({ ...nodeBase, kind: z.literal('scheduler'), settings: jobSettingsSchema('scheduler') }),
  z.object({ ...nodeBase, kind: z.literal('workflow'), settings: jobSettingsSchema('workflow') }),

  z.object({ ...nodeBase, kind: z.literal('websocket'), settings: supportSettingsSchema('websocket') }),
  z.object({ ...nodeBase, kind: z.literal('notification'), settings: supportSettingsSchema('notification') }),
  z.object({ ...nodeBase, kind: z.literal('identity'), settings: supportSettingsSchema('identity') }),
  z.object({ ...nodeBase, kind: z.literal('rateLimiter'), settings: supportSettingsSchema('rateLimiter') }),
  z.object({ ...nodeBase, kind: z.literal('discovery'), settings: supportSettingsSchema('discovery') }),
  z.object({ ...nodeBase, kind: z.literal('secrets'), settings: supportSettingsSchema('secrets') }),
  z.object({ ...nodeBase, kind: z.literal('monitoring'), settings: supportSettingsSchema('monitoring') }),
  z.object({ ...nodeBase, kind: z.literal('serviceMesh'), settings: supportSettingsSchema('serviceMesh') }),
  z.object({ ...nodeBase, kind: z.literal('lock'), settings: supportSettingsSchema('lock') }),
  z.object({ ...nodeBase, kind: z.literal('wallet'), settings: chainSettingsSchema('wallet') }),
  z.object({ ...nodeBase, kind: z.literal('rpcNode'), settings: chainSettingsSchema('rpcNode') }),
  z.object({ ...nodeBase, kind: z.literal('smartContract'), settings: chainSettingsSchema('smartContract') }),
  z.object({ ...nodeBase, kind: z.literal('indexer'), settings: chainSettingsSchema('indexer') }),
  z.object({ ...nodeBase, kind: z.literal('oracle'), settings: chainSettingsSchema('oracle') }),
  z.object({ ...nodeBase, kind: z.literal('ipfs'), settings: chainSettingsSchema('ipfs') }),
  z.object({ ...nodeBase, kind: z.literal('documentDb'), settings: dataSettingsSchema('documentDb') }),
  z.object({ ...nodeBase, kind: z.literal('wideColumn'), settings: dataSettingsSchema('wideColumn') }),
  z.object({ ...nodeBase, kind: z.literal('searchIndex'), settings: dataSettingsSchema('searchIndex') }),
  z.object({ ...nodeBase, kind: z.literal('warehouse'), settings: dataSettingsSchema('warehouse') }),
  z.object({ ...nodeBase, kind: z.literal('timeSeries'), settings: dataSettingsSchema('timeSeries') }),

  z.object({ ...nodeBase, kind: z.literal('client'), settings: clientSettingsSchema }),
  z.object({
    ...nodeBase,
    kind: z.literal('loadBalancer'),
    settings: loadBalancerSettingsSchema,
  }),
  z.object({ ...nodeBase, kind: z.literal('server'), settings: serverSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('database'), settings: databaseSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('cache'), settings: cacheSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('queue'), settings: queueSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('dns'), settings: dnsSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('cdn'), settings: cdnSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('waf'), settings: wafSettingsSchema }),
  z.object({
    ...nodeBase,
    kind: z.literal('apiGateway'),
    settings: apiGatewaySettingsSchema,
  }),
  z.object({ ...nodeBase, kind: z.literal('serverless'), settings: serverlessSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('readReplica'), settings: readReplicaSettingsSchema }),
  z.object({ ...nodeBase, kind: z.literal('kvStore'), settings: kvStoreSettingsSchema }),
  z.object({
    ...nodeBase,
    kind: z.literal('objectStorage'),
    settings: objectStorageSettingsSchema,
  }),
  z.object({ ...nodeBase, kind: z.literal('pubsub'), settings: pubSubSettingsSchema }),
]);

export const linkSettingsSchema = z.object({
  propagationDelayMs: finite(0, 600_000),
  bandwidthMbps: finite(0.001, 10_000_000),
});

export const archEdgeSchema = z.object({
  id: z.string().min(1).max(160),
  source: z.string().min(1).max(120),
  target: z.string().min(1).max(120),
  settings: linkSettingsSchema,
});

/**
 * Multipliers stop at 0.01 rather than 0. A rate of exactly zero means an
 * infinite wait for the next request, which would end that client's traffic for
 * the rest of the run instead of merely making it slow.
 */
export const arrivalOptionsSchema = z.object({
  rampStartMultiplier: finite(0.01, 1_000),
  rampEndMultiplier: finite(0.01, 1_000),
  burstPeriodSeconds: finite(0.001, 86_400),
  burstDurationSeconds: finite(0, 86_400),
  burstMultiplier: finite(0.01, 1_000),
});

export const workloadSchema = z.object({
  durationSeconds: finite(0.001, 86_400),
  drainSeconds: finite(0, 86_400),
  seed: z.number().int().min(0).max(4_294_967_295),
  arrivalPattern: z.enum(['constant', 'poisson', 'ramp', 'burst']).default('constant'),
  arrivalOptions: arrivalOptionsSchema.default({
    rampStartMultiplier: 0.2,
    rampEndMultiplier: 2,
    burstPeriodSeconds: 5,
    burstDurationSeconds: 1,
    burstMultiplier: 5,
  }),
});

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal number');

export const rateOverridesSchema = z.object({
  compute: decimalString.nullable().optional(),
  storage: decimalString.nullable().optional(),
  egress: decimalString.nullable().optional(),
  requests: decimalString.nullable().optional(),
  writes: decimalString.nullable().optional(),
  duration: decimalString.nullable().optional(),
  scan: decimalString.nullable().optional(),
  ingest: decimalString.nullable().optional(),
  gas: decimalString.nullable().optional(),
});

export const architectureDocumentSchema = z.object({
  schemaVersion: z.number().int().min(1),
  nodes: z.array(archNodeSchema).max(400),
  edges: z.array(archEdgeSchema).max(1200),
  workload: workloadSchema,
  // Older documents were saved before rate editing existed, so this defaults
  // to an empty object rather than failing validation.
  pricingOverrides: z.record(z.string().max(160), rateOverridesSchema).default({}),
});

export const projectSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  document: architectureDocumentSchema,
});

/** The JSON export envelope. Version is separate from the document version. */
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_KIND = 'aparecium.project';

export const exportEnvelopeSchema = z.object({
  kind: z.literal(EXPORT_KIND),
  formatVersion: z.number().int().min(1),
  exportedAt: z.string(),
  appVersion: z.string().max(40),
  project: projectSchema,
  runs: z.array(z.unknown()).max(200).default([]),
});

export type ExportEnvelope = z.infer<typeof exportEnvelopeSchema>;

export interface ParseFailure {
  ok: false;
  message: string;
  details?: string[];
}
export interface ParseSuccess<T> {
  ok: true;
  value: T;
}
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Validate an imported export envelope. Rejects schema versions produced by a
 * newer build of Xparecium rather than guessing at their meaning.
 */
export function parseImport(raw: unknown): ParseResult<ExportEnvelope> {
  const parsed = exportEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return {
      ok: false,
      message: 'This file is not a valid Xparecium project export.',
      details,
    };
  }
  const value = parsed.data;
  if (value.formatVersion > EXPORT_FORMAT_VERSION) {
    return {
      ok: false,
      message: `This file uses export format version ${value.formatVersion}, but this build of Xparecium understands version ${EXPORT_FORMAT_VERSION}. Update Xparecium to open it.`,
    };
  }
  if (value.project.document.schemaVersion > DOCUMENT_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `This project uses document schema version ${value.project.document.schemaVersion}, but this build of Xparecium understands version ${DOCUMENT_SCHEMA_VERSION}. Update Xparecium to open it.`,
    };
  }
  return { ok: true, value };
}
