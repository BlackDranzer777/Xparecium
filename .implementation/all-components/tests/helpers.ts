import { DOCUMENT_SCHEMA_VERSION } from '../src/domain/types';
import type {
  ApiGatewaySettings,
  ArchEdge,
  ArchNode,
  ArchitectureDocument,
  ArrivalOptions,
  CdnSettings,
  DnsSettings,
  WafSettings,
  CacheSettings,
  ClientSettings,
  DatabaseSettings,
  LinkSettings,
  LoadBalancerSettings,
  QueueSettings,
  ServerSettings,
  Workload,
} from '../src/domain/types';
import {
  DEFAULT_API_GATEWAY_SETTINGS,
  DEFAULT_ARRIVAL_OPTIONS,
  DEFAULT_CACHE_SETTINGS,
  DEFAULT_CDN_SETTINGS,
  DEFAULT_DNS_SETTINGS,
  DEFAULT_WAF_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_DATABASE_SETTINGS,
  DEFAULT_LOAD_BALANCER_SETTINGS,
  DEFAULT_QUEUE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_WORKLOAD,
} from '../src/domain/defaults';

export function client(id: string, overrides: Partial<ClientSettings> = {}): ArchNode {
  return {
    id,
    name: id,
    kind: 'client',
    position: { x: 0, y: 0 },
    cloud: { profileId: null },
    settings: { ...DEFAULT_CLIENT_SETTINGS, ...overrides },
  };
}

export function loadBalancer(
  id: string,
  overrides: Partial<LoadBalancerSettings> = {},
): ArchNode {
  return {
    id,
    name: id,
    kind: 'loadBalancer',
    position: { x: 0, y: 0 },
    cloud: { profileId: null },
    settings: { ...DEFAULT_LOAD_BALANCER_SETTINGS, ...overrides },
  };
}

export function server(id: string, overrides: Partial<ServerSettings> = {}): ArchNode {
  return {
    id,
    name: id,
    kind: 'server',
    position: { x: 0, y: 0 },
    cloud: { profileId: null },
    settings: { ...DEFAULT_SERVER_SETTINGS, ...overrides },
  };
}

export function database(id: string, overrides: Partial<DatabaseSettings> = {}): ArchNode {
  return {
    id,
    name: id,
    kind: 'database',
    position: { x: 0, y: 0 },
    cloud: { profileId: null },
    settings: { ...DEFAULT_DATABASE_SETTINGS, ...overrides },
  };
}

export function cache(id: string, overrides: Partial<CacheSettings> = {}): ArchNode {
  return {
    id,
    name: id,
    kind: 'cache',
    position: { x: 0, y: 0 },
    cloud: { profileId: null },
    settings: { ...DEFAULT_CACHE_SETTINGS, ...overrides },
  };
}

export function queue(id: string, overrides: Partial<QueueSettings> = {}): ArchNode {
  return {
    id,
    name: id,
    kind: 'queue',
    position: { x: 0, y: 0 },
    cloud: { profileId: null },
    settings: { ...DEFAULT_QUEUE_SETTINGS, ...overrides },
  };
}

function node<K extends ArchNode['kind']>(id: string, kind: K, settings: unknown): ArchNode {
  return { id, name: id, kind, position: { x: 0, y: 0 }, cloud: { profileId: null }, settings } as ArchNode;
}
export const dns = (id: string, o: Partial<DnsSettings> = {}) =>
  node(id, 'dns', { ...DEFAULT_DNS_SETTINGS, ...o });
export const cdn = (id: string, o: Partial<CdnSettings> = {}) =>
  node(id, 'cdn', { ...DEFAULT_CDN_SETTINGS, ...o });
export const waf = (id: string, o: Partial<WafSettings> = {}) =>
  node(id, 'waf', { ...DEFAULT_WAF_SETTINGS, ...o });
export const apiGateway = (id: string, o: Partial<ApiGatewaySettings> = {}) =>
  node(id, 'apiGateway', { ...DEFAULT_API_GATEWAY_SETTINGS, ...o });

export function edge(source: string, target: string, settings: LinkSettings): ArchEdge {
  return { id: `${source}->${target}`, source, target, settings };
}

export function doc(
  nodes: ArchNode[],
  edges: ArchEdge[],
  workload: Partial<Workload> = {},
): ArchitectureDocument {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges,
    workload: { ...DEFAULT_WORKLOAD, ...workload },
    pricingOverrides: {},
  };
}

/** A fast link: 1 Gbps, 1 ms one way. */
export const FAST: LinkSettings = { propagationDelayMs: 1, bandwidthMbps: 1000 };
/** A link with no delay at all, for isolating one effect at a time. */
export const INSTANT: LinkSettings = { propagationDelayMs: 0, bandwidthMbps: 1_000_000 };

/** A workload with a shaped arrival pattern, filling in the options it needs. */
export function arrivals(
  pattern: Workload['arrivalPattern'],
  options: Partial<ArrivalOptions> = {},
): Partial<Workload> {
  return {
    arrivalPattern: pattern,
    arrivalOptions: { ...DEFAULT_ARRIVAL_OPTIONS, ...options },
  };
}
