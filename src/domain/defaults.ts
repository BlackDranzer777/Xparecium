import { SUPPORT_KINDS, SUPPORT_SERVICES, isSupportKind, supportDefaults } from './support-services';
import type { SupportNode } from './support-services';
import { JOB_SERVICES, DEFAULT_EVENT_STREAM, DEFAULT_DEAD_LETTER, DEFAULT_SCHEDULER } from './job-services';
import { DATA_KINDS, DATA_SERVICES, dataDefaults } from './data-services';
/**
 * Sensible defaults, hardware profiles and the starter architectures.
 *
 * A beginner should be able to open Xparecium, press Run, and get a meaningful
 * result without touching a single advanced field. Everything here exists to
 * make that true.
 */
import { DOCUMENT_SCHEMA_VERSION } from './types';
import type {
  ApiGatewaySettings,
  ArchEdge,
  ArchNode,
  ArchitectureDocument,
  ArrivalOptions,
  CdnSettings,
  DnsSettings,
  KvStoreSettings,
  ObjectStorageSettings,
  PubSubSettings,
  QueueSettings,
  ReadReplicaSettings,
  ServerlessSettings,
  WafSettings,
  CacheSettings,
  ClientSettings,
  ComponentKind,
  DatabaseSettings,
  LinkSettings,
  LoadBalancerSettings,
  ServerProfileId,
  ServerSettings,
  Workload,
} from './types';
import { edgeId } from './ids';

/**
 * A resource profile describes *hardware*: how much compute and memory the
 * machine has. It deliberately does not touch application settings such as CPU
 * work per request or the concurrency limit, because those belong to the
 * software, not to the box it runs on.
 */
export interface ServerHardwareProfile {
  id: Exclude<ServerProfileId, 'custom'>;
  label: string;
  description: string;
  cpuSlots: number;
  ramMb: number;
  baselineMemoryMb: number;
  /** Cloud catalog profile suggested alongside this hardware size. */
  suggestedCloudProfileId: string;
}

export const SERVER_HARDWARE_PROFILES: ServerHardwareProfile[] = [
  {
    id: 'small',
    label: 'Small',
    description: '1 CPU slot, 2 GB RAM',
    cpuSlots: 1,
    ramMb: 2048,
    baselineMemoryMb: 256,
    suggestedCloudProfileId: 'aws.ec2.t3-medium.us-east-1',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: '2 CPU slots, 4 GB RAM',
    cpuSlots: 2,
    ramMb: 4096,
    baselineMemoryMb: 384,
    suggestedCloudProfileId: 'aws.ec2.m7i-large.us-east-1',
  },
  {
    id: 'large',
    label: 'Large',
    description: '4 CPU slots, 8 GB RAM',
    cpuSlots: 4,
    ramMb: 8192,
    baselineMemoryMb: 512,
    suggestedCloudProfileId: 'aws.ec2.m7i-xlarge.us-east-1',
  },
  {
    id: 'xlarge',
    label: 'Extra large',
    description: '8 CPU slots, 16 GB RAM',
    cpuSlots: 8,
    ramMb: 16384,
    baselineMemoryMb: 768,
    suggestedCloudProfileId: 'aws.ec2.m7i-2xlarge.us-east-1',
  },
];

export function hardwareProfile(id: ServerProfileId): ServerHardwareProfile | null {
  return SERVER_HARDWARE_PROFILES.find((p) => p.id === id) ?? null;
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  mode: 'open',
  activeUsers: 200,
  actionsPerUserPerMinute: 20,
  // Three seconds of reading the page before the next click. Only used in
  // closed mode; harmless and visible in open mode.
  thinkTimeMs: 3_000,
  requestRateOverridePerSecond: null,
  requestBytes: 1_200,
  responseBytes: 24_000,
};

export const DEFAULT_LOAD_BALANCER_SETTINGS: LoadBalancerSettings = {
  maxConcurrentRequests: 2048,
  serviceTimeMs: 0.2,
  queueLimit: 4096,
  policy: 'round-robin',
};

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  profile: 'medium',
  cpuSlots: 2,
  ramMb: 4096,
  cpuMsPerRequest: 8,
  concurrencyLimit: 64,
  baselineMemoryMb: 384,
  memoryPerRequestMb: 8,
  memoryPerQueuedRequestMb: 0.5,
  queueLimit: 500,
};

export const DEFAULT_DATABASE_SETTINGS: DatabaseSettings = {
  dataSizeGb: 50,
  // Nine in ten queries only read: the shape of most web workloads, and the
  // reason read replicas help at all.
  readShare: 0.9,
  queryServiceTimeMs: 6,
  maxConcurrentQueries: 16,
  queueLimit: 500,
  queryRequestBytes: 512,
  queryResultBytes: 8_192,
};

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  lookupServiceTimeMs: 0.6,
  hitRate: 0.8,
  maxConcurrentLookups: 64,
  capacityGb: 4,
  queueLimit: 1_000,
  populateOnMiss: true,
  populateServiceTimeMs: 0.8,
  lookupRequestBytes: 256,
  lookupResultBytes: 8_192,
  populateBytes: 8_192,
};

/** Internet-like link, used between a client and a server. */
export const DEFAULT_EXTERNAL_LINK: LinkSettings = {
  propagationDelayMs: 12,
  bandwidthMbps: 200,
};

