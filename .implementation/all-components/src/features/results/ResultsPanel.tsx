import { supportDetails } from './support-metrics';
import { dataDetails } from './data-metrics';
/**
 * Results.
 *
 * A sheet that floats over the bottom of the canvas rather than a permanent
 * drawer: it appears when there is something to show, collapses to a one-line
 * summary, and closes entirely. The canvas keeps the screen the rest of the
 * time.
 *
 * Every number here comes from a counter, a streaming aggregate or a bounded
 * histogram inside the engine. Where a number is approximate (the p95) the
 * panel says so and gives the bracket it falls in.
 */
import { useEffect, useState } from 'react';
import { formatBytes, formatMs, formatNumber, formatPercent } from '../../domain/units';
import { REJECTION_LABELS, WAIT_STAGE_LABELS } from '../../simulation/types';
import type {
  RejectionReason,
  SimulationResult,
  StationMetrics,
  WaitStage,
} from '../../simulation/types';
import type { RunRecord } from '../../storage/db';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from '../../ui/icons';
import {
  Badge,
  Callout,
  Collapsible,
  EmptyState,
  SegmentedControl,
  Stat,
} from '../../ui/primitives';
import type { Tone } from '../../ui/primitives';
import { useEditor } from '../editor/store';
import { BarChart } from './Chart';
import type { BarDatum } from './Chart';
import { ComparisonTable } from './ComparisonTable';
import { CostPanel } from './CostPanel';

type Tab = 'summary' | 'components' | 'journeys' | 'cost' | 'compare';

const TABS: { value: Tab; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'components', label: 'Components' },
  { value: 'journeys', label: 'Journeys' },
  { value: 'cost', label: 'Cost' },
  { value: 'compare', label: 'Compare' },
];

/** How the arrival pattern reads in one word beside the offered rate. */
const ARRIVAL_SUMMARY: Record<SimulationResult['arrivalPattern'], string> = {
  constant: 'constant',
  poisson: 'random intervals',
  ramp: 'ramped',
  burst: 'bursty',
};

const EDGE_STATION_KINDS = new Set<StationMetrics['kind']>(['dns', 'cdn', 'waf', 'apiGateway']);
const STORE_STATION_KINDS = new Set<StationMetrics['kind']>([
  'database',
  'readReplica',
  'cache',
  'kvStore',
  'objectStorage',
]);

/** The line under a data store's name. */
function storeStationLine(s: StationMetrics): string {
  switch (s.kind) {
    case 'cache':
      return `${formatNumber(s.hits ?? 0)} hits / ${formatNumber(s.misses ?? 0)} misses`;
    case 'database':
      return `database · ${formatNumber(s.reads ?? 0)} reads / ${formatNumber(s.writes ?? 0)} writes`;
    case 'readReplica':
      return `read replica · ${formatNumber(s.reads ?? 0)} reads · ${formatNumber(s.applied ?? 0)} writes applied`;
    case 'kvStore':
      return `key-value store · ${formatNumber(s.reads ?? 0)} reads / ${formatNumber(s.writes ?? 0)} writes`;
    case 'objectStorage':
      return `object storage · ${formatNumber(s.reads ?? 0)} reads / ${formatNumber(s.writes ?? 0)} writes`;
    default:
      return s.kind;
  }
}

/** The one number each edge component is judged by, under its name. */
function edgeStationLine(s: StationMetrics): string {
  switch (s.kind) {
    case 'dns':
      return 'DNS · lookups';
    case 'cdn': {
      const seen = (s.hits ?? 0) + (s.misses ?? 0);
      return seen > 0
        ? `CDN · ${formatPercent(s.achievedHitRate ?? 0, 0)} hits · ${formatNumber(s.misses ?? 0)} to origin`
        : 'CDN';
    }
    case 'waf':
      return `WAF · ${formatNumber(s.blocked ?? 0)} blocked`;
    case 'apiGateway':
      return `API gateway · ${formatNumber(s.throttled ?? 0)} throttled`;
    default:
      return s.kind;
  }
}

function statusTone(result: SimulationResult): Tone {
  if (result.status === 'running') return 'accent';
  if (result.status === 'completed') return 'good';
  if (result.status === 'cancelled') return 'neutral';
  return 'warn';
}

