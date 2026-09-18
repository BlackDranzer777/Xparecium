import { isDataKind } from '../domain/data-services';
import type { DataServiceNode } from '../domain/data-services';
/**
 * The pricing engine.
 *
 * Deliberately separate from the event engine. It takes three inputs:
 *   1. the provisioned resources (from the architecture document),
 *   2. a usage ledger (from a completed run, or nothing at all),
 *   3. a catalog of rates,
 * and produces a monthly estimate with every line item explained.
 *
 * Rules it follows without exception:
 *   - Money is Decimal, never a binary float.
 *   - A missing rate is "unpriced". It is never treated as zero.
 *   - Fixed provisioning costs do not depend on traffic, so an idle component
 *     still costs money.
 *   - Variable projections are derived from a measured *rate* over the run's
 *     measured interval, never by multiplying a short run's total by some
 *     arbitrary factor.
 */
import Decimal from 'decimal.js';
import type {
  ArchitectureDocument,
  ChargeType,
  ComponentKind,
  RateOverrides,
} from '../domain/types';
import { HOURS_PER_MONTH } from '../domain/units';
import { SERVER_HARDWARE_PROFILES } from '../domain/defaults';
import { CHARGE_LABELS, findProfile } from '../catalogs/types';
import type { Charge, CloudCatalog, CloudProfile, HardwareSize } from '../catalogs/types';
import type { UsageLedger } from '../simulation/types';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

const BYTES_PER_GB = new Decimal(1_000_000_000);

export interface CostLine {
  key: string;
  nodeId: string;
  nodeName: string;
  componentKind: ComponentKind;
  profileId: string | null;
  profileLabel: string;
  chargeType: ChargeType;
  chargeLabel: string;
  /** Plain-English explanation of how the quantity was arrived at. */
  basis: string;
  quantity: string;
  quantityUnit: string;
  rate: string | null;
  rateUnit: string;
  monthly: string | null;
  unpriced: boolean;
  unpricedReason: string | null;
  verified: boolean;
  sourceUrl: string;
  sourceCheckedAt: string;
  edited: boolean;
}

export interface CostEstimate {
  currency: string;
  lines: CostLine[];
  /** Sum of the priced lines only, rounded to two decimal places. */
  totalMonthly: string;
  pricedLineCount: number;
  unpricedLineCount: number;
  hoursPerMonth: number;
  hasRun: boolean;
  hasIllustrativeRates: boolean;
  projectionNote: string;
  included: string[];
  excluded: string[];
  warnings: string[];
  catalogPublishedAt: string;
}

export interface PricingInput {
  document: ArchitectureDocument;
  catalog: CloudCatalog;
  /** The usage ledger from a run, or null if the design has not been run yet. */
  usage: UsageLedger | null;
  hoursPerMonth?: number;
  /**
   * The catalogued hardware sizes, used only to notice when custom hardware is
   * bigger than the machine it is priced as. Defaults to the built-in sizes.
   */
  hardwareSizes?: readonly HardwareSize[];
}

/**
 * Whether a server's price is a floor: custom hardware bigger than anything
 * catalogued, priced as the largest machine there is. The charge is real and
 * the real charge is higher; both facts go on the line.
 */
function isPriceFloor(
  node: ArchitectureDocument['nodes'][number],
  profile: CloudProfile,
  sizes: readonly HardwareSize[],
): boolean {
  if (node.kind !== 'server' || node.settings.profile !== 'custom') return false;
  if (profile.sizeClass === undefined) return false;
  const size = sizes.find((s) => s.id === profile.sizeClass);
  if (!size) return false;
  return node.settings.cpuSlots > size.cpuSlots || node.settings.ramMb > size.ramMb;
}

interface EffectiveCharge {
  unit: string;
  amount: string | null;
  note?: string;
  /** Billed units per counted operation; see `chargeSchema`. */
  unitsPerOperation?: number;
  edited: boolean;
}