/** Same-datacentre link, used between server, database and cache. */
export const DEFAULT_INTERNAL_LINK: LinkSettings = {
  propagationDelayMs: 0.4,
  bandwidthMbps: 1_000,
};

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  processingFailureShare: 0, maxAttempts: 3, retryDelayMs: 100,
  // Deep enough that a short spike is absorbed rather than refused, and small
  // enough that a consumer which cannot keep up is refused rather than hiding
  // an unbounded backlog behind a number nobody looks at.
  maxDepth: 100_000,
  publishServiceTimeMs: 0.5,
  maxConcurrentPublishes: 1024,
  publishQueueLimit: 4096,
  messageBytes: 2_000,
};

export const DEFAULT_SERVERLESS_SETTINGS: ServerlessSettings = {
  cpuMsPerRequest: 8,
  memoryMb: 512,
  maxConcurrentInvocations: 1000,
  // One invocation in twenty finds no warm instance. An assumption; real
  // figures depend on how steady the traffic is.
  coldStartShare: 0.05,
  coldStartMs: 250,
};

export const DEFAULT_READ_REPLICA_SETTINGS: ReadReplicaSettings = {
  queryServiceTimeMs: 6,
  maxConcurrentQueries: 16,
  queueLimit: 500,
  applyServiceTimeMs: 2,
};

export const DEFAULT_KV_STORE_SETTINGS: KvStoreSettings = {
  readServiceTimeMs: 2,
  writeServiceTimeMs: 4,
  readShare: 0.8,
  // A managed store scales itself: the limit is there so it can be lowered
  // to model one you run, not because the default is ever reached.
  maxConcurrentRequests: 100_000,
  queueLimit: 100_000,
  itemBytes: 1_024,
  storedGb: 50,
};

export const DEFAULT_OBJECT_STORAGE_SETTINGS: ObjectStorageSettings = {
  getServiceTimeMs: 15,
  putServiceTimeMs: 30,
  writeShare: 0.1,
  objectBytes: 200_000,
  maxConcurrentRequests: 100_000,
  queueLimit: 100_000,
  storedGb: 500,
};

export const DEFAULT_PUBSUB_SETTINGS: PubSubSettings = {
  publishServiceTimeMs: 1,
  maxConcurrentPublishes: 256,
  publishQueueLimit: 1_000,
  messageBytes: 1_024,
  maxDepth: 100_000,
};

export const DEFAULT_DNS_SETTINGS: DnsSettings = {
  lookupServiceTimeMs: 20,
  maxConcurrentLookups: 4096,
  queueLimit: 8192,
  // Two in a hundred requests arrive without a cached answer: a new visitor,
  // or a record whose TTL just ran out. An assumption, and visible as one.
  lookupShare: 0.02,
  queryBytes: 80,
  answerBytes: 160,
};

export const DEFAULT_CDN_SETTINGS: CdnSettings = {
  hitRate: 0.8,
  serviceTimeMs: 1,
  maxConcurrentRequests: 8192,
  queueLimit: 16_384,
};

export const DEFAULT_WAF_SETTINGS: WafSettings = {
  serviceTimeMs: 0.5,
  maxConcurrentRequests: 4096,
  queueLimit: 8192,
  // One in a hundred requests is something a firewall would refuse. Set it to
  // what your own logs say.
  blockRate: 0.01,
};

export const DEFAULT_API_GATEWAY_SETTINGS: ApiGatewaySettings = {
  serviceTimeMs: 2,
  maxConcurrentRequests: 4096,
  queueLimit: 8192,
  rateLimitPerSecond: null,
  burstCapacity: 100,
};

export const DEFAULT_ARRIVAL_OPTIONS: ArrivalOptions = {
  rampStartMultiplier: 0.2,
  rampEndMultiplier: 2,
  burstPeriodSeconds: 5,
  burstDurationSeconds: 1,
  burstMultiplier: 5,
};

export const DEFAULT_WORKLOAD: Workload = {
  durationSeconds: 20,
  drainSeconds: 10,
  seed: 12_345,
  arrivalPattern: 'constant',
  arrivalOptions: { ...DEFAULT_ARRIVAL_OPTIONS },
};

export const DEFAULT_CLOUD_PROFILE_BY_KIND: Record<ComponentKind, string | null> = {
  // The rate-less "generic" shape is the fallback for what nobody sells on
  // its own; everything else starts on a verified AWS rate (entry 066).
  ...Object.fromEntries(SUPPORT_KINDS.map(k => [k, `generic.${k}`])) as Record<SupportNode['kind'], string>,
  websocket: 'aws.apigateway-websocket.us-east-1',
  identity: 'aws.cognito.us-east-1',
  discovery: 'aws.cloudmap.us-east-1',
  secrets: 'aws.secretsmanager.us-east-1',
  notification: 'aws.ses.us-east-1',
  monitoring: 'aws.cloudwatch-logs.us-east-1',
  scheduler: 'aws.eventbridge-scheduler.us-east-1',
  deadLetter: 'aws.sqs.us-east-1',
  eventStream: 'aws.kinesis.provisioned.us-east-1',
  timeSeries: 'aws.timestream.us-east-1',
  warehouse: 'aws.athena.s3.us-east-1',
  searchIndex: 'aws.opensearch.r6g-large.us-east-1',
  wideColumn: 'aws.keyspaces.on-demand.us-east-1',
  documentDb: 'aws.documentdb.r6g-large-io.us-east-1',
  client: null,
  dns: 'aws.route53.us-east-1',
  cdn: 'aws.cloudfront.us-east-1',
  waf: 'aws.waf.us-east-1',
  apiGateway: 'aws.apigateway-http.us-east-1',
  loadBalancer: 'aws.alb.us-east-1',
  server: 'aws.ec2.m7i-large.us-east-1',
  serverless: 'aws.lambda.us-east-1',
  database: 'aws.rds.m7g-large-postgres.us-east-1',
  readReplica: 'aws.rds.m7g-large-postgres.us-east-1',
  kvStore: 'aws.dynamodb.on-demand.us-east-1',
  objectStorage: 'aws.s3.standard.us-east-1',
  cache: 'aws.elasticache.r7g-large-redis.us-east-1',
  queue: 'aws.sqs.us-east-1',
  pubsub: 'aws.sns.us-east-1',
};

