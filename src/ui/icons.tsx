/**
 * A small hand-rolled icon set.
 *
 * An icon library would be several hundred kilobytes for the dozen glyphs
 * Aparecium uses, and the specification asks for a modest dependency count.
 * These are 24x24 stroked paths that inherit `currentColor`, so they take on
 * whatever text colour surrounds them in either theme.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ---- Component kinds --------------------------------------------------- */

export const ClientIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8.5 21h7M12 17v4" />
  </Icon>
);

export const LoadBalancerIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8.5" y="2.5" width="7" height="6" rx="1.5" />
    <rect x="1.5" y="15.5" width="6" height="6" rx="1.5" />
    <rect x="9" y="15.5" width="6" height="6" rx="1.5" />
    <rect x="16.5" y="15.5" width="6" height="6" rx="1.5" />
    <path d="M12 8.5v3.5M4.5 15.5V12h15v3.5M12 12v3.5" />
  </Icon>
);

export const ServerIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="19" height="7" rx="2" />
    <rect x="2.5" y="13.5" width="19" height="7" rx="2" />
    <path d="M6.5 7h.01M6.5 17h.01" />
  </Icon>
);

export const DatabaseIcon = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </Icon>
);

export const CacheIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z" />
  </Icon>
);

/* ---- Interface --------------------------------------------------------- */

/** A globe with a pin: a name resolved to a place. */
export const DnsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
  </Icon>
);

/** Content fanned out to the edges. */
export const CdnIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <circle cx="4.5" cy="6" r="1.8" /><circle cx="19.5" cy="6" r="1.8" />
    <circle cx="4.5" cy="18" r="1.8" /><circle cx="19.5" cy="18" r="1.8" />
    <path d="M10.2 10.6 6 7.4M13.8 10.6 18 7.4M10.2 13.4 6 16.6M13.8 13.4 18 16.6" />
  </Icon>
);

/** A shield. */
export const WafIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4.5 6v6c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6L12 3z" />
    <path d="M9.5 12.2l1.8 1.8 3.4-3.6" />
  </Icon>
);

/** A door in a frame. */
export const ApiGatewayIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M9 3v18M9 12h11" />
    <circle cx="6.5" cy="12" r="0.6" />
  </Icon>
);

/** A lightning bolt: code that runs on demand. */
export const ServerlessIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
  </Icon>
);

/** A database with a second, faded copy behind it. */
export const ReadReplicaIcon = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="10" cy="7" rx="6" ry="2.5" />
    <path d="M4 7v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7" />
    <path d="M19 9.5v8c0 1-1 1.8-2.5 2.2" strokeDasharray="2 2" />
  </Icon>
);

/** A key and a value: a record found by its key. */
export const KvStoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M10 5v14M6 10h1M6 14h1M13.5 10h4M13.5 14h4" />
  </Icon>
);

/** A bucket. */
export const ObjectStorageIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16l-1.5 13a2 2 0 0 1-2 1.8h-9A2 2 0 0 1 5.5 19L4 6z" />
    <ellipse cx="12" cy="6" rx="8" ry="2.2" />
  </Icon>
);

/** One message fanning out to many. */
export const PubSubIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="2.2" />
    <circle cx="19" cy="5" r="2" /><circle cx="19" cy="12" r="2" /><circle cx="19" cy="19" r="2" />
    <path d="M7 11.2 17 5.8M7.2 12h9.6M7 12.8 17 18.2" />
  </Icon>
);

/** Stacked messages waiting their turn. */
export const QueueIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="7" width="5" height="10" rx="1" />
    <rect x="9.5" y="7" width="5" height="10" rx="1" />
    <rect x="16.5" y="7" width="5" height="10" rx="1" />
    <path d="M12 3.5h0M5 3.5h0M19 3.5h0" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 15 6-6 6 6" />
  </Icon>
);

/** A wave, for the shape of the traffic over the run. */
export const WaveIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 12c2.5 0 2.5-6 5-6s2.5 12 5 12 2.5-12 5-12 2.5 6 5 6" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" />
  </Icon>
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);

export const UndoIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h11a6 6 0 0 1 0 12h-4" />
    <path d="m7 4-4 4 4 4" />
  </Icon>
);

export const RedoIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 8H10a6 6 0 0 0 0 12h4" />
    <path d="m17 4 4 4-4 4" />
  </Icon>
);

export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </Icon>
);

export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Icon>
);

export const UploadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V3M7.5 7.5 12 3l4.5 4.5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Icon>
);

export const WarningIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
    <path d="M12 10v4M12 17.2h.01" />
  </Icon>
);

export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const SlidersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const GridIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Icon>
);

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </Icon>
);

export const ChartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

import type { ComponentKind } from '../domain/types';

export const KIND_ICONS: Record<ComponentKind, (p: IconProps) => JSX.Element> = {
  websocket: ServerIcon, notification: QueueIcon, identity: WafIcon, rateLimiter: ApiGatewayIcon, discovery: DnsIcon, secrets: WafIcon, monitoring: DatabaseIcon, serviceMesh: LoadBalancerIcon,
  documentDb: DatabaseIcon,
  wideColumn: DatabaseIcon,
  searchIndex: DatabaseIcon,
  warehouse: DatabaseIcon,
  timeSeries: DatabaseIcon,

  client: ClientIcon,
  loadBalancer: LoadBalancerIcon,
  server: ServerIcon,
  database: DatabaseIcon,
  cache: CacheIcon,
  queue: QueueIcon,
  eventStream: PubSubIcon,
  deadLetter: QueueIcon,
  scheduler: ServerlessIcon,
  dns: DnsIcon,
  cdn: CdnIcon,
  waf: WafIcon,
  apiGateway: ApiGatewayIcon,
  serverless: ServerlessIcon,
  readReplica: ReadReplicaIcon,
  kvStore: KvStoreIcon,
  objectStorage: ObjectStorageIcon,
  pubsub: PubSubIcon,
};
