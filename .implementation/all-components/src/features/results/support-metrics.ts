import type { SupportMetrics } from '../../simulation/models/support-service';
import { formatNumber } from '../../domain/units';
export function supportDetails(s: SupportMetrics): string {
  const n = (key: string) => formatNumber(s.details[key] ?? 0);
  switch (s.kind) {
    case 'websocket': return `${n('connections')} connected · ${n('connectionsRefused')} refused`;
    case 'notification': return `${formatNumber(s.completed)} delivered · ${n('retries')} retries · ${n('deliveryFailed')} failed`;
    case 'identity': return `${n('cacheHits')} cached · ${n('denied')} denied`;
    case 'rateLimiter': return `${formatNumber(s.completed)} passed · ${n('throttled')} limited`;
    case 'discovery': return `${n('cacheHits')} cached · ${n('stale')} older version`;
    case 'secrets': return `${n('cacheHits')} cached · ${n('denied')} expired`;
    case 'monitoring': return `${n('retained')} retained · ${formatNumber(s.rejected)} dropped`;
    case 'serviceMesh': return `${n('retries')} retries · ${n('circuitRefused')} circuit refused`;
  }
}