export const COMPONENT_LABELS: Record<ComponentKind, string> = {
  ...Object.fromEntries(SUPPORT_KINDS.map(k => [k, SUPPORT_SERVICES[k].label])) as Record<SupportNode['kind'], string>,
  scheduler: JOB_SERVICES.scheduler.label,
  deadLetter: JOB_SERVICES.deadLetter.label,
  eventStream: JOB_SERVICES.eventStream.label,
  timeSeries: DATA_SERVICES.timeSeries.label,
  warehouse: DATA_SERVICES.warehouse.label,
  searchIndex: DATA_SERVICES.searchIndex.label,
  wideColumn: DATA_SERVICES.wideColumn.label,
  documentDb: DATA_SERVICES.documentDb.label,
  // "Users" rather than "Client": this is the group of people using the system,
  // and calling it a client made people look for it and not find it.
  client: 'Users',
  dns: 'DNS',
  cdn: 'CDN',
  waf: 'WAF',
  apiGateway: 'API Gateway',
  loadBalancer: 'Load Balancer',
  server: 'Application Server',
  serverless: 'Serverless Function',
  database: 'Database',
  readReplica: 'Read Replica',
  kvStore: 'Key-Value Store',
  objectStorage: 'Object Storage',
  cache: 'Cache',
  queue: 'Message Queue',
  pubsub: 'Pub/Sub Topic',
};

/**
 * Names that earlier versions seeded, and what they are called now.
 *
 * The starter templates used to call a server "App server" while its type was
 * "Application Server" — the same thing under two names, which is exactly the
 * question a diagram should not make you ask. The templates now take the name
 * from `COMPONENT_LABELS`, but documents saved before that still carry the old
 * one, so it is translated when a project is opened. Only a name that is
 * *exactly* one of these is touched: anything a person typed themselves is
 * theirs and is left alone.
 */
const RENAMED_DEFAULTS: { kind: ComponentKind; from: RegExp; to: (index: string) => string }[] = [
  {
    kind: 'server',
    from: /^App server( \d+)?$/,
    to: (index) => `${COMPONENT_LABELS.server}${index}`,
  },
];

/**
 * Bring a document's default component names up to date, returning the same
 * object when there is nothing to change so callers can tell.
 *
 * A board can already contain a component with the new name — someone who added
 * one from the palette after the rename would have exactly that. Renaming onto
 * it would replace one confusion with a worse one, so a taken name gets a
 * number, the same way a newly added component does.
 */
export function normaliseComponentNames(document: ArchitectureDocument): ArchitectureDocument {
  const renames = new Map<string, string>();
  for (const node of document.nodes) {
    for (const rule of RENAMED_DEFAULTS) {
      if (node.kind !== rule.kind) continue;
      const match = rule.from.exec(node.name);
      if (match) renames.set(node.id, rule.to(match[1] ?? ''));
    }
  }
  if (renames.size === 0) return document;

  const taken = new Set(
    document.nodes.filter((node) => !renames.has(node.id)).map((node) => node.name),
  );
  const nodes = document.nodes.map((node) => {
    const wanted = renames.get(node.id);
    if (wanted === undefined) return node;
    let name = wanted;
    for (let i = 2; taken.has(name) && i < 500; i += 1) name = `${wanted} ${i}`;
    taken.add(name);
    return { ...node, name };
  });
  return { ...document, nodes };
}

/**
 * Why this build cannot open a saved document, or null when it can. A document
 * stamped with a schema version newer than this build's was written by a newer
 * Xparecium; its meaning is unknown here, so it is left exactly as it is.
 */
export function unsupportedDocumentReason(document: { schemaVersion: number }): string | null {
  const version = document.schemaVersion;
  if (!(version > DOCUMENT_SCHEMA_VERSION)) return null;
  return `This project uses document schema version ${version}, but this build of Xparecium understands version ${DOCUMENT_SCHEMA_VERSION}. Update Xparecium to open it.`;
}

/**
 * Bring a document saved by an older build up to the current schema.
 *
 * Documents come back from IndexedDB exactly as they were written, without
 * passing through Zod, so anything added since has to be filled in here or the
 * first read of it is `undefined`. Every addition so far has a sensible default
 * that keeps the design behaving as it did, which is the only kind of change
 * this can handle: anything that would alter a result needs a real migration
 * and a conversation about what the old document meant.
 *
 * A document from a newer build is refused, never stamped down: callers check
 * `unsupportedDocumentReason` first and this throws if one gets through.
 *
 * Returns the same object when there is nothing to do, so callers can tell.
 */
