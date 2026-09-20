/**
 * A deliberately small chart.
 *
 * Xparecium needs one visual: "how does this total split up?". A horizontal
 * bar list answers that, reads correctly at any panel width, and needs no
 * charting library. Values are printed next to every bar so the picture is
 * never the only source of the number.
 */

export interface BarDatum {
  label: string;
  value: number;
  display: string;
  tone?: 'accent' | 'good' | 'warn' | 'bad' | 'neutral';
  hint?: string;
}

const TONE_FILL: Record<NonNullable<BarDatum['tone']>, string> = {
  accent: 'bg-accent',
  good: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-ink-3',
};

export function BarChart({
  data,
  emptyMessage = 'Nothing to show.',
  max,
}: {
  data: BarDatum[];
  emptyMessage?: string;
  max?: number;
}) {
  const rows = data.filter((d) => Number.isFinite(d.value));
  const peak = max ?? Math.max(...rows.map((d) => d.value), 0);
  if (rows.length === 0 || peak <= 0) {
    return <p className="py-3 text-[12px] text-ink-3">{emptyMessage}</p>;
  }

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[12px] text-ink-2" title={row.hint ?? row.label}>
              {row.label}
            </span>
            <span className="shrink-0 font-mono text-[12px] text-ink">{row.display}</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className={`h-full rounded-full ${TONE_FILL[row.tone ?? 'accent']}`}
              style={{ width: `${Math.max(1.5, (row.value / peak) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
