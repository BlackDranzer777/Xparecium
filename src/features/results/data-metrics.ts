import type { DataServiceMetrics } from '../../simulation/types';
import { formatNumber } from '../../domain/units';

export function dataDetails(s: DataServiceMetrics): string {
  const n = (key: string) => formatNumber(s.details[key] ?? 0);
  switch (s.kind) {
    case 'documentDb': return `${n('indexedReads')} indexed · ${n('scans')} scans`;
    case 'wideColumn': return `${n('partitions')} partitions · ${n('writeCopies')} write copies`;
    case 'searchIndex': return `${n('searchableWrites')} searchable · ${n('pendingRefresh')} refreshing`;
    case 'warehouse': return `${formatNumber(s.details.scannedGb ?? 0, 2)} GB scanned`;
    case 'timeSeries': return `${n('retainedPoints')} points kept · ${n('ingestedPoints')} ingested`;
  }
}