export function upgradeDocument(document: ArchitectureDocument): ArchitectureDocument {
  const unsupported = unsupportedDocumentReason(document);
  if (unsupported) throw new Error(unsupported);
  const workload = document.workload;
  const needsWorkload = workload.arrivalOptions === undefined || workload.arrivalPattern === undefined;
  const needsClients = document.nodes.some(
    (node) => node.kind === 'client' && (node.settings.mode === undefined || node.settings.thinkTimeMs === undefined),
  );
  // 4 -> 5 gave the database a read share. The schema fills it in with the
  // default when a document lacks it; this stamps the version to match.
  const needsReadShare = document.nodes.some(
    (node) => node.kind === 'database' && node.settings.readShare === undefined,
  );
  // A queue gained failure and retry settings after release. Zero failures
  // and the standard retry policy are what every earlier queue did.
  const needsQueueRetry = document.nodes.some(
    (node) =>
      node.kind === 'queue' &&
      (node.settings.processingFailureShare === undefined ||
        node.settings.maxAttempts === undefined ||
        node.settings.retryDelayMs === undefined),
  );
  if (
    !needsWorkload &&
    !needsClients &&
    !needsReadShare &&
    !needsQueueRetry &&
    document.schemaVersion === DOCUMENT_SCHEMA_VERSION
  ) {
    return document;
  }
  // 2 -> 3 added an enum value and 3 -> 4 added four node kinds; for both,
  // the stamp is the whole upgrade.

  return {
    ...document,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    workload: {
      ...workload,
      arrivalPattern: workload.arrivalPattern ?? 'constant',
      arrivalOptions: { ...DEFAULT_ARRIVAL_OPTIONS, ...(workload.arrivalOptions ?? {}) },
    },
    nodes: document.nodes.map((node) => {
      if (node.kind === 'client') {
        return {
          ...node,
          settings: {
            ...node.settings,
            mode: node.settings.mode ?? 'open',
            thinkTimeMs: node.settings.thinkTimeMs ?? DEFAULT_CLIENT_SETTINGS.thinkTimeMs,
          },
        };
      }
      if (node.kind === 'database') {
        return {
          ...node,
          settings: {
            ...node.settings,
            readShare: node.settings.readShare ?? DEFAULT_DATABASE_SETTINGS.readShare,
          },
        };
      }
      if (node.kind === 'queue') {
        return {
          ...node,
          settings: {
            ...node.settings,
            processingFailureShare:
              node.settings.processingFailureShare ?? DEFAULT_QUEUE_SETTINGS.processingFailureShare,
            maxAttempts: node.settings.maxAttempts ?? DEFAULT_QUEUE_SETTINGS.maxAttempts,
            retryDelayMs: node.settings.retryDelayMs ?? DEFAULT_QUEUE_SETTINGS.retryDelayMs,
          },
        };
      }
      return node;
    }),
  };
}

export const COMPONENT_DESCRIPTIONS: Record<ComponentKind, string> = {
  ...Object.fromEntries(SUPPORT_KINDS.map(k => [k, SUPPORT_SERVICES[k].description])) as Record<SupportNode['kind'], string>,
  scheduler: JOB_SERVICES.scheduler.description,
  deadLetter: JOB_SERVICES.deadLetter.description,
  eventStream: JOB_SERVICES.eventStream.description,
  timeSeries: DATA_SERVICES.timeSeries.description,
  warehouse: DATA_SERVICES.warehouse.description,
  searchIndex: DATA_SERVICES.searchIndex.description,
  wideColumn: DATA_SERVICES.wideColumn.description,
  documentDb: DATA_SERVICES.documentDb.description,
  client:
    'The people using your system. Generates requests at a steady rate; it does not model individual user sessions.',
  dns:
    'Turns your name into an address before a request is sent. It is beside the path, not in it: only requests without a cached answer pay for a lookup.',
  cdn:
    'A cache at the edge, in front of everything. A hit is answered there and never reaches your servers; a miss goes through to them.',
  waf:
    'Inspects every request and turns a share away as malicious. What it blocks never reaches anything behind it.',
  apiGateway:
    'The front door for your API. It forwards requests and enforces a rate limit: above it, requests are refused rather than queued.',
  loadBalancer:
    'Spreads incoming requests across several application servers. It forwards, it does not compute.',
  server:
    'Runs your application code. Has a fixed number of CPU slots, a memory budget, and a limit on how many requests it holds open at once.',
  database:
    'Answers queries with an average service time and a fixed number of concurrent slots. Also holds a configured amount of stored data for costing.',
  cache:
    'Answers lookups quickly at a fixed assumed hit rate. It does not track individual keys, expiry or eviction.',
  queue:
    'Holds work for later. A server publishes a message and answers its caller straight away; the Application Server connected behind the queue works through the backlog at its own pace.',
  serverless:
    'Runs your code per request with no server to keep. Nothing waits in line: each invocation gets its own capacity up to a limit, and above it requests are refused. You pay for every millisecond an invocation is alive.',
  readReplica:
    'A copy of a database that only answers reads. Connect it from the database it copies, and from the server that reads from it. Writes still go to the database, and every replica spends time applying them.',
  kvStore:
    'Records looked up by key, at any scale. Reads and writes are billed separately, and a managed one scales itself, so it never queues; it only costs more.',
  objectStorage:
    'Files: images, uploads, backups. Every request reads or writes one object. Billed for what is kept and for each read and write.',
  pubsub:
    'One event, many listeners. Every subscriber gets its own copy of each message and works through its own backlog. The publisher never waits for any of them.',
};

