/**
 * Comparing two runs.
 *
 * The table shows what changed in the *inputs* first, because a comparison
 * without that is meaningless, and flags changes to workload, seed or duration
 * that make the comparison less controlled.
 */
import { formatBytes, formatMs, formatNumber, formatPercent } from '../../domain/units';
import type { RunRecord } from '../../storage/db';
import { diffRunInputs } from '../../storage/runs';
import { Badge, Callout } from '../../ui/primitives';

interface Row {
  label: string;
  before: string;
  after: string;
  /** +1 when higher is better, -1 when lower is better, 0 when neutral. */
  direction: 1 | -1 | 0;
  beforeValue: number;
  afterValue: number;
  comparable?: boolean;
}

function buildRows(before: RunRecord, after: RunRecord): Row[] {
  const a = before.result;
  const b = after.result;
  return [
    {
      label: 'Completed requests',
      before: formatNumber(a.completed),
      after: formatNumber(b.completed),
      direction: 1,
      beforeValue: a.completed,
      afterValue: b.completed,
    },
    {
      label: 'Rejected requests',
      before: formatNumber(a.rejected),
      after: formatNumber(b.rejected),
      direction: -1,
      beforeValue: a.rejected,
      afterValue: b.rejected,
    },
    {
      label: 'Unfinished requests',
      before: formatNumber(a.unfinished),
      after: formatNumber(b.unfinished),
      direction: -1,
      beforeValue: a.unfinished,
      afterValue: b.unfinished,
    },
    {
      label: 'Throughput',
      before: `${formatNumber(a.throughputPerSecond, 2)} /s`,
      after: `${formatNumber(b.throughputPerSecond, 2)} /s`,
      direction: 1,
      beforeValue: a.throughputPerSecond,
      afterValue: b.throughputPerSecond,
    },
    {
      label: 'Average response time',
      before: formatMs(a.responseTime.meanMs),
      after: formatMs(b.responseTime.meanMs),
      direction: -1,
      beforeValue: a.responseTime.meanMs,
      afterValue: b.responseTime.meanMs,
    },
    {
      label: 'Approximate p95',
      before: formatMs(a.responseTime.p95.value),
      after: formatMs(b.responseTime.p95.value),
      direction: -1,
      beforeValue: a.responseTime.p95.value,
      afterValue: b.responseTime.p95.value,
    },
    {
      label: 'Average waiting time',
      before: formatMs(a.meanWaitMs),
      after: formatMs(b.meanWaitMs),
      direction: -1,
      beforeValue: a.meanWaitMs,
      afterValue: b.meanWaitMs,
    },
    {
      label: 'Database queries',
      before: formatNumber(a.databaseQueries),
      after: formatNumber(b.databaseQueries),
      direction: 0,
      beforeValue: a.databaseQueries,
      afterValue: b.databaseQueries,
    },
    {
      label: 'Cache hits',
      before: formatNumber(a.cacheHits),
      after: formatNumber(b.cacheHits),
      direction: 0,
      beforeValue: a.cacheHits,
      afterValue: b.cacheHits,
    },
    {
      label: 'Bytes transferred',
      before: formatBytes(a.bytesTransferred),
      after: formatBytes(b.bytesTransferred),
      direction: 0,
      beforeValue: a.bytesTransferred,
      afterValue: b.bytesTransferred,
    },
    {
      label: `Estimated monthly cost (${after.cost.currency})`,
      before: before.cost.unpricedLineCount ? `${before.cost.totalMonthly} (partial)` : before.cost.totalMonthly,
      after: after.cost.unpricedLineCount ? `${after.cost.totalMonthly} (partial)` : after.cost.totalMonthly,
      comparable: before.cost.unpricedLineCount === 0 && after.cost.unpricedLineCount === 0 && before.cost.currency === after.cost.currency,
      direction: -1,
      beforeValue: Number(before.cost.totalMonthly),
      afterValue: Number(after.cost.totalMonthly),
    },
  ];
}

