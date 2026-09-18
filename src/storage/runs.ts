/**
 * Building the immutable record of a run.
 *
 * The whole point of this file is the deep copy. A run is evidence of what
 * happened to a particular design at a particular moment; if it kept a
 * reference to the live document, editing the canvas afterwards would silently
 * rewrite history.
 */
import { newId } from '../domain/ids';
import type { ArchitectureDocument } from '../domain/types';
import type { CloudCatalog } from '../catalogs/types';
import type { SimulationResult } from '../simulation/types';
import type { CostEstimate } from '../pricing/pricing';
import { STORAGE_SCHEMA_VERSION } from './db';
import type { CatalogSnapshot, RunRecord } from './db';

/** structuredClone where available, JSON round-trip otherwise. */
export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Keep only the catalog rows this document actually referenced. */
export function snapshotCatalog(
  catalog: CloudCatalog,
  document: ArchitectureDocument,
): CatalogSnapshot {
  const used = new Set(
    document.nodes.map((n) => n.cloud.profileId).filter((id): id is string => Boolean(id)),
  );
  return {
    catalogId: catalog.catalogId,
    version: catalog.version,
    publishedAt: catalog.publishedAt,
    currency: catalog.currency,
    profiles: deepClone(catalog.profiles.filter((p) => used.has(p.id))),
  };
}

export function createRunRecord(params: {
  projectId: string;
  label: string;
  automatic?: boolean;
  document: ArchitectureDocument;
  catalog: CloudCatalog;
  result: SimulationResult;
  cost: CostEstimate;
}): RunRecord {
  return {
    id: newId('run'),
    projectId: params.projectId,
    createdAt: Date.now(),
    label: params.label,
    automatic: params.automatic ?? false,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    engineVersion: params.result.engineVersion,
    seed: params.result.seed,
    inputDocument: deepClone(params.document),
    catalogSnapshot: snapshotCatalog(params.catalog, params.document),
    result: deepClone(params.result),
    cost: deepClone(params.cost),
  };
}

export interface InputDifference {
  label: string;
  before: string;
  after: string;
  /** Differences that make the comparison less controlled. */
  weakensComparison: boolean;
}

/** Ignore object property order, but preserve array order and every document value. */
export function sameDocument(a: ArchitectureDocument, b: ArchitectureDocument): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y))
        .map(([key, child]) => [key, canonical(child)]));
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function formatValue(value: unknown): string {
  if (value === null) return 'not set';
  if (typeof value === 'number') return String(Number(value.toFixed(6)));
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/**
 * Compare the inputs of two runs and say what changed.
 *
 * Workload changes (rate, duration, seed) are flagged separately because they
 * make a before/after comparison less controlled: a different seed or a
 * different duration is not the same experiment.
 */
export function diffRunInputs(before: RunRecord, after: RunRecord): InputDifference[] {
  const differences: InputDifference[] = [];
  const a = before.inputDocument;
  const b = after.inputDocument;

  for (const profile of new Set([...Object.keys(a.pricingOverrides), ...Object.keys(b.pricingOverrides)])) {
    for (const charge of ['compute', 'storage', 'egress', 'requests', 'writes', 'duration', 'scan', 'ingest'] as const) {
      const previous = a.pricingOverrides[profile]?.[charge];
      const next = b.pricingOverrides[profile]?.[charge];
      if (previous !== next) differences.push({ label: `Billing rate ${profile}: ${charge}`,
        before: previous === undefined ? 'catalog rate' : formatValue(previous),
        after: next === undefined ? 'catalog rate' : formatValue(next), weakensComparison: false });
    }
  }

  const workloadKeys = ['durationSeconds', 'drainSeconds', 'seed', 'arrivalPattern'] as const;
  for (const key of workloadKeys) {
    if (a.workload[key] !== b.workload[key]) {
      differences.push({
        label: `Workload: ${key}`,
        before: formatValue(a.workload[key]),
        after: formatValue(b.workload[key]),
        weakensComparison: true,
      });
    }
  }

  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));

  for (const [id, node] of bNodes) {
    const previous = aNodes.get(id);
    if (!previous) {
      differences.push({
        label: `Added ${node.kind}`,
        before: 'not present',
        after: node.name,
        weakensComparison: false,
      });
      continue;
    }
    if (previous.name !== node.name) {
      differences.push({
        label: `Renamed component`,
        before: previous.name,
        after: node.name,
        weakensComparison: false,
      });
    }
    if (previous.cloud.profileId !== node.cloud.profileId) {
      differences.push({
        label: `${node.name}: cloud profile`,
        before: formatValue(previous.cloud.profileId),
        after: formatValue(node.cloud.profileId),
        weakensComparison: false,
      });
    }
    const prevSettings = previous.settings as unknown as Record<string, unknown>;
    const nextSettings = node.settings as unknown as Record<string, unknown>;
    for (const key of Object.keys(nextSettings)) {
      if (prevSettings[key] !== nextSettings[key]) {
        const isTraffic = node.kind === 'client';
        differences.push({
          label: `${node.name}: ${key}`,
          before: formatValue(prevSettings[key]),
          after: formatValue(nextSettings[key]),
          weakensComparison: isTraffic,
        });
      }
    }
  }

  for (const [id, node] of aNodes) {
    if (!bNodes.has(id)) {
      differences.push({
        label: `Removed ${node.kind}`,
        before: node.name,
        after: 'not present',
        weakensComparison: false,
      });
    }
  }

  const aEdges = new Map(a.edges.map((e) => [e.id, e]));
  const bEdges = new Map(b.edges.map((e) => [e.id, e]));
  for (const [id, edge] of bEdges) {
    const previous = aEdges.get(id);
    if (!previous) {
      differences.push({
        label: 'Added connection',
        before: 'not present',
        after: `${edge.source} to ${edge.target}`,
        weakensComparison: false,
      });
      continue;
    }
    if (previous.settings.bandwidthMbps !== edge.settings.bandwidthMbps) {
      differences.push({
        label: `Connection ${edge.source} to ${edge.target}: bandwidth (Mbps)`,
        before: formatValue(previous.settings.bandwidthMbps),
        after: formatValue(edge.settings.bandwidthMbps),
        weakensComparison: false,
      });
    }
    if (previous.settings.propagationDelayMs !== edge.settings.propagationDelayMs) {
      differences.push({
        label: `Connection ${edge.source} to ${edge.target}: one-way delay (ms)`,
        before: formatValue(previous.settings.propagationDelayMs),
        after: formatValue(edge.settings.propagationDelayMs),
        weakensComparison: false,
      });
    }
  }
  for (const [id, edge] of aEdges) {
    if (!bEdges.has(id)) {
      differences.push({
        label: 'Removed connection',
        before: `${edge.source} to ${edge.target}`,
        after: 'not present',
        weakensComparison: false,
      });
    }
  }

  return differences;
}