export function makeNode(
  kind: ComponentKind,
  id: string,
  name: string,
  position: { x: number; y: number },
): ArchNode {
  const base = {
    id,
    name,
    position,
    cloud: { profileId: DEFAULT_CLOUD_PROFILE_BY_KIND[kind] },
  };
  if (isSupportKind(kind)) return { ...base, kind, settings: supportDefaults(kind) } as SupportNode;
  switch (kind) {
    case 'scheduler': return { ...base, kind, settings: { ...DEFAULT_SCHEDULER } };
    case 'deadLetter': return { ...base, kind, settings: { ...DEFAULT_DEAD_LETTER } };
    case 'eventStream': return { ...base, kind, settings: { ...DEFAULT_EVENT_STREAM } };
    case 'documentDb': return { ...base, kind, settings: dataDefaults(kind) };
    case 'wideColumn': return { ...base, kind, settings: dataDefaults(kind) };
    case 'searchIndex': return { ...base, kind, settings: dataDefaults(kind) };
    case 'warehouse': return { ...base, kind, settings: dataDefaults(kind) };
    case 'timeSeries': return { ...base, kind, settings: dataDefaults(kind) };

    case 'client':
      return { ...base, kind: 'client', settings: { ...DEFAULT_CLIENT_SETTINGS } };
    case 'loadBalancer':
      return {
        ...base,
        kind: 'loadBalancer',
        settings: { ...DEFAULT_LOAD_BALANCER_SETTINGS },
      };
    case 'server':
      return { ...base, kind: 'server', settings: { ...DEFAULT_SERVER_SETTINGS } };
    case 'database':
      return { ...base, kind: 'database', settings: { ...DEFAULT_DATABASE_SETTINGS } };
    case 'cache':
      return { ...base, kind: 'cache', settings: { ...DEFAULT_CACHE_SETTINGS } };
    case 'queue':
      return { ...base, kind, settings: { ...DEFAULT_QUEUE_SETTINGS } };
    case 'dns':
      return { ...base, kind, settings: { ...DEFAULT_DNS_SETTINGS } };
    case 'cdn':
      return { ...base, kind, settings: { ...DEFAULT_CDN_SETTINGS } };
    case 'waf':
      return { ...base, kind, settings: { ...DEFAULT_WAF_SETTINGS } };
    case 'apiGateway':
      return { ...base, kind, settings: { ...DEFAULT_API_GATEWAY_SETTINGS } };
    case 'serverless':
      return { ...base, kind, settings: { ...DEFAULT_SERVERLESS_SETTINGS } };
    case 'readReplica':
      return { ...base, kind, settings: { ...DEFAULT_READ_REPLICA_SETTINGS } };
    case 'kvStore':
      return { ...base, kind, settings: { ...DEFAULT_KV_STORE_SETTINGS } };
    case 'objectStorage':
      return { ...base, kind, settings: { ...DEFAULT_OBJECT_STORAGE_SETTINGS } };
    case 'pubsub':
      return { ...base, kind, settings: { ...DEFAULT_PUBSUB_SETTINGS } };
  }
}

function link(source: string, target: string, settings: LinkSettings): ArchEdge {
  return { id: edgeId(source, target), source, target, settings: { ...settings } };
}

export interface StarterTemplate {
  id: string;
  name: string;
  summary: string;
  build: () => ArchitectureDocument;
}

function emptyDocument(): ArchitectureDocument {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes: [],
    edges: [],
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

function starterDocument(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 40, y: 180 }),
    makeNode('server', 'server_1', COMPONENT_LABELS.server, { x: 360, y: 180 }),
    makeNode('database', 'db_1', 'Primary database', { x: 700, y: 180 }),
  ];
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges: [
      link('client_1', 'server_1', DEFAULT_EXTERNAL_LINK),
      link('server_1', 'db_1', DEFAULT_INTERNAL_LINK),
    ],
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

function cacheAsideDocument(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 40, y: 200 }),
    makeNode('server', 'server_1', COMPONENT_LABELS.server, { x: 360, y: 200 }),
    makeNode('cache', 'cache_1', 'Read cache', { x: 700, y: 60 }),
    makeNode('database', 'db_1', 'Primary database', { x: 700, y: 330 }),
  ];
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges: [
      link('client_1', 'server_1', DEFAULT_EXTERNAL_LINK),
      link('server_1', 'cache_1', DEFAULT_INTERNAL_LINK),
      link('server_1', 'db_1', DEFAULT_INTERNAL_LINK),
    ],
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

/**
 * Users -> load balancer -> a pool of application servers -> one database. The
 * shape most real web systems actually have, and the one that shows why a shared
 * database becomes the limit long before the servers do.
 */
