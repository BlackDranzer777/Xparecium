import type { NodeBase } from './types';
import type { NumericSetting } from './data-services';
const n = (label: string, value: number, min = 0, max = 600000, unit?: string, integer = false): NumericSetting => ({ label, value, min, max, unit, integer });
const common = { serviceTimeMs: n('Work per operation', 2, 0, 600000, 'ms'), maxConcurrentRequests: n('Parallel operations', 32, 1, 4096, undefined, true),
  queueLimit: n('Waiting operations limit', 1000, 0, 100000, undefined, true) };
const bytes = { requestBytes: n('Dependency request size', 256, 0, 100000000, 'bytes', true), responseBytes: n('Dependency reply size', 1024, 0, 100000000, 'bytes', true) };
const cache = { cacheTtlSeconds: n('Caller cache lifetime', 30, 0, 86400, 's'), cacheEntries: n('Maximum cached entries', 10000, 1, 100000, undefined, true) };
const failure = { unavailableShare: n('Unavailable operation share (0–1)', 0, 0, 1) };
export const SUPPORT_SERVICES = {
  websocket: { label: 'WebSocket server', examples: 'Socket.IO · ws · Phoenix Channels',
    description: 'Keeps a connection open for repeated messages. Place between Users and your application. Connections have a fixed lease, memory cost and heartbeat traffic; a user reconnects after expiry. This model forwards messages, without rooms or broadcasts.',
    fields: { ...common, maxConnections: n('Connection limit', 10000, 1, 100000, undefined, true), memoryMb: n('Connection memory budget', 1024, 1, 1000000, 'MB'), memoryPerConnectionMb: n('Memory per connection', 0.05, 0.001, 1000, 'MB'),
      connectionSeconds: n('Connection lease', 60, 0.01, 86400, 's'), handshakeMs: n('Connection handshake time', 10, 0, 600000, 'ms'), heartbeatSeconds: n('Heartbeat interval', 20, 0.01, 86400, 's'), heartbeatBytes: n('Heartbeat size each way', 32, 0, 1000000, 'bytes', true) } },
  notification: { label: 'Notification service', examples: 'Amazon SES · Firebase Cloud Messaging · SendGrid',
    description: 'Sends email, SMS or push work after your application answers. Connect a server or function to it. Delivery has a provider quota, bounded waiting and retries; acceptance is not proof of delivery. No real messages are sent.',
    fields: { ...common, payloadBytes: n('Notification size', 1024, 0, 100000000, 'bytes', true), deliveryMs: n('Provider delivery time', 50, 0, 600000, 'ms'), ratePerSecond: n('Provider attempts per second', 1000, 0.001, 1000000),
      failureShare: n('Failed delivery share (0–1)', 0.01, 0, 1), maxAttempts: n('Delivery attempts', 3, 1, 20, undefined, true), retryDelayMs: n('Delay before another attempt', 100, 0, 600000, 'ms') } },
  identity: { label: 'Identity service', examples: 'Keycloak · Auth0 · Amazon Cognito',
    description: 'Checks whether a simulated user is allowed in. Connect the application or API Gateway to it. Valid decisions can be cached per user. This models access checks, not passwords, login screens or real tokens.',
    fields: { ...common, ...bytes, ...cache, ...failure, invalidShare: n('Invalid credential share (0–1)', 0.01, 0, 1) } },
  rateLimiter: { label: 'Rate limiter', examples: 'Redis token bucket · Envoy rate-limit service',
    description: 'Protects the next service by refusing requests above a shared token budget. Place on the path before the application. The limit is global for this component; refused requests are not queued for later.',
    fields: { ...common, ratePerSecond: n('Tokens added per second', 1000, 0, 1000000), burstCapacity: n('Maximum saved tokens', 100, 1, 1000000, undefined, true) } },
  discovery: { label: 'Service discovery / configuration', examples: 'Consul · etcd · AWS Cloud Map',
    description: 'The application looks up a simulated service address or configuration version. Connect a server or function to it. Caller caching reduces lookups but can keep an older version until expiry; no real addresses are resolved.',
    fields: { ...common, ...bytes, ...cache, ...failure, updateSeconds: n('Configuration update interval', 60, 0.01, 86400, 's') } },
  secrets: { label: 'Secrets manager', examples: 'HashiCorp Vault · AWS Secrets Manager',
    description: 'The application fetches a simulated credential version and caches it. Rotation can make a cached version too old; those operations fail until the cache expires. Connect the application to it. Never enter actual secrets here.',
    fields: { ...common, ...bytes, ...cache, ...failure, rotationSeconds: n('Credential rotation interval', 60, 0.01, 86400, 's'), graceSeconds: n('Old credential grace period', 10, 0, 86400, 's') } },
  monitoring: { label: 'Monitoring / logging', examples: 'OpenTelemetry Collector · Prometheus · Loki',
    description: 'Samples completed application operations and accepts their telemetry in the background. Connect the application to it. Overload drops telemetry, not user requests. Retention stores bounded aggregate counts, not real log text.',
    fields: { ...common, sampleShare: n('Sampled operation share (0–1)', 1, 0, 1), recordBytes: n('Telemetry record size', 256, 0, 100000000, 'bytes', true), maxRecords: n('Retained record limit', 10000, 0, 100000, undefined, true), retentionSeconds: n('Telemetry retention', 60, 0.001, 31536000, 's') } },
  serviceMesh: { label: 'Service mesh proxy', examples: 'Envoy · Istio · Linkerd',
    description: 'Represents one proxy hop on the request path. It retries simulated connection failures and opens a circuit after repeated failures. Place before the application. It does not retry a write after it was delivered, or model a whole mesh control plane.',
    fields: { ...common, connectionFailureShare: n('Failed connection attempt share (0–1)', 0.01, 0, 1), connectMs: n('Time per connection attempt', 2, 0, 600000, 'ms'), maxAttempts: n('Connection attempts', 3, 1, 20, undefined, true), retryDelayMs: n('Connection retry delay', 10, 0, 600000, 'ms'), failureThreshold: n('Failed requests before circuit opens', 5, 1, 1000, undefined, true), resetSeconds: n('Circuit open time', 5, 0.001, 86400, 's') } },
} as const;
export type SupportKind = keyof typeof SUPPORT_SERVICES;
export const SUPPORT_KINDS = Object.keys(SUPPORT_SERVICES) as SupportKind[];
export const INLINE_SUPPORT = ['websocket', 'rateLimiter', 'serviceMesh'] as const;
export const DEPENDENCY_SUPPORT = ['identity', 'discovery', 'secrets'] as const;
export const ASYNC_SUPPORT = ['notification', 'monitoring'] as const;
export const isSupportKind = (kind: string): kind is SupportKind => (SUPPORT_KINDS as readonly string[]).includes(kind);
export type SupportSettings<K extends SupportKind> = { [P in keyof (typeof SUPPORT_SERVICES)[K]['fields']]: number };
export type SupportNode = { [K in SupportKind]: NodeBase & { kind: K; settings: SupportSettings<K> } }[SupportKind];
export function supportDefaults<K extends SupportKind>(kind: K): SupportSettings<K> {
  return Object.fromEntries(Object.entries(SUPPORT_SERVICES[kind].fields).map(([key, f]) => [key, f.value])) as SupportSettings<K>;
}
