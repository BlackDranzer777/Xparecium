import { supportDetails } from './support-metrics';
import { dataDetails } from './data-metrics';
/**
 * Turning a run result into "what this one component did".
 *
 * The results sheet answers "how did the system behave". A node on the canvas
 * has to answer something narrower: how did *I* behave. So each kind gets only
 * the numbers that belong to it — a database never shows a cache hit rate, and
 * a group of users never shows a CPU figure, because neither has one.
 */
import { formatMs, formatNumber, formatPercent } from '../../domain/units';
import type { ComponentKind } from '../../domain/types';
import type { SimulationResult } from '../../simulation/types';

export interface NodeMetric {
  kind: ComponentKind;
  /**
   * 0..1 for a utilisation bar, or null where a bar would be meaningless.
   * Users have no capacity, so they have no bar.
   */
  utilisation: number | null;
  /** The short value shown beside the bar, or on its own when there is none. */
  headline: string;
  /** One line of this component's own detail. */
  detail: string;
  tone: 'ok' | 'warn' | 'bad';
  /** True when this component turned work away. */
  rejected: boolean;
}

/** A queue is only worth the space it takes when something actually queued. */
function queueSuffix(peak: number): string {
  return peak > 0 ? ` · queue ${formatNumber(peak)}` : '';
}

function toneFor(utilisation: number, rejected: boolean): NodeMetric['tone'] {
  if (rejected || utilisation >= 0.9) return 'bad';
  if (utilisation >= 0.7) return 'warn';
  return 'ok';
}

/**
 * Index a result by component id. Returns an empty map for a run that could
 * not be simulated, so callers never have to special-case that.
 */