function loadBalancedDocument(): ArchitectureDocument {
  const serverCount = 4;
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 0, y: 300 }),
    makeNode('loadBalancer', 'lb_1', COMPONENT_LABELS.loadBalancer, { x: 330, y: 300 }),
  ];
  const edges: ArchEdge[] = [link('client_1', 'lb_1', DEFAULT_EXTERNAL_LINK)];

  for (let i = 0; i < serverCount; i += 1) {
    const id = `server_${i + 1}`;
    nodes.push(
      makeNode('server', id, `${COMPONENT_LABELS.server} ${i + 1}`, { x: 700, y: 30 + i * 180 }),
    );
    edges.push(link('lb_1', id, DEFAULT_INTERNAL_LINK));
    edges.push(link(id, 'db_1', DEFAULT_INTERNAL_LINK));
  }

  nodes.push(makeNode('database', 'db_1', 'SQL database', { x: 1080, y: 300 }));

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges,
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

/**
 * Users -> server -> database, with the slow part handed to a queue.
 *
 * The shape of almost every real write path: accept the work, answer straight
 * away, and let something else do it. Deliberately under-provisioned on the
 * worker, because a queue that keeps up shows nothing — a backlog that grows
 * while the response time stays flat is the whole lesson.
 */
function asyncWriteDocument(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 0, y: 220 }),
    makeNode('server', 'server_1', COMPONENT_LABELS.server, { x: 330, y: 220 }),
    makeNode('database', 'db_1', 'Primary database', { x: 680, y: 380 }),
    makeNode('queue', 'queue_1', COMPONENT_LABELS.queue, { x: 680, y: 40 }),
    makeNode('server', 'worker_1', 'Email worker', { x: 1030, y: 40 }),
  ];
  const worker = nodes[4];
  if (worker && worker.kind === 'server') {
    // One request at a time, and a slow one: this is what fills the queue.
    worker.settings = {
      ...worker.settings,
      profile: 'custom',
      cpuSlots: 1,
      concurrencyLimit: 1,
      cpuMsPerRequest: 40,
    };
  }
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges: [
      link('client_1', 'server_1', DEFAULT_EXTERNAL_LINK),
      link('server_1', 'db_1', DEFAULT_INTERNAL_LINK),
      link('server_1', 'queue_1', DEFAULT_INTERNAL_LINK),
      link('queue_1', 'worker_1', DEFAULT_INTERNAL_LINK),
    ],
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

/**
 * Users -> CDN -> WAF -> API gateway -> load balancer -> servers -> database,
 * with DNS beside the users.
 *
 * The front of a real public system. The lesson is in the numbers: the CDN
 * answers most requests itself, so everything behind it sees a fraction of
 * the load, and the two servers cope with what four needed before.
 */
function edgeInFrontDocument(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 0, y: 300 }),
    makeNode('dns', 'dns_1', COMPONENT_LABELS.dns, { x: 330, y: 60 }),
    makeNode('cdn', 'cdn_1', COMPONENT_LABELS.cdn, { x: 330, y: 300 }),
    makeNode('waf', 'waf_1', COMPONENT_LABELS.waf, { x: 620, y: 300 }),
    makeNode('apiGateway', 'gateway_1', COMPONENT_LABELS.apiGateway, { x: 910, y: 300 }),
    makeNode('loadBalancer', 'lb_1', COMPONENT_LABELS.loadBalancer, { x: 1200, y: 300 }),
    makeNode('server', 'server_1', `${COMPONENT_LABELS.server} 1`, { x: 1500, y: 200 }),
    makeNode('server', 'server_2', `${COMPONENT_LABELS.server} 2`, { x: 1500, y: 400 }),
    makeNode('database', 'db_1', 'SQL database', { x: 1830, y: 300 }),
  ];
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges: [
      link('client_1', 'dns_1', DEFAULT_EXTERNAL_LINK),
      link('client_1', 'cdn_1', DEFAULT_EXTERNAL_LINK),
      link('cdn_1', 'waf_1', DEFAULT_INTERNAL_LINK),
      link('waf_1', 'gateway_1', DEFAULT_INTERNAL_LINK),
      link('gateway_1', 'lb_1', DEFAULT_INTERNAL_LINK),
      link('lb_1', 'server_1', DEFAULT_INTERNAL_LINK),
      link('lb_1', 'server_2', DEFAULT_INTERNAL_LINK),
      link('server_1', 'db_1', DEFAULT_INTERNAL_LINK),
      link('server_2', 'db_1', DEFAULT_INTERNAL_LINK),
    ],
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

/**
 * Users -> API gateway -> serverless function -> key-value store and object
 * storage, publishing to a topic with two listeners.
 *
 * Nothing here is provisioned: every line on the bill is per request, per
 * gigabyte-second or per gigabyte kept. The lesson is the bill's shape, and
 * that a function is charged for the time it waits, not just the time it
 * computes.
 */