/* ------------------------------------------------------------------ summary */

function SummaryTab({ result }: { result: SimulationResult }) {
  const waitRows: BarDatum[] = (Object.keys(result.waitByStageMs) as WaitStage[])
    .map((stage) => ({
      label: WAIT_STAGE_LABELS[stage].replace(/^waiting /, ''),
      value: result.waitByStageMs[stage],
      display: formatMs(result.waitByStageMs[stage], 0),
      tone: 'accent' as const,
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

  const rejectionRows: BarDatum[] = (
    Object.entries(result.rejectionsByReason) as [RejectionReason, number][]
  ).map(([reason, count]) => ({
    label: REJECTION_LABELS[reason],
    value: count,
    display: formatNumber(count),
    tone: 'bad' as const,
  }));

  const p95 = result.responseTime.p95;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Offered"
          value={formatNumber(result.offered)}
          unit="requests"
          hint={`${formatNumber(result.offeredRatePerSecond, 2)} per second, ${ARRIVAL_SUMMARY[result.arrivalPattern]}`}
        />
        <Stat
          label="Completed"
          value={formatNumber(result.completed)}
          unit="requests"
          tone={result.completed === result.offered ? 'good' : 'neutral'}
        />
        <Stat
          label="Rejected"
          value={formatNumber(result.rejected)}
          unit="requests"
          tone={result.rejected > 0 ? 'bad' : 'neutral'}
        />
        <Stat
          label={result.status === 'running' ? 'In flight' : 'Unfinished'}
          value={formatNumber(result.unfinished)}
          unit="requests"
          tone={result.unfinished > 0 ? 'warn' : 'neutral'}
          hint="Requests still in the system at this snapshot"
        />

        <Stat
          label="Throughput"
          value={formatNumber(result.throughputPerSecond, 2)}
          unit="/s"
          hint={`Measured over ${formatNumber(result.throughputWindowMs / 1000, 2)} s of simulated time`}
        />
        <Stat
          label="Average response"
          value={formatMs(result.responseTime.meanMs)}
          hint={`Fastest ${formatMs(result.responseTime.minMs)}, slowest ${formatMs(result.responseTime.maxMs)}`}
        />
        <Stat
          label="p95 response (approx.)"
          value={formatMs(p95.value)}
          hint={`Between ${formatMs(p95.lowerBound)} and ${formatMs(p95.upperBound)} — histogram buckets are ${formatPercent(p95.relativePrecision, 0)} wide, from ${formatNumber(p95.sampleCount)} samples`}
        />
        <Stat
          label="Service vs waiting"
          value={formatMs(result.meanServiceMs)}
          hint={`Average time actually doing work or travelling. Average waiting: ${formatMs(result.meanWaitMs)}`}
        />
      </div>

      {result.findings.length > 0 && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">What the numbers say</h3>
          <ul className="space-y-2">
            {result.findings.map((finding) => (
              <li
                key={finding.id}
                className={`rounded-lg px-3.5 py-3 text-[12px] leading-relaxed ${
                  finding.severity === 'warning' ? 'bg-warn-soft' : 'bg-surface-2'
                }`}
              >
                <div className="font-semibold text-ink">{finding.title}</div>
                <div className="mt-1 text-ink-2">{finding.detail}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="ap-eyebrow mb-2.5">Where the waiting happened</h3>
          <BarChart data={waitRows} emptyMessage="No request spent measurable time in a queue." />
        </div>
        <div>
          <h3 className="ap-eyebrow mb-2.5">Why requests were rejected</h3>
          <BarChart data={rejectionRows} emptyMessage="No request was rejected." />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Database queries" value={formatNumber(result.databaseQueries)} />
        <Stat
          label="Cache hits / misses"
          value={`${formatNumber(result.cacheHits)} / ${formatNumber(result.cacheMisses)}`}
          hint={`${formatNumber(result.cachePopulates)} cache writes`}
        />
        <Stat
          label="Bytes transferred"
          value={formatBytes(result.bytesTransferred)}
          hint={`${formatBytes(result.bytesEgressToClients)} outbound to clients`}
        />
        <Stat
          label="Events processed"
          value={formatNumber(result.eventsProcessed)}
          hint={`${formatNumber(result.simulatedMs / 1000, 2)} s of simulated time`}
        />
      </div>

      <Collapsible title="Assumptions this run made">
        <ul className="list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed text-ink-2">
          {result.assumptions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
}

/* --------------------------------------------------------------- components */

function Table({ children, minWidth }: { children: React.ReactNode; minWidth: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

function ComponentsTab({ result }: { result: SimulationResult }) {
  return (
    <div className="space-y-6">
      {result.servers.some((s) => s.kind === 'serverless') && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">Serverless functions</h3>
          <Table minWidth={640}>
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Function</th>
                <th className="py-2.5 pr-4 font-medium">Invocations</th>
                <th className="py-2.5 pr-4 font-medium">At once</th>
                <th className="py-2.5 pr-4 font-medium">Cold starts</th>
                <th className="py-2.5 pr-4 font-medium">Throttled</th>
                <th className="py-2.5 pr-4 font-medium">Time alive</th>
              </tr>
            </thead>
            <tbody>
              {result.servers
                .filter((s) => s.kind === 'serverless')
                .map((s) => (
                  <tr key={s.nodeId} className="border-b border-line">
                    <td className="py-2.5 pr-4 text-ink">{s.name}</td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">{formatNumber(s.completed)}</td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">
                      {formatNumber(s.concurrencyAverage, 2)} avg
                      <div className="mt-0.5 text-[11px] text-ink-3">
                        peak {s.concurrencyPeak} of {formatNumber(s.concurrencyLimit)}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">{formatNumber(s.coldStarts ?? 0)}</td>
                    <td className="py-2.5 pr-4 font-mono">
                      <span className={(s.throttled ?? 0) > 0 ? 'text-bad' : 'text-ink'}>
                        {formatNumber(s.throttled ?? 0)}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">{formatMs(s.busyMsTotal ?? 0, 0)}</td>
                  </tr>
                ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-ink-3">
            Time alive is what the provider bills: every millisecond an invocation existed,
            including the time it waited for a store to answer.
          </p>
        </div>
      )}

      {result.servers.some((s) => s.kind !== 'serverless') && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">Application servers</h3>
          <Table minWidth={720}>
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Server</th>
                <th className="py-2.5 pr-4 font-medium">CPU busy</th>
                <th className="py-2.5 pr-4 font-medium">Concurrency</th>
                <th className="py-2.5 pr-4 font-medium">Admission queue</th>
                <th className="py-2.5 pr-4 font-medium">CPU queue</th>
                <th className="py-2.5 pr-4 font-medium">Peak memory</th>
              </tr>
            </thead>
            <tbody>
              {result.servers.filter((s) => s.kind !== 'serverless').map((s) => (
                <tr key={s.nodeId} className="border-b border-line">
                  <td className="py-2.5 pr-4 text-ink">{s.name}</td>
                  <td className="py-2.5 pr-4 font-mono">
                    <span className={s.cpuUtilisation > 0.85 ? 'text-warn' : 'text-ink'}>
                      {formatPercent(s.cpuUtilisation)}
                    </span>
                    <div className="mt-0.5 text-[11px] text-ink-3">
                      {formatNumber(s.busySlotsAverage, 2)} of {s.cpuSlots} slots
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(s.concurrencyAverage, 2)} avg
                    <div className="mt-0.5 text-[11px] text-ink-3">
                      peak {s.concurrencyPeak} of {s.concurrencyLimit}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(s.admissionQueueAverage, 2)} avg
                    <div className="mt-0.5 text-[11px] text-ink-3">peak {s.admissionQueuePeak}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(s.cpuQueueAverage, 2)} avg
                    <div className="mt-0.5 text-[11px] text-ink-3">peak {s.cpuQueuePeak}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(s.peakMemoryMb, 0)} MB
                    <div className="mt-0.5 text-[11px] text-ink-3">
                      of {formatNumber(s.memoryLimitMb, 0)} MB
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-ink-3">
            Queue lengths and utilisation are time-weighted averages over the measured interval, not
            samples.
          </p>
        </div>
      )}

      {result.stations.some((s) => EDGE_STATION_KINDS.has(s.kind)) && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">Edge</h3>
          <Table minWidth={640}>
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Component</th>
                <th className="py-2.5 pr-4 font-medium">Requests</th>
                <th className="py-2.5 pr-4 font-medium">Busy</th>
                <th className="py-2.5 pr-4 font-medium">Queue</th>
                <th className="py-2.5 pr-4 font-medium">Service time</th>
                <th className="py-2.5 pr-4 font-medium">Waiting time</th>
              </tr>
            </thead>
            <tbody>
              {result.stations
                .filter((s) => EDGE_STATION_KINDS.has(s.kind))
                .map((s) => (
                  <tr key={s.nodeId} className="border-b border-line">
                    <td className="py-2.5 pr-4 text-ink">
                      {s.name}
                      <div className="mt-0.5 text-[11px] text-ink-3">{edgeStationLine(s)}</div>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">{formatNumber(s.operations)}</td>
                    <td className="py-2.5 pr-4 font-mono">
                      <span className={s.utilisation > 0.85 ? 'text-warn' : 'text-ink'}>
                        {formatPercent(s.utilisation)}
                      </span>
                      <div className="mt-0.5 text-[11px] text-ink-3">{s.slots} slots</div>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">
                      {formatNumber(s.queueAverage, 2)} avg
                      <div className="mt-0.5 text-[11px] text-ink-3">peak {s.queuePeak}</div>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">
                      {formatMs(s.serviceMsTotal, 0)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-2">{formatMs(s.waitMsTotal, 0)}</td>
                  </tr>
                ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-ink-3">
            A CDN hit never reaches the origin. A WAF block and a gateway refusal are counted as
            rejected requests, under their own reasons above.
          </p>
        </div>
      )}

      {result.stations.some((s) => STORE_STATION_KINDS.has(s.kind)) && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">Data stores</h3>
          <Table minWidth={640}>
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Component</th>
                <th className="py-2.5 pr-4 font-medium">Operations</th>
                <th className="py-2.5 pr-4 font-medium">Busy</th>
                <th className="py-2.5 pr-4 font-medium">Queue</th>
                <th className="py-2.5 pr-4 font-medium">Service time</th>
                <th className="py-2.5 pr-4 font-medium">Waiting time</th>
              </tr>
            </thead>
            <tbody>
              {result.stations
                .filter((s) => STORE_STATION_KINDS.has(s.kind))
                .map((s) => (
                <tr key={s.nodeId} className="border-b border-line">
                  <td className="py-2.5 pr-4 text-ink">
                    {s.name}
                    <div className="mt-0.5 text-[11px] text-ink-3">{storeStationLine(s)}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">{formatNumber(s.operations)}</td>
                  <td className="py-2.5 pr-4 font-mono">
                    <span className={s.utilisation > 0.85 ? 'text-warn' : 'text-ink'}>
                      {formatPercent(s.utilisation)}
                    </span>
                    <div className="mt-0.5 text-[11px] text-ink-3">{s.slots} slots</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(s.queueAverage, 2)} avg
                    <div className="mt-0.5 text-[11px] text-ink-3">peak {s.queuePeak}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatMs(s.serviceMsTotal, 0)}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">{formatMs(s.waitMsTotal, 0)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {(result.supportServices ?? []).length > 0 && <div>
        <h3 className="ap-eyebrow mb-2.5">Shared services and real-time traffic</h3>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Component</th><th>Completed</th><th>Refused / failed</th><th>Waiting</th><th>Details</th></tr></thead>
          <tbody>{result.supportServices?.map(s => <tr key={s.nodeId} className="border-b border-line"><td className="py-2">{s.name}</td><td>{formatNumber(s.completed)}</td><td>{formatNumber(s.rejected)}</td><td>{formatNumber(s.waiting + s.active)}</td><td>{supportDetails(s)}</td></tr>)}</tbody>
        </table></div>
      </div>}
      {(result.jobServices ?? []).length > 0 && <div>
        <h3 className="ap-eyebrow mb-2.5">Background jobs</h3>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Component</th><th>Accepted</th><th>Completed</th><th>Failed / lost</th><th>Waiting</th><th>Details</th></tr></thead>
          <tbody>{result.jobServices?.map(s => <tr key={s.nodeId} className="border-b border-line"><td className="py-2">{s.name}</td><td>{formatNumber(s.accepted)}</td><td>{formatNumber(s.completed)}</td><td>{formatNumber(s.failed)}</td><td>{formatNumber(s.waiting)}</td><td>{Object.entries(s.details).map(([key, n]) => `${key}: ${formatNumber(n)}`).join(' · ')}</td></tr>)}</tbody>
        </table></div>
      </div>}
      {(result.dataServices ?? []).length > 0 && <div>
        <h3 className="ap-eyebrow mb-2.5">Specialized data stores</h3>
        <Table minWidth={640}>
          <thead><tr className="border-b border-line text-ink-3">
            {['Component', 'Reads / writes', 'Busy', 'Waiting / refused', 'Service / waiting time'].map((title) => <th key={title} className="py-2.5 pr-4 font-medium">{title}</th>)}
          </tr></thead>
          <tbody>{result.dataServices?.map((s) => <tr key={s.nodeId} className="border-b border-line">
            <td className="py-2.5 pr-4">{s.name}<div className="text-xs text-ink-3">{dataDetails(s)}</div></td>
            <td className="pr-4 font-mono">{formatNumber(s.reads)} / {formatNumber(s.writes)}</td>
            <td className="pr-4 font-mono">{formatPercent(s.utilisation)}</td>
            <td className="pr-4 font-mono">{formatNumber(s.waiting)} / {formatNumber(s.rejected)}</td>
            <td className="pr-4 font-mono">{formatMs(s.serviceMsTotal)} / {formatMs(s.waitMsTotal)}</td>
          </tr>)}</tbody>
        </Table>
      </div>}
      {(result.queues ?? []).length > 0 && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">Message queues</h3>
          <Table minWidth={640}>
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Queue</th>
                <th className="py-2.5 pr-4 font-medium">Published</th>
                <th className="py-2.5 pr-4 font-medium">Processed</th>
                <th className="py-2.5 pr-4 font-medium">Still waiting</th>
                <th className="py-2.5 pr-4 font-medium">Depth</th>
                <th className="py-2.5 pr-4 font-medium">Time to process</th>
              </tr>
            </thead>
            <tbody>
              {(result.queues ?? []).map((q) => (
                <tr key={`${q.nodeId}:${q.consumerId ?? ''}`} className="border-b border-line">
                  <td className="py-2.5 pr-4 text-ink">
                    {q.name}
                    <div className="mt-0.5 text-[11px] text-ink-3">
                      {q.consumerName ? `drained by ${q.consumerName}` : 'no consumer'}
                      {(result.stations ?? []).some((s) => s.nodeId === q.nodeId && s.kind === 'pubsub') ? ' · one copy per listener' : ''}
                      {(q.failed ?? 0) > 0 ? ` · ${formatNumber(q.failed!)} jobs failed` : ''}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(q.enqueued)}
                    {q.refused > 0 && (
                      <div className="mt-0.5 text-[11px] text-bad">
                        {formatNumber(q.refused)} refused
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">{formatNumber(q.processed)}</td>
                  <td className="py-2.5 pr-4 font-mono">
                    <span className={q.outstanding > 0 ? 'text-warn' : 'text-ink'}>
                      {formatNumber(q.outstanding)}
                    </span>
                    <div className="mt-0.5 text-[11px] text-ink-3">at the end of the run</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(q.depthAverage, 2)} avg
                    <div className="mt-0.5 text-[11px] text-ink-3">peak {formatNumber(q.depthPeak)}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatMs(q.meanLatencyMs, 1)}
                    <div className="mt-0.5 text-[11px] text-ink-3">published to done</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            The callers never waited for any of this. What is still waiting at the end is the
            price of that: a backlog that keeps growing means the consumer cannot keep up, and a
            refused publish means the queue filled before it could.
          </p>
        </div>
      )}

      {result.links.length > 0 && (
        <div>
          <h3 className="ap-eyebrow mb-2.5">Network links (one row per direction)</h3>
          <Table minWidth={640}>
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Direction</th>
                <th className="py-2.5 pr-4 font-medium">Messages</th>
                <th className="py-2.5 pr-4 font-medium">Bytes</th>
                <th className="py-2.5 pr-4 font-medium">Transmitting</th>
                <th className="py-2.5 pr-4 font-medium">Queue</th>
                <th className="py-2.5 pr-4 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {result.links.map((l) => (
                <tr key={l.channelKey} className="border-b border-line">
                  <td className="py-2.5 pr-4 text-ink">
                    {l.fromName} <span className="text-ink-3">→</span> {l.toName}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">{formatNumber(l.messages)}</td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">{formatBytes(l.bytes)}</td>
                  <td className="py-2.5 pr-4 font-mono">
                    <span className={l.utilisation > 0.8 ? 'text-warn' : 'text-ink'}>
                      {formatPercent(l.utilisation)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {formatNumber(l.queueAverage, 2)} avg
                    <div className="mt-0.5 text-[11px] text-ink-3">peak {l.queuePeak}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[11px] text-ink-3">
                    {l.bandwidthMbps} Mbps · {l.propagationDelayMs} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- journeys */

function JourneysTab({ result }: { result: SimulationResult }) {
  if (result.journeys.length === 0) {
    return <EmptyState title="No request journeys were sampled." />;
  }
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-ink-3">
        A small sample of individual requests, spread across the run. Full traces are not kept for
        every request: that would grow without bound.
      </p>
      <div className="grid gap-3 xl:grid-cols-2">
        {result.journeys.map((journey) => (
          <div key={journey.requestId} className="rounded-lg border border-line p-3.5">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="text-[12px] text-ink-2">
                Request #{journey.requestId} from {journey.clientName}
              </span>
              <span className="flex items-center gap-2">
                {journey.totalMs !== null && (
                  <span className="font-mono text-[12px] text-ink">
                    {formatMs(journey.totalMs)}
                  </span>
                )}
                <Badge
                  tone={
                    journey.outcome === 'completed'
                      ? 'good'
                      : journey.outcome === 'rejected'
                        ? 'bad'
                        : 'warn'
                  }
                >
                  {journey.outcome}
                </Badge>
              </span>
            </div>
            <ol className="space-y-1">
              {journey.steps.map((step, index) => (
                <li key={index} className="flex gap-2.5 text-[12px]">
                  <span className="w-[62px] shrink-0 text-right font-mono text-ink-3">
                    {formatNumber(step.atMs - journey.startMs, 2)}
                  </span>
                  <span className="text-ink-2">
                    {step.label}
                    {step.detail && <span className="ml-1 text-ink-3">({step.detail})</span>}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] text-ink-3">
              Of which {formatMs(journey.waitMs)} was spent waiting in queues.
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- sheet */

export function ResultsSheet() {
  const latestRun = useEditor((s) => s.latestRun);
  const runs = useEditor((s) => s.runs);
  const compareRunId = useEditor((s) => s.compareRunId);
  const setCompareRun = useEditor((s) => s.setCompareRun);
  const resultsStale = useEditor((s) => s.resultsStale);
  const keepLatestRun = useEditor((s) => s.keepLatestRun);
  const running = useEditor((s) => s.running);

  const [tab, setTab] = useState<Tab>('summary');
  // Collapsed by default: each component now carries its own result on the
  // canvas, and the strip below already gives the headline numbers. Expanding
  // covers the diagram, so that stays the reader's choice — and once made, it
  // is kept across later runs.
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // A new run brings the sheet back if it was closed, but does not change
  // whether it is expanded. `latestRun.id` changes on every run.
  const runId = latestRun?.id ?? null;
  useEffect(() => {
    if (runId) setDismissed(false);
  }, [runId]);

  if (!latestRun || dismissed) return null;

  const result = latestRun.result;
  const comparison: RunRecord | null = runs.find((r) => r.id === compareRunId) ?? null;

  return (
    <div className="ap-card overflow-hidden shadow-float">
      {/* The strip is always visible: it is the collapsed state. */}
      <div className="flex items-center gap-3 px-3 py-2">
        <Badge tone={statusTone(result)}>{result.status === 'running' && !running ? 'Snapshot' : result.status === 'cancelled' ? 'Stopped' : result.status}</Badge>
        {result.status === 'running' && <span className="font-mono text-[11px] text-ink-3">{formatNumber(result.simulatedMs / 1000, 1)} s elapsed</span>}
        {latestRun.automatic && result.status !== 'running' && (
          <Badge tone="accent" title="Calculated automatically after a change. Use Keep to save this snapshot.">
            Preview
          </Badge>
        )}

        <div className="flex min-w-0 flex-1 items-baseline gap-4 overflow-hidden text-[12px]">
          <span className="whitespace-nowrap">
            <span className="font-mono text-ink">{formatNumber(result.completed)}</span>
            <span className="ml-1 text-ink-3">completed</span>
          </span>
          <span className="whitespace-nowrap">
            <span className="font-mono text-ink">{formatMs(result.responseTime.meanMs)}</span>
            <span className="ml-1 text-ink-3">average</span>
          </span>
          <span className="whitespace-nowrap">
            <span className="font-mono text-ink">{formatMs(result.responseTime.p95.value)}</span>
            <span className="ml-1 text-ink-3">p95 approx.</span>
          </span>
          {result.rejected > 0 && (
            <span className="whitespace-nowrap">
              <span className="font-mono text-bad">{formatNumber(result.rejected)}</span>
              <span className="ml-1 text-ink-3">rejected</span>
            </span>
          )}
          <span className="whitespace-nowrap">
            <span className="font-mono text-ink">
              {latestRun.cost.pricedLineCount === 0 && latestRun.cost.unpricedLineCount > 0
                ? 'Unpriced' : `${latestRun.cost.currency} ${latestRun.cost.totalMonthly}`}
            </span>
            <span className="ml-1 text-ink-3">{latestRun.cost.unpricedLineCount > 0 ? 'partial monthly estimate' : 'per month (estimate)'}</span>
          </span>
        </div>

        {resultsStale && <Badge tone="warn">Earlier configuration</Badge>}

        {/* A running simulation replaces its own result after every change.
            This is how one of them is held on to, which is what Compare needs. */}
        {latestRun.automatic && (
          <button
            type="button"
            className="ap-btn h-7 border border-line px-2.5 text-[11.5px] text-ink-2"
            onClick={() => void keepLatestRun()}
            title="Keep this result in the history so you can compare against it later"
          >
            Keep
          </button>
        )}

        <button
          type="button"
          className="ap-icon-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse results' : 'Expand results'}
          title={expanded ? 'Collapse results' : 'Expand results'}
        >
          {expanded ? <ChevronDownIcon size={16} /> : <ChevronUpIcon size={16} />}
        </button>
        <button
          type="button"
          className="ap-icon-btn"
          onClick={() => setDismissed(true)}
          aria-label="Close results"
          title="Close results"
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {expanded && (
        <>
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2.5">
            <SegmentedControl
              label="Results sections"
              value={tab}
              options={TABS}
              onChange={setTab}
            />
            <span className="ml-auto font-mono text-[11px] text-ink-3">
              seed {result.seed} · engine {result.engineVersion}
            </span>
          </div>

          <div className="max-h-[38vh] overflow-auto border-t border-line px-4 py-4">
            {resultsStale && !running && (
              <div className="mb-4">
                <Callout tone="warn" title="These results belong to an earlier configuration">
                  The design was edited after this run. Nothing below reflects the current canvas.
                </Callout>
              </div>
            )}
            {result.statusReason && (
              <div className="mb-4">
                <Callout tone={result.status === 'completed' ? 'neutral' : 'warn'}>
                  {result.statusReason}
                </Callout>
              </div>
            )}

            {tab === 'summary' && <SummaryTab result={result} />}
            {tab === 'components' && <ComponentsTab result={result} />}
            {tab === 'journeys' && <JourneysTab result={result} />}
            {tab === 'cost' && <CostPanel cost={latestRun.cost} />}
            {tab === 'compare' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <label htmlFor="compare-run" className="text-[12px] text-ink-2">
                    Compare this run against
                  </label>
                  <select
                    id="compare-run"
                    className="ap-select w-auto"
                    value={compareRunId ?? ''}
                    onChange={(e) => setCompareRun(e.target.value || null)}
                  >
                    <option value="">Select an earlier run…</option>
                    {runs
                      .filter((r) => r.id !== latestRun.id)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                  </select>
                </div>
                {comparison ? (
                  <ComparisonTable before={comparison} after={latestRun} />
                ) : (
                  <EmptyState title="Pick an earlier run to compare against.">
                    Every run is kept (the most recent 25), together with the exact design and seed
                    it used.
                  </EmptyState>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