/** Apply the user's rate edits, if any, on top of the catalog rate. */
export function effectiveCharge(
  profile: CloudProfile,
  chargeType: ChargeType,
  overrides: Record<string, RateOverrides> | undefined,
): EffectiveCharge | null {
  const base: Charge | undefined = profile.charges[chargeType];
  if (!base) return null; // This charge does not apply to this profile at all.
  const override = overrides?.[profile.id]?.[chargeType];
  if (override !== undefined) {
    const result: EffectiveCharge = { unit: base.unit, amount: override, edited: true };
    if (base.note !== undefined) result.note = base.note;
    if (base.unitsPerOperation !== undefined) result.unitsPerOperation = base.unitsPerOperation;
    return result;
  }
  const result: EffectiveCharge = { unit: base.unit, amount: base.amount, edited: false };
  if (base.note !== undefined) result.note = base.note;
  if (base.unitsPerOperation !== undefined) result.unitsPerOperation = base.unitsPerOperation;
  return result;
}

function line(params: Omit<CostLine, 'monthly' | 'unpriced'> & { monthly: Decimal | null }): CostLine {
  return {
    ...params,
    verified: params.verified && !params.edited,
    monthly: params.monthly ? params.monthly.toFixed(2) : null,
    unpriced: params.monthly === null,
  };
}

