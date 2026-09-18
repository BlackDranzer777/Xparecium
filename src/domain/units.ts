/**
 * Formatting helpers. Every number shown in the interface goes through one of
 * these so units are always visible and rounding is consistent.
 */

export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatMs(ms: number, digits = 2): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${formatNumber(ms / 1000, 2)} s`;
  return `${formatNumber(ms, digits)} ms`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${formatNumber(v, i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatRate(perSecond: number): string {
  return `${formatNumber(perSecond, perSecond < 10 ? 2 : 1)} /s`;
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '—';
  const smallest = 10 ** -digits;
  if (fraction > 0 && fraction * 100 < smallest) return `<${formatNumber(smallest, digits)}%`;
  return `${formatNumber(fraction * 100, digits)}%`;
}

/** Bytes on the wire converted to milliseconds of transmission at a given bandwidth. */
export function transmissionMs(bytes: number, bandwidthMbps: number): number {
  if (bandwidthMbps <= 0) return Number.POSITIVE_INFINITY;
  // bits / (megabits per second) => milliseconds
  return (bytes * 8) / (bandwidthMbps * 1000);
}

export const BYTES_PER_GB = 1_000_000_000;
export const BYTES_PER_GIB = 1_073_741_824;
export const SECONDS_PER_HOUR = 3600;
/** Aparecium projects a month as 730 hours, the usual cloud-billing convention. */
export const HOURS_PER_MONTH = 730;
export const SECONDS_PER_MONTH = HOURS_PER_MONTH * SECONDS_PER_HOUR;
