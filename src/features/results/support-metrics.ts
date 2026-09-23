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
    case 'lock': return `${n('lockWaits')} waited · ${n('lockTimeouts')} gave up`;
    case 'wallet': return `${n('signed')} signed · ${n('walletRefused')} refused`;
    // Short enough for a card: the fee is its highest multiple of the starting fee.
    case 'smartContract': return `${n('transactions')} in blocks · fee ×${formatNumber(s.details.feeMultiplierPeak ?? 1, 2)}`;
    case 'indexer': return `${formatNumber(s.completed)} queries · ${formatNumber((s.details.lagAverageMs ?? 0) / 1000, 1)} s lag`;
    case 'ipfs': return `${n('gatewayHits')} cached · ${n('networkFetches')} uncached`;
    case 'oracle': return `${n('included')} updates · ${formatNumber((s.details.maxAgeMs ?? 0) / 1000, 1)} s oldest`;
  }
}