function serverlessApiDocument(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 0, y: 260 }),
    makeNode('apiGateway', 'gateway_1', COMPONENT_LABELS.apiGateway, { x: 330, y: 260 }),
    makeNode('serverless', 'function_1', 'API function', { x: 660, y: 260 }),
    makeNode('kvStore', 'kv_1', 'Orders table', { x: 1000, y: 80 }),
    makeNode('objectStorage', 'bucket_1', 'Uploads bucket', { x: 1000, y: 260 }),
    makeNode('pubsub', 'topic_1', 'Order events', { x: 1000, y: 440 }),
    makeNode('serverless', 'function_2', 'Email function', { x: 1340, y: 360 }),
    makeNode('serverless', 'function_3', 'Analytics function', { x: 1340, y: 540 }),
  ];
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges: [
      link('client_1', 'gateway_1', DEFAULT_EXTERNAL_LINK),
      link('gateway_1', 'function_1', DEFAULT_INTERNAL_LINK),
      link('function_1', 'kv_1', DEFAULT_INTERNAL_LINK),
      link('function_1', 'bucket_1', DEFAULT_INTERNAL_LINK),
      link('function_1', 'topic_1', DEFAULT_INTERNAL_LINK),
      link('topic_1', 'function_2', DEFAULT_INTERNAL_LINK),
      link('topic_1', 'function_3', DEFAULT_INTERNAL_LINK),
    ],
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

/**
 * Users -> load balancer -> two servers -> one database with two read
 * replicas.
 *
 * Nine in ten queries only read, and those go to the replicas; every write
 * still lands on the primary and then on both replicas. The lesson is in the
 * replicas' own numbers: reads taken off the primary, and writes applied
 * anyway.
 */
function readReplicasDocument(): ArchitectureDocument {
  const nodes: ArchNode[] = [
    makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 0, y: 300 }),
    makeNode('loadBalancer', 'lb_1', COMPONENT_LABELS.loadBalancer, { x: 330, y: 300 }),
    makeNode('server', 'server_1', `${COMPONENT_LABELS.server} 1`, { x: 660, y: 200 }),
    makeNode('server', 'server_2', `${COMPONENT_LABELS.server} 2`, { x: 660, y: 400 }),
    makeNode('database', 'db_1', 'Primary database', { x: 1000, y: 300 }),
    makeNode('readReplica', 'replica_1', 'Replica 1', { x: 1340, y: 200 }),
    makeNode('readReplica', 'replica_2', 'Replica 2', { x: 1340, y: 400 }),
  ];
  const edges: ArchEdge[] = [
    link('client_1', 'lb_1', DEFAULT_EXTERNAL_LINK),
    link('lb_1', 'server_1', DEFAULT_INTERNAL_LINK),
    link('lb_1', 'server_2', DEFAULT_INTERNAL_LINK),
    link('db_1', 'replica_1', DEFAULT_INTERNAL_LINK),
    link('db_1', 'replica_2', DEFAULT_INTERNAL_LINK),
  ];
  for (const server of ['server_1', 'server_2']) {
    edges.push(link(server, 'db_1', DEFAULT_INTERNAL_LINK));
    edges.push(link(server, 'replica_1', DEFAULT_INTERNAL_LINK));
    edges.push(link(server, 'replica_2', DEFAULT_INTERNAL_LINK));
  }
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    nodes,
    edges,
    workload: { ...DEFAULT_WORKLOAD },
    pricingOverrides: {},
  };
}

function dataWorkshopDocument(): ArchitectureDocument {
  const users = makeNode('client', 'client_1', COMPONENT_LABELS.client, { x: 0, y: 320 });
  if (users.kind === 'client') { users.settings.activeUsers = 10; users.settings.actionsPerUserPerMinute = 12; }
  const app = makeNode('server', 'server_1', COMPONENT_LABELS.server, { x: 330, y: 320 });
  const stores = DATA_KINDS.map((kind, index) => makeNode(kind, kind, COMPONENT_LABELS[kind], { x: 700, y: index * 160 }));
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, nodes: [users, app, ...stores],
    edges: [link(users.id, app.id, DEFAULT_EXTERNAL_LINK), ...stores.map((n) => link(app.id, n.id, DEFAULT_INTERNAL_LINK))],
    workload: { ...DEFAULT_WORKLOAD }, pricingOverrides: {} };
}

function jobsWorkshopDocument(): ArchitectureDocument {
  const make = (kind: ComponentKind, id: string, x: number, y: number) => makeNode(kind, id, COMPONENT_LABELS[kind], { x, y });
  const nodes = [make('scheduler', 'scheduler', 0, 250), make('server', 'producer', 300, 250), make('queue', 'queue', 600, 100),
    make('server', 'worker', 900, 0), make('deadLetter', 'deadLetter', 900, 200), make('eventStream', 'eventStream', 600, 450), make('server', 'reader', 900, 450)];
  const q = nodes.find(n => n.kind === 'queue'); if (q?.kind === 'queue') q.settings.processingFailureShare = 0.4;
  const pairs = [['scheduler', 'producer'], ['producer', 'queue'], ['queue', 'worker'], ['queue', 'deadLetter'], ['producer', 'eventStream'], ['eventStream', 'reader']];
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, nodes, edges: pairs.map(([from, to]) => link(from!, to!, DEFAULT_INTERNAL_LINK)), workload: { ...DEFAULT_WORKLOAD }, pricingOverrides: {} };
}