export function estimateCost(input: PricingInput): CostEstimate {
  const { document, catalog, usage } = input;
  const hoursPerMonth = input.hoursPerMonth ?? HOURS_PER_MONTH;
  const hardwareSizes = input.hardwareSizes ?? SERVER_HARDWARE_PROFILES;
  const overrides = document.pricingOverrides;
  const lines: CostLine[] = [];
  const warnings: string[] = [];
  let total = new Decimal(0);
  let hasIllustrative = false;

  for (const node of document.nodes) {
    // Clients are the people using the system, not something you provision.
    if (node.kind === 'client') continue;

    const profile = findProfile(catalog, node.cloud.profileId);
    if (!profile) {
      lines.push(
        line({
          key: `${node.id}:none`,
          nodeId: node.id,
          nodeName: node.name,
          componentKind: node.kind,
          profileId: null,
          profileLabel: 'No cloud profile selected',
          chargeType: 'compute',
          chargeLabel: CHARGE_LABELS.compute,
          basis: 'This component has no cloud profile, so Aparecium has no rates for it.',
          quantity: '1',
          quantityUnit: 'component',
          rate: null,
          rateUnit: '',
          monthly: null,
          unpricedReason: 'No cloud profile is selected for this component.',
          verified: false,
          sourceUrl: '',
          sourceCheckedAt: '',
          edited: false,
        }),
      );
      continue;
    }
    // Whether priced lines are illustrative is determined after applying edits.

    const common = {
      nodeId: node.id,
      nodeName: node.name,
      componentKind: node.kind,
      profileId: profile.id,
      profileLabel: profile.label,
      verified: profile.verified,
      sourceUrl: profile.priceSourceUrl,
      sourceCheckedAt: profile.priceCheckedAt,
    };

    // ---- Compute / provisioning: fixed, independent of traffic ------------
    const compute = effectiveCharge(profile, 'compute', overrides);
    if (compute) {
      const hours = new Decimal(hoursPerMonth);
      const monthly = compute.amount === null ? null : new Decimal(compute.amount).times(hours);
      if (monthly) total = total.plus(monthly);
      const floor = isPriceFloor(node, profile, hardwareSizes);
      if (floor && node.kind === 'server') {
        warnings.push(
          `"${node.name}" has ${node.settings.cpuSlots} CPU slots and ${node.settings.ramMb} MB, which is more than any machine in this catalog. Its compute charge is that of the largest one available and is a floor: the real charge is higher.`,
        );
      }
      lines.push(
        line({
          ...common,
          key: `${node.id}:compute`,
          chargeType: 'compute',
          chargeLabel: CHARGE_LABELS.compute,
          basis: floor
            ? `1 instance running for all ${hoursPerMonth} hours of the month, priced as the largest machine this provider has in the catalog. The hardware configured here is bigger than that machine, so this is a floor — the real charge is at least this much.`
            : `1 instance running for all ${hoursPerMonth} hours of the month. This charge does not depend on how much traffic the component handled.`,
          quantity: hours.toFixed(0),
          quantityUnit: compute.unit,
          rate: compute.amount,
          rateUnit: `${catalog.currency} per ${compute.unit}`,
          monthly,
          unpricedReason:
            compute.amount === null
              ? (compute.note ?? 'Aparecium has no rate for this charge.')
              : null,
          edited: compute.edited,
        }),
      );
    }

    // ---- Provisioned storage: fixed, from the component's own settings ----
    const storage = effectiveCharge(profile, 'storage', overrides);
    if (storage) {
      let gb: Decimal | null = null;
      let basis = '';
      if (node.kind === 'monitoring') {
        gb = new Decimal(node.settings.maxRecords).mul(node.settings.recordBytes).div(1e9); basis = 'Configured telemetry capacity in GB; payload only.';
      } else if (node.kind === 'eventStream' || node.kind === 'deadLetter') {
        gb = new Decimal(node.settings.maxDepth).mul(node.settings.messageBytes).div(1e9); basis = 'Configured capacity in GB; retained payload only.';
      } else if (isDataKind(node.kind)) {
        gb = new Decimal((node as DataServiceNode).settings.storedGb);
        basis = `${gb} GB provisioned for the whole month.`;
      } else if (node.kind === 'database') {
        gb = new Decimal(node.settings.dataSizeGb);
        basis = `${node.settings.dataSizeGb} GB of stored data, charged for the whole month whether or not it is queried.`;
      } else if (node.kind === 'cache') {
        gb = new Decimal(node.settings.capacityGb);
        basis = `${node.settings.capacityGb} GB of provisioned cache capacity, charged for the whole month.`;
      } else if (node.kind === 'kvStore' || node.kind === 'objectStorage') {
        gb = new Decimal(node.settings.storedGb);
        basis = `${node.settings.storedGb} GB of stored data, charged for the whole month whether or not it is touched.`;
      } else if (node.kind === 'readReplica') {
        // A replica keeps a full copy of the database it replicates from.
        const sourceEdge = document.edges.find((e) => e.target === node.id);
        const source = sourceEdge
          ? document.nodes.find((n) => n.id === sourceEdge.source && n.kind === 'database')
          : undefined;
        if (source && source.kind === 'database') {
          gb = new Decimal(source.settings.dataSizeGb);
          basis = `A full copy of "${source.name}": ${source.settings.dataSizeGb} GB, charged for the whole month.`;
        }
      }
      if (gb !== null) {
        const monthly = storage.amount === null ? null : new Decimal(storage.amount).times(gb);
        if (monthly) total = total.plus(monthly);
        lines.push(
          line({
            ...common,
            key: `${node.id}:storage`,
            chargeType: 'storage',
            chargeLabel: CHARGE_LABELS.storage,
            basis,
            quantity: gb.toFixed(2),
            quantityUnit: storage.unit,
            rate: storage.amount,
            rateUnit: `${catalog.currency} per ${storage.unit}`,
            monthly,
            unpricedReason:
              storage.amount === null
                ? (storage.note ?? 'Aparecium has no rate for this charge.')
                : null,
            edited: storage.edited,
          }),
        );
      }
    }

    // ---- Metered requests: variable, projected from a measured rate -------
    // A message queue has nothing to provision: the whole bill is what went
    // through it. Like transfer, the monthly figure scales the rate the run
    // measured, never the run's own total.
    const metered = effectiveCharge(profile, 'requests', overrides);
    const meteredWrites = effectiveCharge(profile, 'writes', overrides);
    if (metered) {
      // A store that bills writes on their own line bills reads here.
      const handled = usage?.requestsByNodeId[node.id] ?? 0;
      const writtenOps = usage?.writesByNodeId[node.id] ?? 0;
      const operations = meteredWrites ? Math.max(0, handled - writtenOps) : handled;
      const what =
        node.kind === 'queue' || node.kind === 'pubsub'
          ? 'messages'
          : node.kind === 'serverless'
            ? 'invocations'
            : meteredWrites
              ? 'reads'
              : 'requests';
      // The engine counts messages; the provider bills API calls. AWS charges
      // send, receive and delete separately, so one message is three requests.
      // The catalog states the multiplier because it is the provider's rule.
      const perOperation = metered.unitsPerOperation ?? 1;
      const count = operations * perOperation;
      if (!usage || usage.measuredSeconds <= 0) {
        warnings.push(
          `Metered requests for "${node.name}" are not included: they are measured from a simulation run, and this design has not been run yet.`,
        );
      } else {
        const perSecond = new Decimal(count).div(usage.measuredSeconds);
        const perMonth = perSecond.times(hoursPerMonth).times(3600);
        const millions = perMonth.div(1_000_000);
        const monthly = metered.amount === null ? null : new Decimal(metered.amount).times(millions);
        if (monthly) total = total.plus(monthly);
        lines.push(
          line({
            ...common,
            key: `${node.id}:requests`,
            chargeType: 'requests',
            chargeLabel: CHARGE_LABELS.requests,
            basis:
              perOperation > 1
                ? `The run measured ${operations} ${what} through this component over ${usage.measuredSeconds.toFixed(2)} seconds. The provider bills ${perOperation} requests per ${what.replace(/s$/, '')} (${metered.note ?? 'send, receive and acknowledge are separate calls'}), so that is ${count} billed requests, or ${perSecond.toFixed(3)} per second, assumed to continue for every second of a ${hoursPerMonth}-hour month.`
                : `The run measured ${operations} ${what} through this component over ${usage.measuredSeconds.toFixed(2)} seconds, which is ${perSecond.toFixed(3)} per second. That rate is assumed to continue for every second of a ${hoursPerMonth}-hour month.`,
            quantity: millions.toFixed(4),
            quantityUnit: metered.unit,
            rate: metered.amount,
            rateUnit: `${catalog.currency} per ${metered.unit}`,
            monthly,
            unpricedReason:
              metered.amount === null
                ? (metered.note ?? 'Aparecium has no rate for this charge.')
                : null,
            edited: metered.edited,
          }),
        );
      }
    }

    // ---- Metered writes: the same projection, for stores that bill them apart
    if (meteredWrites) {
      const writtenOps = usage?.writesByNodeId[node.id] ?? 0;
      if (!usage || usage.measuredSeconds <= 0) {
        warnings.push(
          `Metered writes for "${node.name}" are not included: they are measured from a simulation run, and this design has not been run yet.`,
        );
      } else {
        const perSecond = new Decimal(writtenOps).div(usage.measuredSeconds);
        const millions = perSecond.times(hoursPerMonth).times(3600).div(1_000_000);
        const monthly =
          meteredWrites.amount === null ? null : new Decimal(meteredWrites.amount).times(millions);
        if (monthly) total = total.plus(monthly);
        lines.push(
          line({
            ...common,
            key: `${node.id}:writes`,
            chargeType: 'writes',
            chargeLabel: CHARGE_LABELS.writes,
            basis: `The run measured ${writtenOps} writes to this component over ${usage.measuredSeconds.toFixed(2)} seconds, which is ${perSecond.toFixed(3)} per second. That rate is assumed to continue for every second of a ${hoursPerMonth}-hour month. Writes are billed at their own rate, apart from reads.`,
            quantity: millions.toFixed(4),
            quantityUnit: meteredWrites.unit,
            rate: meteredWrites.amount,
            rateUnit: `${catalog.currency} per ${meteredWrites.unit}`,
            monthly,
            unpricedReason:
              meteredWrites.amount === null
                ? (meteredWrites.note ?? 'Aparecium has no rate for this charge.')
                : null,
            edited: meteredWrites.edited,
          }),
        );
      }
    }

    // ---- Metered compute time: gigabyte-seconds an invocation was alive ------
    // A function is billed for wall-clock time, waiting on a database
    // included, times the memory allotted to it. Nothing is provisioned.
    const duration = effectiveCharge(profile, 'duration', overrides);
    if (duration) {
      const busyMs = usage?.busyMsByNodeId[node.id] ?? 0;
      const memoryGb = node.kind === 'serverless' ? node.settings.memoryMb / 1024 : 0;
      if (!usage || usage.measuredSeconds <= 0) {
        warnings.push(
          `Compute time for "${node.name}" is not included: it is measured from a simulation run, and this design has not been run yet.`,
        );
      } else {
        const gbSecondsMeasured = new Decimal(busyMs).div(1000).times(memoryGb);
        const gbSecondsPerMonth = gbSecondsMeasured.div(usage.measuredSeconds).times(hoursPerMonth).times(3600);
        const monthly = duration.amount === null ? null : new Decimal(duration.amount).times(gbSecondsPerMonth);
        if (monthly) total = total.plus(monthly);
        lines.push(
          line({
            ...common,
            key: `${node.id}:duration`,
            chargeType: 'duration',
            chargeLabel: CHARGE_LABELS.duration,
            basis: `Invocations were alive for ${(busyMs / 1000).toFixed(2)} seconds in total over the ${usage.measuredSeconds.toFixed(2)} seconds measured — the time billed, waiting on stores included — at ${node.kind === 'serverless' ? node.settings.memoryMb : 0} MB each, which is ${gbSecondsMeasured.toFixed(3)} GB-seconds. That rate is assumed to continue for every second of a ${hoursPerMonth}-hour month.`,
            quantity: gbSecondsPerMonth.toFixed(2),
            quantityUnit: duration.unit,
            rate: duration.amount,
            rateUnit: `${catalog.currency} per ${duration.unit}`,
            monthly,
            unpricedReason:
              duration.amount === null
                ? (duration.note ?? 'Aparecium has no rate for this charge.')
                : null,
            edited: duration.edited,
          }),
        );
      }
    }

    const scan = effectiveCharge(profile, 'scan', overrides);
    if (scan) {
      const measured = usage?.measuredSeconds ?? 0;
      const gb = measured > 0 ? new Decimal(usage?.scannedGbByNodeId?.[node.id] ?? 0).div(measured).times(hoursPerMonth).times(3600) : new Decimal(0);
      const monthly = scan.amount === null || measured <= 0 ? null : gb.times(scan.amount);
      if (monthly) total = total.plus(monthly);
      lines.push(line({ ...common, key: `${node.id}:scan`, chargeType: 'scan', chargeLabel: CHARGE_LABELS.scan,
        basis: 'Measured GB scanned per second projected over the month. This uses an editable flat rate; provider tiers and discounts are not modeled.',
        quantity: gb.toFixed(6), quantityUnit: scan.unit, rate: scan.amount, rateUnit: `${catalog.currency} per ${scan.unit}`,
        monthly, unpricedReason: measured <= 0 ? 'Run the simulation to measure scan volume.' : scan.amount === null ? 'No scan rate is available.' : null, edited: scan.edited }));
    }

    // ---- Outbound transfer: variable, projected from a measured rate ------
    const egress = effectiveCharge(profile, 'egress', overrides);
    if (egress) {
      if (!usage || usage.measuredSeconds <= 0) {
        warnings.push(
          `Outbound data transfer for "${node.name}" is not included: it is measured from a simulation run, and this design has not been run yet.`,
        );
      } else {
        const bytes = new Decimal(usage.egressByNodeId[node.id] ?? 0);
        const bytesPerSecond = bytes.div(usage.measuredSeconds);
        const gbPerMonth = bytesPerSecond.times(hoursPerMonth).times(3600).div(BYTES_PER_GB);
        const monthly = egress.amount === null ? null : new Decimal(egress.amount).times(gbPerMonth);
        if (monthly) total = total.plus(monthly);
        lines.push(
          line({
            ...common,
            key: `${node.id}:egress`,
            chargeType: 'egress',
            chargeLabel: CHARGE_LABELS.egress,
            basis: `The run measured ${bytes.toFixed(0)} bytes leaving this component towards clients over ${usage.measuredSeconds.toFixed(2)} seconds, which is ${bytesPerSecond.div(1_000_000).toFixed(3)} MB per second. That rate is assumed to continue for every second of a ${hoursPerMonth}-hour month.`,
            quantity: gbPerMonth.toFixed(3),
            quantityUnit: egress.unit,
            rate: egress.amount,
            rateUnit: `${catalog.currency} per ${egress.unit}`,
            monthly,
            unpricedReason:
              egress.amount === null
                ? (egress.note ?? 'Aparecium has no rate for this charge.')
                : null,
            edited: egress.edited,
          }),
        );
      }
    }
  }

  hasIllustrative = lines.some((l) => !l.unpriced && !l.verified && !l.edited);
  const unpricedLineCount = lines.filter((l) => l.unpriced).length;
  if (unpricedLineCount > 0) {
    warnings.push(
      `${unpricedLineCount} charge${unpricedLineCount === 1 ? ' is' : 's are'} unpriced and therefore excluded from the total. Unpriced does not mean free.`,
    );
  }
  if (hasIllustrative) {
    warnings.push(
      'This estimate uses illustrative placeholder rates, not quoted provider prices. Check each profile against its source and edit the rate before relying on the number.',
    );
  }

  return {
    currency: catalog.currency,
    lines,
    totalMonthly: total.toFixed(2),
    pricedLineCount: lines.length - unpricedLineCount,
    unpricedLineCount,
    hoursPerMonth,
    hasRun: usage !== null && usage.measuredSeconds > 0,
    hasIllustrativeRates: hasIllustrative,
    projectionNote:
      usage && usage.measuredSeconds > 0
        ? `Traffic-based charges project request, compute-time and transfer rates measured over ${usage.measuredSeconds.toFixed(2)} seconds into a full ${hoursPerMonth}-hour month. This is an estimate using the catalog's billing assumptions, not a provider quote.`
        : 'No run has been used for this estimate, so only fixed provisioning charges are included.',
    included: [
      'Fixed compute or provisioning charges for every component that has a cloud profile, for the whole month.',
      'Configured storage for databases, drawn read replicas, key-value stores, object storage and caches, for the whole month.',
      'Catalog-priced requests, reads, writes and serverless compute time measured by the simulation.',
      'Outbound data transfer from a component towards a client, projected from the measured rate in the run.',
    ],
    excluded: [
      'Storage input/output charges, provisioned IOPS and throughput.',
      'Backups, snapshots, and point-in-time recovery.',
      'Load balancer capacity units and processed-data charges: only the hourly rate is modelled.',
      'NAT gateways, public IPv4 addresses, DNS hosted-zone fees and WAF rule fees.',
      'Cross-zone and cross-region traffic; traffic between components inside the system.',
      'Additional high availability replicas and multi-zone deployments that are not drawn.',
      'Reserved instances, savings plans, committed-use discounts, spot pricing and free tiers.',
      'Support plans, licences, taxes and currency conversion.',
      'Anything the architecture does not contain: Aparecium prices what you drew, nothing else.',
    ],
    warnings,
    catalogPublishedAt: catalog.publishedAt,
  };
}
