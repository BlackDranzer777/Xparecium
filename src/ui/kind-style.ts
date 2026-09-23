/**
 * The colour a component wears, by category.
 *
 * Six categories, six pastels: traffic is yellow, the edge is sky, compute is
 * lilac, data is peach, messaging is pink, shared services are mint. A node on
 * the canvas is a card in its category's colour; a palette tile is a smaller
 * one. The same map serves both, so the tile you pick and the card you get
 * always match.
 *
 * Every class here names a role from the theme, never a hue, so the dark
 * theme picks its own values without any component knowing.
 */
import { SUPPORT_KINDS } from '../domain/support-services';
import { CHAIN_KINDS } from '../domain/chain-services';
import type { ComponentKind } from '../domain/types';

export type KindCategory = 'traffic' | 'edge' | 'compute' | 'data' | 'messaging' | 'shared' | 'chain';

export const KIND_CATEGORY: Record<ComponentKind, KindCategory> = {
  ...(Object.fromEntries(SUPPORT_KINDS.map((k) => [k, 'shared'])) as Record<
    (typeof SUPPORT_KINDS)[number],
    KindCategory
  >),
  ...(Object.fromEntries(CHAIN_KINDS.map((k) => [k, 'chain'])) as Record<(typeof CHAIN_KINDS)[number], KindCategory>),
  client: 'traffic',
  dns: 'edge',
  cdn: 'edge',
  waf: 'edge',
  apiGateway: 'edge',
  loadBalancer: 'compute',
  server: 'compute',
  serverless: 'compute',
  database: 'data',
  readReplica: 'data',
  cache: 'data',
  kvStore: 'data',
  objectStorage: 'data',
  documentDb: 'data',
  wideColumn: 'data',
  searchIndex: 'data',
  warehouse: 'data',
  timeSeries: 'data',
  queue: 'messaging',
  pubsub: 'messaging',
  eventStream: 'messaging',
  deadLetter: 'messaging',
  scheduler: 'messaging',
  workflow: 'messaging',
};

/** The pastel card background for a category. */
const CATEGORY_TINT: Record<KindCategory, string> = {
  traffic: 'bg-tint-traffic',
  edge: 'bg-tint-edge',
  compute: 'bg-tint-compute',
  data: 'bg-tint-data',
  messaging: 'bg-tint-messaging',
  shared: 'bg-tint-shared',
  chain: 'bg-tint-chain',
};

/** The icon colour for a category, where the icon sits on a plain surface. */
const CATEGORY_ICON: Record<KindCategory, string> = {
  traffic: 'text-kind-client',
  edge: 'text-kind-edge',
  compute: 'text-kind-server',
  data: 'text-kind-database',
  messaging: 'text-kind-queue',
  shared: 'text-kind-shared',
  chain: 'text-kind-chain',
};

export function kindTintClass(kind: ComponentKind): string {
  return CATEGORY_TINT[KIND_CATEGORY[kind]];
}

export function kindIconClass(kind: ComponentKind): string {
  return CATEGORY_ICON[KIND_CATEGORY[kind]];
}
