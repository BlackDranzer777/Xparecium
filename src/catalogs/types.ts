/**
 * Catalog shapes and their runtime validation.
 *
 * Catalogs are versioned static JSON files served by the same static host as
 * the app. They are data, not code: adding a provider profile means editing a
 * JSON file, not touching the pricing engine.
 */
import { z } from 'zod';
import type { ChargeType, ComponentKind, ServerProfileId } from '../domain/types';

export type { ChargeType };

export const CHARGE_LABELS: Record<ChargeType, string> = {
  compute: 'Compute / provisioning',
  storage: 'Provisioned storage',
  egress: 'Outbound data transfer',
  requests: 'Metered requests',
  writes: 'Metered writes',
  duration: 'Metered compute time',
  scan: 'Data scanned',
  ingest: 'Data ingested',
  gas: 'Gas',
};

/**
 * `amount: null` means "this charge applies but Xparecium has no rate for it".
 * A charge that is simply absent from the object does not apply at all.
 * Neither case is ever treated as zero.
 */
export const chargeSchema = z.object({
  unit: z.string().min(1).max(40),
  amount: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  note: z.string().max(400).optional(),
  /**
   * How many billed units one counted operation costs. Defaults to 1. A
   * message queue is the case: the engine counts one message, and AWS bills
   * send, receive and delete as three requests, so the profile says 3. Kept on
   * the charge rather than in the engine because it is the provider's rule.
   */
  unitsPerOperation: z.number().int().min(1).max(100).optional(),
});

export const cloudProfileSchema = z.object({
  id: z.string().min(1).max(160),
  provider: z.string().min(1).max(60),
  providerName: z.string().min(1).max(120),
  region: z.string().min(1).max(60),
  regionName: z.string().min(1).max(120),
  appliesTo: z
    .array(
      z.enum([
        'client', 'dns', 'cdn', 'waf', 'apiGateway',
        'loadBalancer', 'server', 'serverless',
        'database', 'readReplica', 'kvStore', 'objectStorage', 'cache',
        'queue', 'pubsub', 'documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries', 'eventStream', 'deadLetter', 'scheduler', 'websocket', 'notification', 'identity', 'rateLimiter', 'discovery', 'secrets', 'monitoring', 'serviceMesh', 'lock', 'workflow',
        'wallet', 'rpcNode', 'smartContract', 'indexer', 'oracle', 'ipfs',
      ]),
    )
    .min(1),
  /**
   * Which Resource profile this machine stands for, when it stands for one.
   *
   * This is what keeps performance and cost describing the same choice: pick
   * Large on the canvas and the cost follows, within the provider and region
   * already chosen. Absent means the profile is size-agnostic — self-managed
   * hardware is one entry whatever size you call it — and such a profile is
   * left alone when the size changes.
   *
   * The mapping is a judgement recorded in the catalog, not arithmetic. A
   * simulated CPU slot is a stand-in for usable compute capacity and is not a
   * physical core, so nothing here can be derived from the numbers.
   */
  sizeClass: z.enum(['small', 'medium', 'large', 'xlarge']).optional(),
  label: z.string().min(1).max(160),
  description: z.string().max(400),
  verified: z.boolean(),
  priceSourceUrl: z.string().max(400),
  priceCheckedAt: z.string().max(40),
  priceNote: z.string().max(1000),
  charges: z.object({
    compute: chargeSchema.optional(),
    storage: chargeSchema.optional(),
    egress: chargeSchema.optional(),
    requests: chargeSchema.optional(),
    writes: chargeSchema.optional(),
    duration: chargeSchema.optional(),
    scan: chargeSchema.optional(),
    ingest: chargeSchema.optional(),
    gas: chargeSchema.optional(),
  }),
});

export const cloudCatalogSchema = z.object({
  catalogId: z.literal('cloud-profiles'),
  version: z.number().int().min(1),
  currency: z.string().min(1).max(10),
  publishedAt: z.string().max(40),
  notice: z.string().max(4000),
  profiles: z.array(cloudProfileSchema).max(500),
});

export const hardwareProfileSchema = z.object({
  id: z.enum(['small', 'medium', 'large', 'xlarge']),
  label: z.string().min(1).max(60),
  description: z.string().max(200),
  cpuSlots: z.number().int().min(1).max(4096),
  ramMb: z.number().min(1).max(100_000_000),
  baselineMemoryMb: z.number().min(0).max(100_000_000),
  suggestedCloudProfileId: z.string().max(160),
});

export const hardwareCatalogSchema = z.object({
  catalogId: z.literal('hardware'),
  version: z.number().int().min(1),
  publishedAt: z.string().max(40),
  notice: z.string().max(4000),
  profiles: z.array(hardwareProfileSchema).max(50),
});

export type CloudProfile = z.infer<typeof cloudProfileSchema>;
export type CloudCatalog = z.infer<typeof cloudCatalogSchema>;
export type HardwareCatalog = z.infer<typeof hardwareCatalogSchema>;
export type Charge = z.infer<typeof chargeSchema>;

