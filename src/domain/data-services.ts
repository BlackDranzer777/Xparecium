import type { NodeBase } from './types';

export interface NumericSetting {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  help?: string;
}
const count = (label: string, value: number, max = 1_000_000): NumericSetting =>
  ({ label, value, min: 1, max, integer: true });
const share = (label: string, value: number): NumericSetting => ({ label, value, min: 0, max: 1 });
const ms = (label: string, value: number): NumericSetting => ({ label, value, min: 0, max: 600_000, unit: 'ms' });
const common = {
  queueLimit: { label: 'Waiting queue limit', value: 1000, min: 0, max: 100_000, integer: true },
  readShare: share('Read share (0–1)', 0.9),
  itemBytes: { ...count('Record size', 1024, 100_000_000), unit: 'bytes' },
  storedGb: { label: 'Provisioned stored data', value: 100, min: 0, max: 1_000_000_000, unit: 'GB', help: 'Used for storage pricing; does not automatically grow with this short experiment.' },
} satisfies Record<string, NumericSetting>;

/** Editable workload assumptions, never claimed vendor benchmarks. */
export const DATA_SERVICES = {
  documentDb: {
    label: 'Document database',
    description: 'Keeps flexible records, such as product details. Indexed reads examine fewer documents; scans take work per document. Connect an Application Server or Function to it.',
    examples: 'MongoDB · Couchbase',
    fields: { ...common, maxConcurrentRequests: count('Concurrent operations', 32, 4096),
      indexHitShare: share('Reads using an index (0–1)', 0.95),
      indexedReadMs: ms('Indexed read time', 2), documentsPerScan: count('Documents examined by a scan', 10000),
      scanMsPerDocument: ms('Scan time per document', 0.01), writeMs: ms('Document write time', 4) },
  },
  wideColumn: {
    label: 'Wide-column store',
    description: 'Splits rows across partitions. A popular key can overload one partition while others have room. Connect an Application Server or Function to it.',
    examples: 'Apache Cassandra · Bigtable',
    fields: { ...common, partitions: count('Partitions', 8, 256), slotsPerPartition: count('Operations per partition at once', 4, 256),
      hotPartitionShare: share('Traffic pinned to one partition (0–1)', 0.1), readMs: ms('Partition read time', 3),
      writeMs: ms('Write time per replica', 2), replicas: count('Synchronous write copies', 3, 10) },
  },
  searchIndex: {
    label: 'Search index',
    description: 'Builds an index for finding matches. New writes become searchable after a refresh. Connect an Application Server or Function to it; the read share controls searches versus indexing.',
    examples: 'Elasticsearch · OpenSearch',
    fields: { ...common, maxConcurrentRequests: count('Concurrent operations', 16, 4096), queryMs: ms('Search time per shard', 5),
      shardsPerQuery: count('Shards searched per query', 4, 256), indexMs: ms('Time to index a record', 3),
      refreshMs: { ...ms('Search refresh interval', 1000), min: 1 } },
  },
  warehouse: {
    label: 'Data warehouse',
    description: 'Answers reports by scanning large amounts of data. More data takes longer; only a limited number of queries run at once. Connect an Application Server or Function to it.',
    examples: 'BigQuery · Snowflake · Redshift',
    fields: { ...common, readShare: share('Report share (0–1)', 0.99), maxConcurrentRequests: count('Concurrent reports or loads', 4, 4096),
      scanGbPerQuery: { label: 'Data scanned per report', value: 1, min: 0, max: 1_000_000, unit: 'GB' },
      scanGbPerSecond: { label: 'Scan throughput per query', value: 2, min: 0.001, max: 1_000_000, unit: 'GB/s' },
      setupMs: ms('Query setup time', 20), ingestMs: ms('Batch load time', 50) },
  },
  timeSeries: {
    label: 'Time-series database',
    description: 'Keeps time-stamped readings such as temperatures or CPU usage. Writes add batches of points; queries scan recent retained points. Connect an Application Server or Function to it.',
    examples: 'InfluxDB · TimescaleDB',
    fields: { ...common, readShare: share('Query share (0–1)', 0.2), maxConcurrentRequests: count('Concurrent operations', 32, 4096),
      pointsPerWrite: count('Points in each write', 100, 1_000_000), ingestMsPerPoint: ms('Ingest time per point', 0.01),
      retentionSeconds: { label: 'Keep readings for', value: 60, min: 0.001, max: 31_536_000, unit: 's' },
      queryWindowSeconds: { label: 'Recent time covered by a query', value: 10, min: 0.001, max: 31_536_000, unit: 's' },
      queryBaseMs: ms('Query setup time', 1), queryMsPerPoint: ms('Query time per retained point', 0.001) },
  },
} as const;

export type DataKind = keyof typeof DATA_SERVICES;
export const DATA_KINDS = Object.keys(DATA_SERVICES) as DataKind[];
export type DataSettings<K extends DataKind> = { [F in keyof typeof DATA_SERVICES[K]['fields']]: number };
export type DataServiceNode = { [K in DataKind]: NodeBase & { kind: K; settings: DataSettings<K> } }[DataKind];
export function isDataKind(kind: string): kind is DataKind { return Object.hasOwn(DATA_SERVICES, kind); }
export function dataDefaults<K extends DataKind>(kind: K): DataSettings<K> {
  return Object.fromEntries(Object.entries(DATA_SERVICES[kind].fields).map(([key, field]) => [key, field.value])) as DataSettings<K>;
}