export function nodeMetricsFrom(result: SimulationResult | null): Map<string, NodeMetric> {
  const byId = new Map<string, NodeMetric>();
  if (!result || result.status === 'invalid') return byId;

  // A run is a historical record: one saved by an older build will not have
  // fields added since. `clients` is the newest of these. Reading defensively
  // is what keeps an old run openable instead of crashing the canvas.
  for (const client of result.clients ?? []) {
    const failed = client.rejected + (result.status === 'running' ? 0 : client.unfinished);
    byId.set(client.nodeId, {
      kind: 'client',
      utilisation: null,
      headline: `${formatNumber(client.completed)} done`,
      detail:
        client.completed > 0
          ? `${formatNumber(client.offered)} sent · ${formatMs(client.meanResponseMs)} avg`
          : `${formatNumber(client.offered)} sent · none completed`,
      tone: failed > 0 ? 'bad' : 'ok',
      rejected: client.rejected > 0,
    });
  }

  for (const server of result.servers ?? []) {
    if (server.kind === 'serverless') {
      // A function has no utilisation to speak of: what matters is how many
      // ran at once against the limit, and whether any were turned away.
      const filled = server.concurrencyLimit > 0 ? server.concurrencyPeak / server.concurrencyLimit : 0;
      const throttled = server.throttled ?? 0;
      byId.set(server.nodeId, {
        kind: 'serverless',
        utilisation: Math.min(1, filled),
        headline: `${formatNumber(server.completed)} runs`,
        detail:
          throttled > 0
            ? `peak ${formatNumber(server.concurrencyPeak)} at once · ${formatNumber(throttled)} throttled`
            : `peak ${formatNumber(server.concurrencyPeak)} at once · ${formatNumber(server.coldStarts ?? 0)} cold`,
        tone: throttled > 0 ? 'bad' : filled >= 0.7 ? 'warn' : 'ok',
        rejected: throttled > 0,
      });
      continue;
    }
    byId.set(server.nodeId, {
      kind: 'server',
      utilisation: server.cpuUtilisation,
      headline: formatPercent(server.cpuUtilisation, 0),
      detail: `${formatNumber(server.completed)} served${queueSuffix(server.cpuQueuePeak)}`,
      tone: toneFor(server.cpuUtilisation, server.rejected > 0),
      rejected: server.rejected > 0,
    });
  }

  for (const station of result.stations ?? []) {
    if (station.kind === 'cache') {
      const lookups = (station.hits ?? 0) + (station.misses ?? 0);
      byId.set(station.nodeId, {
        kind: 'cache',
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        detail:
          lookups > 0
            ? `${formatNumber(station.hits ?? 0)} hits · ${formatNumber(station.misses ?? 0)} misses`
            : 'no lookups',
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'database') {
      byId.set(station.nodeId, {
        kind: 'database',
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        detail: `${formatNumber(station.operations)} queries${queueSuffix(station.queuePeak)}`,
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'queue' || station.kind === 'pubsub') continue; // handled from result.queues below
    if (station.kind === 'readReplica') {
      byId.set(station.nodeId, {
        kind: 'readReplica',
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        detail: `${formatNumber(station.reads ?? 0)} reads · ${formatNumber(station.applied ?? 0)} writes applied${queueSuffix(station.queuePeak)}`,
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'kvStore' || station.kind === 'objectStorage') {
      byId.set(station.nodeId, {
        kind: station.kind,
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        detail: `${formatNumber(station.reads ?? 0)} reads · ${formatNumber(station.writes ?? 0)} writes${queueSuffix(station.queuePeak)}`,
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'dns') {
      byId.set(station.nodeId, {
        kind: 'dns',
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        detail:
          station.operations > 0
            ? `${formatNumber(station.operations)} lookups${queueSuffix(station.queuePeak)}`
            : 'no lookups',
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'cdn') {
      const hits = station.hits ?? 0;
      const misses = station.misses ?? 0;
      const seen = hits + misses;
      byId.set(station.nodeId, {
        kind: 'cdn',
        utilisation: station.utilisation,
        // The number a CDN is judged by is how much it kept off the origin.
        headline: seen > 0 ? `${formatPercent(hits / seen, 0)} hits` : formatPercent(station.utilisation, 0),
        detail:
          seen > 0
            ? `${formatNumber(hits)} answered at the edge · ${formatNumber(misses)} to origin`
            : 'no requests',
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'waf') {
      const blocked = station.blocked ?? 0;
      byId.set(station.nodeId, {
        kind: 'waf',
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        // Blocking is the job, not a failure; only a full queue is.
        detail: `${formatNumber(station.operations)} inspected · ${formatNumber(blocked)} blocked`,
        tone: toneFor(station.utilisation, station.rejected > 0),
        rejected: station.rejected > 0,
      });
      continue;
    }
    if (station.kind === 'apiGateway') {
      const throttled = station.throttled ?? 0;
      // Every request is handled here first; only those with a token go on.
      const forwarded = Math.max(0, station.operations - throttled);
      const tone = toneFor(station.utilisation, station.rejected > 0);
      byId.set(station.nodeId, {
        kind: 'apiGateway',
        utilisation: station.utilisation,
        headline: formatPercent(station.utilisation, 0),
        detail:
          throttled > 0
            ? `${formatNumber(forwarded)} forwarded · ${formatNumber(throttled)} throttled`
            : `${formatNumber(forwarded)} forwarded${queueSuffix(station.queuePeak)}`,
        // Throttling protects what is behind it, but users were turned away: worth a look.
        tone: tone === 'ok' && throttled > 0 ? 'warn' : tone,
        rejected: station.rejected > 0 || throttled > 0,
      });
      continue;
    }
    byId.set(station.nodeId, {
      kind: 'loadBalancer',
      utilisation: station.utilisation,
      headline: formatPercent(station.utilisation, 0),
      detail: `${formatNumber(station.operations)} forwarded${queueSuffix(station.queuePeak)}`,
      tone: toneFor(station.utilisation, station.rejected > 0),
      rejected: station.rejected > 0,
    });
  }

  // A queue's own number is not utilisation — a broker is almost never busy.
  // It is how much work is still waiting, which is the thing that goes wrong.
  // A topic has one backlog per listener; its card sums them.
  const byBacklogOwner = new Map<string, typeof result.queues>();
  for (const queue of result.queues ?? []) {
    const list = byBacklogOwner.get(queue.nodeId) ?? [];
    list.push(queue);
    byBacklogOwner.set(queue.nodeId, list);
  }
  for (const [nodeId, backlogs] of byBacklogOwner) {
    const outstanding = backlogs.reduce((n, q) => n + q.outstanding, 0);
    const failed = backlogs.reduce((n, q) => n + (q.failed ?? 0), 0);
    const refused = backlogs.reduce((n, q) => n + q.refused, 0);
    const processed = backlogs.reduce((n, q) => n + q.processed, 0);
    const enqueued = backlogs.reduce((n, q) => n + q.enqueued, 0);
    const maxDepth = backlogs.reduce((n, q) => n + q.maxDepth, 0);
    const filled = maxDepth > 0 ? Math.min(1, outstanding / maxDepth) : 0;
    const isTopic = backlogs.length > 1 || (result.stations ?? []).some((s) => s.nodeId === nodeId && s.kind === 'pubsub');
    const tone: NodeMetric['tone'] =
      refused + failed > 0 || filled >= 0.9 ? 'bad' : outstanding > 0 ? 'warn' : 'ok';
    byId.set(nodeId, {
      kind: isTopic ? 'pubsub' : 'queue',
      utilisation: filled,
      headline: outstanding > 0 ? `${formatNumber(outstanding)} waiting` : 'clear',
      detail: failed > 0 ? `${formatNumber(processed)} done · ${formatNumber(failed)} jobs failed` : isTopic
        ? refused > 0
          ? `${backlogs.length} listeners · ${formatNumber(refused)} copies dropped`
          : `${backlogs.length} listener${backlogs.length === 1 ? '' : 's'} · ${formatNumber(processed)} done`
        : refused > 0
          ? `${formatNumber(processed)} done · ${formatNumber(refused)} refused`
          : `${formatNumber(enqueued)} in · ${formatNumber(processed)} done`,
      tone,
      rejected: refused + failed > 0,
    });
  }

  for (const service of result.dataServices ?? []) {
    byId.set(service.nodeId, { kind: service.kind, utilisation: service.utilisation,
      headline: service.rejected > 0 ? `${formatNumber(service.rejected)} refused` : `${formatNumber(service.completed)} done`,
      detail: dataDetails(service), tone: toneFor(service.utilisation, service.rejected > 0), rejected: service.rejected > 0 });
  }
  for (const service of result.jobServices ?? []) {
    const detail = service.kind === 'eventStream' ? `${formatNumber(service.details.retained ?? 0)} retained · ${service.details.groups} groups`
      : service.kind === 'scheduler' ? `${formatNumber(service.details.ticks ?? 0)} ticks · ${formatNumber(service.details.skipped ?? 0)} skipped`
      : `${formatNumber(service.accepted)} received · ${formatNumber(service.details.expired ?? 0)} expired`;
    byId.set(service.nodeId, { kind: service.kind, utilisation: null, headline: service.waiting > 0 ? `${formatNumber(service.waiting)} waiting` : `${formatNumber(service.completed)} done`,
      detail, tone: service.failed > 0 ? 'bad' : service.waiting > 0 || (service.details.skipped ?? 0) > 0 ? 'warn' : 'ok', rejected: service.failed > 0 });
  }
  for (const service of result.supportServices ?? []) {
    const refused = service.rejected + (service.kind === 'secrets' ? service.details.denied ?? 0 : 0);
    byId.set(service.nodeId, { kind: service.kind, utilisation: service.utilisation, headline: `${formatNumber(service.completed)} done`,
      detail: supportDetails(service), tone: toneFor(service.utilisation, refused > 0), rejected: refused > 0 });
  }
  return byId;
}

/** Connections that actually carried bytes, so idle ones stay quiet. */
export function activeEdgeIds(result: SimulationResult | null): Set<string> {
  const ids = new Set<string>();
  if (!result) return ids;
  for (const link of result.links ?? []) if (link.bytes > 0) ids.add(link.edgeId);
  return ids;
}