export const CLOUD_CATALOG_SUPPORTED_VERSION = 1;
export const HARDWARE_CATALOG_SUPPORTED_VERSION = 1;

export function profilesFor(catalog: CloudCatalog, kind: ComponentKind): CloudProfile[] {
  return catalog.profiles.filter((p) => p.appliesTo.includes(kind));
}

export function findProfile(catalog: CloudCatalog, id: string | null): CloudProfile | null {
  if (!id) return null;
  return catalog.profiles.find((p) => p.id === id) ?? null;
}

/** What a change of Resource profile should do to the cloud profile. */
export type CloudProfileMatch =
  | { outcome: 'matched'; profile: CloudProfile }
  | { outcome: 'keep' }
  | { outcome: 'none' };

/**
 * The cloud profile that goes with a hardware size, for a machine already
 * assigned to a provider and region.
 *
 * Three answers, and the difference between them matters:
 *
 *   - `matched`  — the same provider and region has a machine of that size.
 *   - `keep`     — the current profile does not describe a size at all, so a
 *                  size change says nothing about it. Self-managed hardware is
 *                  the case: one entry, whatever size you call it.
 *   - `none`     — this provider and region has nothing of that size. The
 *                  caller must not leave the old price in place; it would be a
 *                  price for a machine that is no longer selected.
 *
 * The provider and region are never crossed. Moving somebody from AWS to Google
 * because Google happened to have the right size would be a bigger decision
 * than the one they made.
 */
/** The two numbers a machine is sized by, in the simulation's own units. */
export interface HardwareSize {
  id: Exclude<ServerProfileId, 'custom'>;
  cpuSlots: number;
  ramMb: number;
}

/**
 * The cloud profile for hardware somebody typed in by hand.
 *
 * Custom hardware has no size class of its own, so it is priced as the
 * *smallest* catalogued machine — same provider, same region — that has at
 * least as many CPU slots and at least as much memory. That is how a person
 * picks an instance: the cheapest one that fits. When nothing fits, the answer
 * is `none` and the component reports as unpriced, because the alternatives are
 * to keep the price of whatever machine it used to be, or to make a number up
 * by scaling a rate — and a scaled placeholder rate is an invented price in the
 * shape of a real one.
 *
 * Both comparisons are in CPU slots and megabytes as the simulation defines
 * them, against the hardware catalog's own sizes. Nothing here treats a slot
 * as a core.
 */
export type HardwareMatch = CloudProfileMatch & {
  /** The catalogued size the price was taken from. */
  fitted?: HardwareSize;
  /**
   * True when the hardware is bigger than anything catalogued, so the price is
   * that of the largest machine available and the real charge is *at least*
   * this. Never silently: the estimate says so on the line and in its warnings.
   */
  floor?: boolean;
};

export function serverProfileForHardware(
  catalog: CloudCatalog,
  sizes: readonly HardwareSize[],
  currentProfileId: string | null,
  cpuSlots: number,
  ramMb: number,
): HardwareMatch {
  const current = findProfile(catalog, currentProfileId);
  if (!current) return { outcome: 'none' };
  if (current.sizeClass === undefined) return { outcome: 'keep' };

  const ascending = [...sizes].sort((a, b) => a.cpuSlots - b.cpuSlots || a.ramMb - b.ramMb);

  for (const size of ascending) {
    if (size.cpuSlots < cpuSlots || size.ramMb < ramMb) continue;
    const match = serverProfileForSize(catalog, currentProfileId, size.id);
    if (match.outcome === 'matched') return { ...match, fitted: size };
  }

  // Nothing is big enough. Reporting it as unpriced would drop the line from
  // the total, and a bigger machine would then look cheaper — the same wrong
  // direction the whole feature exists to prevent. The largest machine this
  // provider offers is a true lower bound on what this one costs, so that is
  // what it is priced as, marked as a floor.
  for (const size of [...ascending].reverse()) {
    const match = serverProfileForSize(catalog, currentProfileId, size.id);
    if (match.outcome === 'matched') return { ...match, fitted: size, floor: true };
  }
  return { outcome: 'none' };
}

export function serverProfileForSize(
  catalog: CloudCatalog,
  currentProfileId: string | null,
  size: Exclude<ServerProfileId, 'custom'>,
): CloudProfileMatch {
  const current = findProfile(catalog, currentProfileId);
  if (!current) return { outcome: 'none' };
  if (current.sizeClass === undefined) return { outcome: 'keep' };
  if (current.sizeClass === size) return { outcome: 'matched', profile: current };

  const match = catalog.profiles.find(
    (p) =>
      p.appliesTo.includes('server') &&
      p.sizeClass === size &&
      p.provider === current.provider &&
      p.region === current.region,
  );
  return match ? { outcome: 'matched', profile: match } : { outcome: 'none' };
}