function supportWorkshopDocument(): ArchitectureDocument {
  const make = (kind: ComponentKind, id: string, x: number, y: number) => makeNode(kind, id, COMPONENT_LABELS[kind], { x, y });
  const nodes = [make('client', 'users', 0, 300), make('websocket', 'websocket', 280, 300), make('rateLimiter', 'rateLimiter', 560, 300),
    make('serviceMesh', 'serviceMesh', 840, 300), make('server', 'app', 1120, 300), make('identity', 'identity', 1450, 0),
    make('discovery', 'discovery', 1450, 160), make('secrets', 'secrets', 1450, 320), make('notification', 'notification', 1450, 480), make('monitoring', 'monitoring', 1450, 640)];
  const users = nodes[0]; if (users?.kind === 'client') { users.settings.activeUsers = 20; users.settings.actionsPerUserPerMinute = 60; }
  const pairs = [['users', 'websocket'], ['websocket', 'rateLimiter'], ['rateLimiter', 'serviceMesh'], ['serviceMesh', 'app'],
    ...['identity', 'discovery', 'secrets', 'notification', 'monitoring'].map(id => ['app', id])];
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, nodes, edges: pairs.map(([from, to]) => link(from!, to!, DEFAULT_INTERNAL_LINK)), workload: { ...DEFAULT_WORKLOAD }, pricingOverrides: {} };
}

/**
 * The components a person can pick from the palette.
 *
 * The sixteen kinds added after the first fifteen share their engine wiring,
 * so their code arrives together; each one is *released* on its own, once it
 * has been tested in the app and written up. A kind that is not here still
 * exists — a document that uses it opens, simulates and prices — it simply
 * is not offered as a tile, and a template that needs it is not offered
 * either. Releasing a component means adding it to this list, with its
 * tests and its documentation (decisions.md, entry 062 onward).
 */
export const RELEASED_KINDS: readonly ComponentKind[] = [
  'client',
  'dns', 'cdn', 'waf', 'apiGateway',
  'loadBalancer', 'server', 'serverless',
  'database', 'readReplica', 'cache', 'kvStore', 'objectStorage',
  'queue', 'pubsub',
  // Released one at a time from the staged sixteen, each with its entry:
  'documentDb', // 062
  'wideColumn', 'searchIndex', 'warehouse', 'timeSeries', // 063
  'eventStream', 'deadLetter', 'scheduler', // 064
  'websocket', 'rateLimiter', 'serviceMesh', 'identity', 'discovery', 'secrets', 'notification', 'monitoring', // 065
];

export function isReleased(kind: ComponentKind): boolean {
  return RELEASED_KINDS.includes(kind);
}

/** A template is offered only when every component in it is released. */
export function releasedTemplates(): StarterTemplate[] {
  return TEMPLATES.filter((t) => t.build().nodes.every((n) => isReleased(n.kind)));
}

export const TEMPLATES: StarterTemplate[] = [
  {
    id: 'starter',
    name: 'Starter: users to server to database',
    summary:
      'The smallest complete system. 200 users, 20 actions each per minute, one medium server, one database.',
    build: starterDocument,
  },
  {
    id: 'load-balanced',
    name: 'Load balanced: users to a pool of servers',
    summary:
      'Users behind a load balancer spreading traffic across four application servers, all sharing one database.',
    build: loadBalancedDocument,
  },
  {
    id: 'async-write',
    name: 'Async write path: hand the slow work to a queue',
    summary:
      'The server answers as soon as the message is published, and a single worker drains the queue behind it. The worker is deliberately too slow, so the backlog grows while the response time stays flat.',
    build: asyncWriteDocument,
  },
  {
    id: 'edge-in-front',
    name: 'Edge in front: DNS, CDN, WAF and API gateway',
    summary:
      'The front of a public system. Users resolve the name through DNS, then go through a CDN, a WAF and an API gateway before the load balancer. The CDN answers 80% of requests itself, so two servers carry what four needed before.',
    build: edgeInFrontDocument,
  },
  {
    id: 'serverless-api',
    name: 'Serverless API: gateway, function, key-value store, topic',
    summary:
      'Nothing provisioned. An API gateway invokes a function that reads a key-value store and object storage, then publishes an event that two more functions listen to. Every line on the bill is per request or per second alive.',
    build: serverlessApiDocument,
  },
  {
    id: 'read-replicas',
    name: 'Read replicas: take the reads off the primary',
    summary:
      'Two servers sharing one database with two read replicas. Nine in ten queries only read and go to the replicas; every write still lands on the primary and on both replicas.',
    build: readReplicasDocument,
  },
  {
    id: 'cache-aside',
    name: 'Cache-aside read path',
    summary:
      'The same system with a read cache in front of the database, using the cache-aside pattern at an assumed 80% hit rate.',
    build: cacheAsideDocument,
  },
  { id: 'support-workshop', name: 'Shared services workshop', summary: 'Connections, access checks, limits, configuration and independent delivery.', build: supportWorkshopDocument },
  { id: 'jobs-workshop', name: 'Background jobs workshop', summary: 'A schedule publishes jobs and events. Failed jobs retry before moving aside.', build: jobsWorkshopDocument },
  { id: 'data-workshop', name: 'Data workshop', summary: 'Five storage models: compare scans, partitions, refresh and retention', build: dataWorkshopDocument },
  {
    id: 'empty',
    name: 'Empty canvas',
    summary: 'Start from nothing and place your own components.',
    build: emptyDocument,
  },
];

export function buildTemplate(id: string): ArchitectureDocument {
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0]!;
  return t.build();
}