function changeLabel(row: Row): { text: string; tone: 'good' | 'bad' | 'neutral' } {
  if (row.comparable === false) return { text: 'not comparable', tone: 'neutral' };
  const delta = row.afterValue - row.beforeValue;
  if (Math.abs(delta) < 1e-9) return { text: 'no change', tone: 'neutral' };
  const pct =
    row.beforeValue === 0 ? null : formatPercent(Math.abs(delta) / Math.abs(row.beforeValue), 1);
  const arrow = delta > 0 ? '+' : '−';
  const text = pct ? `${arrow}${pct}` : `${arrow}${formatNumber(Math.abs(delta), 2)}`;
  if (row.direction === 0) return { text, tone: 'neutral' };
  const better = row.direction === 1 ? delta > 0 : delta < 0;
  return { text, tone: better ? 'good' : 'bad' };
}

/**
 * Which of the two runs drew random arrival intervals.
 *
 * Only the Poisson pattern is random: the ramp and burst shapes vary the rate
 * but keep the spacing even, so they stay reproducible from the seed alone.
 */
function randomArrivalNote(before: RunRecord, after: RunRecord): string | null {
  const a = before.inputDocument.workload.arrivalPattern === 'poisson';
  const b = after.inputDocument.workload.arrivalPattern === 'poisson';
  if (a && b) return 'Both runs';
  if (a) return 'The earlier run';
  if (b) return 'The later run';
  return null;
}

export function ComparisonTable({ before, after }: { before: RunRecord; after: RunRecord }) {
  const rows = buildRows(before, after);
  const differences = diffRunInputs(before, after);
  const weakening = differences.filter((d) => d.weakensComparison);
  const randomArrivals = randomArrivalNote(before, after);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="ap-eyebrow mb-2.5">What changed in the inputs</h3>
        {differences.length === 0 ? (
          <p className="text-[12px] text-ink-3">
            The design inputs are identical. Completed runs using the same engine, seed and
            execution limits should match; cancelled or incomplete runs may cover different intervals.
          </p>
        ) : (
          <ul className="space-y-1">
            {differences.slice(0, 24).map((diff, index) => (
              <li
                key={`${diff.label}-${index}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px]"
              >
                <span className="truncate text-ink-2">{diff.label}</span>
                <span className="shrink-0 font-mono text-ink-3">
                  {diff.before} <span className="text-ink-3">→</span>{' '}
                  <span className="text-ink">{diff.after}</span>
                </span>
              </li>
            ))}
            {differences.length > 24 && (
              <li className="text-[12px] text-ink-3">
                …and {differences.length - 24} more changes.
              </li>
            )}
          </ul>
        )}
      </div>

      {weakening.length > 0 && (
        <Callout tone="warn" title="This comparison is less controlled than it looks">
          {weakening.map((d) => d.label).join(', ')} changed between the two runs. A different seed,
          duration or offered load is a different experiment, so differences below cannot be
          attributed to the design change alone.
        </Callout>
      )}

      {/* Random arrivals mean two runs of the *same* design differ. Saying so
          here is the difference between reading a real change and reading noise. */}
      {randomArrivals && (
        <Callout tone="warn" title="Some of this difference is chance">
          {randomArrivals} used random arrivals, so two runs of the same design would not
          produce the same numbers. Treat small differences as noise, or switch the traffic
          shape to Steady to compare designs on their own.
        </Callout>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[12px]">
          <thead>
            <tr className="border-b border-line text-ink-3">
              <th className="py-2.5 pr-4 font-medium">Metric</th>
              <th className="py-2.5 pr-4 font-medium">
                Earlier
                <div className="mt-0.5 text-[11px] font-normal text-ink-3">{before.label}</div>
              </th>
              <th className="py-2.5 pr-4 font-medium">
                Later
                <div className="mt-0.5 text-[11px] font-normal text-ink-3">{after.label}</div>
              </th>
              <th className="py-2.5 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const change = changeLabel(row);
              return (
                <tr key={row.label} className="border-b border-line">
                  <td className="py-2.5 pr-4 text-ink-2">{row.label}</td>
                  <td className="py-2.5 pr-4 font-mono text-ink-3">{row.before}</td>
                  <td className="py-2.5 pr-4 font-mono text-ink">{row.after}</td>
                  <td className="py-2.5 text-right">
                    <Badge tone={change.tone === 'neutral' ? 'neutral' : change.tone}>
                      {change.text}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-3">
        Engine {before.result.engineVersion} vs {after.result.engineVersion}. Seeds{' '}
        {before.seed} and {after.seed}. Durations{' '}
        {formatNumber(before.result.arrivalWindowMs / 1000, 1)} s and{' '}
        {formatNumber(after.result.arrivalWindowMs / 1000, 1)} s.
      </p>
    </div>
  );
}
