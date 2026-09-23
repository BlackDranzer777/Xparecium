#!/usr/bin/env node
/**
 * Rebuild public/catalogs/cloud-profiles.v1.json from the providers' own
 * machine-readable price lists.
 *
 *   node scripts/refresh-cloud-prices.mjs            # fetch and write
 *   node scripts/refresh-cloud-prices.mjs --check    # fetch and diff, exit 1 if stale
 *
 * Why a script: a price copied by hand is right on the day it is copied and
 * quietly wrong thereafter. Every rate this writes carries the provider's own
 * publication date, so a stale catalog says so on its face.
 *
 * Sources, all public, no account:
 *   AWS    Price List Bulk API — one CSV per offer per region. The EC2 file is
 *          ~300 MB and is streamed, never held in memory.
 *   Azure  Retail Prices API — JSON, filterable, paginated.
 *   GCP    Cloud Billing Catalog API needs an API key. Set GCP_BILLING_API_KEY
 *          and the Compute Engine profiles are read from it; otherwise they are
 *          written unchanged from the ILLUSTRATIVE block below and stay
 *          labelled as such.
 *
 * What this deliberately does not do: pick which machines exist. The list of
 * profiles, their ids and their sizeClass are a judgement recorded in PROFILES
 * below. The script only fills in the numbers.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(here, '../public/catalogs/cloud-profiles.v1.json');
const CHECK = process.argv.includes('--check');
const today = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ AWS */

const AWS_REGION = 'us-east-1';
const AWS_REGION_NAME = 'US East (N. Virginia)';
const awsUrl = (offer) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offer}/current/${AWS_REGION}/index.csv`;
/** Some services are priced globally, not per region; their rows live in the whole-offer file. */
const awsGlobalUrl = (offer) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offer}/current/index.csv`;

/** Parse one line of a fully-quoted CSV, honouring "" escapes. */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Stream an AWS offer CSV, handing each data row to `visit`. Returns the
 * file's publication date. `visit` returns true when it has everything it
 * needs, at which point the download is aborted.
 */
async function streamAwsOffer(offer, visit, url = awsUrl(offer)) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`AWS ${offer}: HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let lineNo = 0;
  let header = null;
  let publication = null;
  let done = false;
  try {
    while (!done) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        lineNo += 1;
        if (lineNo <= 5) {
          const [k, v] = parseCsvLine(line);
          if (k === 'Publication Date') publication = v;
          continue;
        }
        const cells = parseCsvLine(line);
        if (!header) {
          header = cells;
          continue;
        }
        const row = {};
        header.forEach((h, i) => {
          row[h] = cells[i] ?? '';
        });
        if (visit(row)) {
          done = true;
          break;
        }
      }
    }
  } finally {
    controller.abort();
  }
  return publication;
}

/** Collect specific rows from an offer in one pass. */
async function awsLookup(offer, wants, url = awsUrl(offer)) {
  const found = new Map();
  const publication = await streamAwsOffer(offer, (row) => {
    for (const [key, match] of Object.entries(wants)) {
      if (!found.has(key) && match(row)) found.set(key, row);
    }
    return found.size === Object.keys(wants).length;
  }, url);
  const missing = Object.keys(wants).filter((k) => !found.has(k));
  if (missing.length) throw new Error(`AWS ${offer}: not found: ${missing.join(', ')}`);
  return { rows: Object.fromEntries(found), publication };
}

const onDemand = (row) => row.TermType === 'OnDemand';
const ec2Linux = (type) => (row) =>
  onDemand(row) &&
  row['Product Family'] === 'Compute Instance' &&
  row['Instance Type'] === type &&
  row['Operating System'] === 'Linux' &&
  row.Tenancy === 'Shared' &&
  (row['Pre Installed S/W'] || 'NA') === 'NA' &&
  row.CapacityStatus === 'Used' &&
  (row['License Model'] === 'No License required' || row['License Model'] === '') &&
  row.Unit === 'Hrs';

/* ---------------------------------------------------------------- Azure */

const AZURE_REGION = 'eastus';
async function azure(filter) {
  let url = `https://prices.azure.com/api/retail/prices?${new URLSearchParams({ $filter: filter })}`;
  const items = [];
  while (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Azure: HTTP ${response.status} for ${filter}`);
    const data = await response.json();
    items.push(...(data.Items ?? []));
    url = data.NextPageLink ?? null;
  }
  return items;
}
async function azureOne(filter, pick = (items) => items[0]) {
  const items = await azure(filter);
  const item = pick(items);
  if (!item) throw new Error(`Azure: nothing matched ${filter}`);
  return item;
}
const azureVmLinux = (sku) =>
  azureOne(
    `serviceName eq 'Virtual Machines' and armRegionName eq '${AZURE_REGION}' and armSkuName eq '${sku}' and priceType eq 'Consumption'`,
    (items) =>
      items
        .filter((i) => !/Windows/.test(i.productName) && !/Spot|Low Priority/.test(i.skuName))
        .sort((a, b) => a.retailPrice - b.retailPrice)[0],
  );

/* --------------------------------------------------------------- shapes */

/**
 * A rate as a decimal string: up to four places, never fewer than two — or up
 * to ten when the rate is smaller than that, as a gigabyte-second's is.
 */
const amount = (n, places = 4) => {
  const value = Number(n);
  const digits = value > 0 && value < 0.0001 ? 10 : places;
  const trimmed = value.toFixed(digits).replace(/0+$/, '');
  const [whole, fraction = ''] = trimmed.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
};

const awsNote = (offer, publication, extra = '') =>
  `Read from the AWS Price List Bulk API (${offer}, published ${publication}). On-demand, USD, ${AWS_REGION}.${extra ? ' ' + extra : ''}`;
const azureNote = (extra = '') =>
  `Read from the Azure Retail Prices API on ${today}. Pay-as-you-go, USD, ${AZURE_REGION}.${extra ? ' ' + extra : ''}`;

const AWS_EGRESS_NOTE =
  'Outbound transfer uses the first tier (up to 10 TB/month); AWS charges less beyond that, and gives 100 GB/month free per account.';
const AZURE_EGRESS_NOTE =
  'Outbound transfer uses the first paid tier on default routing (after 100 GB/month free); Azure charges less beyond 10 TB.';

/* ----------------------------------------------------------- the build */

async function build() {
  const log = (m) => process.stderr.write(`${m}\n`);

  // ---- AWS -----------------------------------------------------------
  log('AWS: EC2 (streaming ~300 MB)…');
  const ec2 = await awsLookup('AmazonEC2', {
    't3.medium': ec2Linux('t3.medium'),
    'm7i.large': ec2Linux('m7i.large'),
    'm7i.xlarge': ec2Linux('m7i.xlarge'),
    'm7i.2xlarge': ec2Linux('m7i.2xlarge'),
  });
  log('AWS: data transfer…');
  const transfer = await awsLookup('AWSDataTransfer', {
    internetFirstTier: (r) =>
      onDemand(r) &&
      r['Transfer Type'] === 'AWS Outbound' &&
      r['From Location'] === AWS_REGION_NAME &&
      r['To Location'] === 'External' &&
      r.StartingRange === '0',
  });
  log('AWS: RDS…');
  const rds = await awsLookup('AmazonRDS', {
    'db.m7g.large': (r) =>
      onDemand(r) &&
      r['Instance Type'] === 'db.m7g.large' &&
      r['Database Engine'] === 'PostgreSQL' &&
      r['Deployment Option'] === 'Single-AZ' &&
      r.Unit === 'Hrs',
    gp3: (r) =>
      onDemand(r) &&
      r['Database Engine'] === 'PostgreSQL' &&
      r['Deployment Option'] === 'Single-AZ' &&
      (r['Volume Type'] || '').startsWith('General Purpose') &&
      r.Unit === 'GB-Mo',
  });
  log('AWS: ElastiCache…');
  const cache = await awsLookup('AmazonElastiCache', {
    'cache.r7g.large': (r) =>
      onDemand(r) && r['Instance Type'] === 'cache.r7g.large' && r.Unit === 'Hrs' && /Redis|^$/.test(r['Cache Engine'] || ''),
  });
  log('AWS: ELB…');
  const elb = await awsLookup('AWSELB', {
    albHour: (r) => onDemand(r) && r['Product Family'] === 'Load Balancer-Application' && r.usageType === 'LoadBalancerUsage' && r.Unit === 'Hrs',
  });
  log('AWS: SQS…');
  const sqs = await awsLookup('AWSQueueService', {
    standardFirstTier: (r) => onDemand(r) && /standard requests/.test(r.PriceDescription) && r.StartingRange === '0',
  });
  log('AWS: Route 53 (global file)…');
  const route53 = await awsLookup(
    'AmazonRoute53',
    {
      queriesFirstTier: (r) => onDemand(r) && r.usageType === 'DNS-Queries' && r.StartingRange === '0',
    },
    awsGlobalUrl('AmazonRoute53'),
  );
  log('AWS: CloudFront (global file)…');
  const cloudfront = await awsLookup(
    'AmazonCloudFront',
    {
      usTransferFirstTier: (r) =>
        onDemand(r) && r.usageType === 'US-DataTransfer-Out-Bytes' && r.StartingRange === '0',
      usHttpsRequests: (r) => onDemand(r) && r.usageType === 'US-Requests-Tier2-HTTPS',
    },
    awsGlobalUrl('AmazonCloudFront'),
  );
  log('AWS: API Gateway…');
  const apigw = await awsLookup('AmazonApiGateway', {
    httpApiFirstTier: (r) =>
      onDemand(r) && r.operation === 'ApiGatewayHttpApi' && r.usageType.endsWith('-ApiGatewayHttpRequest') && r.StartingRange === '0',
  });
  log('AWS: S3…');
  const s3 = await awsLookup('AmazonS3', {
    standardStorageFirstTier: (r) =>
      onDemand(r) && r.usageType === 'TimedStorage-ByteHrs' && r['Volume Type'] === 'Standard' && r.StartingRange === '0',
    putRequests: (r) => onDemand(r) && r.usageType === 'Requests-Tier1' && r.Unit === 'Requests',
    getRequests: (r) => onDemand(r) && r.usageType === 'Requests-Tier2' && r.Unit === 'Requests',
  });
  log('AWS: DynamoDB…');
  const dynamo = await awsLookup('AmazonDynamoDB', {
    readUnits: (r) => onDemand(r) && r.usageType === 'ReadRequestUnits' && r.operation === 'PayPerRequestThroughput',
    writeUnits: (r) => onDemand(r) && r.usageType === 'WriteRequestUnits' && r.operation === 'PayPerRequestThroughput',
    storage: (r) => onDemand(r) && r.usageType === 'TimedStorage-ByteHrs' && r.Unit === 'GB-Mo' && r.PricePerUnit !== '0.0000000000',
  });
  log('AWS: Lambda…');
  const lambda = await awsLookup('AWSLambda', {
    requests: (r) => onDemand(r) && r.usageType === 'Request' && r.Unit === 'Requests',
    gbSecondsTier1: (r) => onDemand(r) && r.usageType === 'Lambda-GB-Second' && r.StartingRange === '0',
  });
  log('AWS: SNS…');
  const sns = await awsLookup('AmazonSNS', {
    requestsPaidTier: (r) => onDemand(r) && r.usageType === 'Requests-Tier1' && r.StartingRange === '1000000',
  });
  log('AWS: DocumentDB…');
  const docdb = await awsLookup('AmazonDocDB', {
    r6gLargeIo: (r) => onDemand(r) && r.usageType === 'InstanceUsageIOOptimized:db.r6g.large' && r.Unit === 'Hrs',
    ioStorage: (r) => onDemand(r) && r.usageType === 'IO-OptimizedStorageUsage' && r.Unit === 'GB-Mo',
  });
  log('AWS: Keyspaces…');
  const keyspaces = await awsLookup('AmazonMCS', {
    readUnits: (r) => onDemand(r) && r.usageType === 'ReadRequestUnits',
    writeUnits: (r) => onDemand(r) && r.usageType === 'WriteRequestUnits',
    storage: (r) => onDemand(r) && r.usageType === 'TimedStorage-ByteHrs' && r.Unit === 'GB-Mo',
  });
  log('AWS: OpenSearch…');
  const opensearch = await awsLookup('AmazonES', {
    r6gLarge: (r) => onDemand(r) && r.usageType === 'ESInstance:r6g.large' && r.Unit === 'Hrs',
    gp3: (r) => onDemand(r) && r.usageType === 'ES:GP3-Storage' && r.Unit === 'GB-Mo',
  });
  log('AWS: Redshift…');
  const redshift = await awsLookup('AmazonRedshift', {
    ra3xlplus: (r) => onDemand(r) && r.usageType === 'Node:ra3.xlplus' && r.Unit === 'Hrs',
    rms: (r) => onDemand(r) && r.usageType === 'RMS:ra3.xlplus' && r.Unit === 'GB-Mo',
  });
  log('AWS: Athena…');
  const athena = await awsLookup('AmazonAthena', {
    scannedTb: (r) => onDemand(r) && r.usageType === 'USE1-DataScannedInTB' && r.Unit === 'Terabytes',
  });
  log('AWS: Timestream…');
  const timestream = await awsLookup('AmazonTimestream', {
    ingestGb: (r) => onDemand(r) && r.usageType === 'USE1-DataIngestion-Bytes' && r.Unit === 'GB',
    magnetic: (r) => onDemand(r) && r.usageType === 'USE1-MagneticStore-ByteHrs' && r.Unit === 'GB-Mo',
  });
  log('AWS: Kinesis…');
  const kinesis = await awsLookup('AmazonKinesis', {
    shardHour: (r) => onDemand(r) && r.usageType === 'Storage-ShardHour' && r.Unit === 'ShardHour',
    putUnits: (r) => onDemand(r) && r.usageType === 'PutRequestPayloadUnits',
  });
  log('AWS: Step Functions…');
  // Standard workflows. The first 4,000 transitions a month are free on a
  // separate "Global-" row, which this matcher does not pick up.
  const states = await awsLookup('AmazonStates', {
    transition: (r) => onDemand(r) && r.usageType === 'USE1-StateTransition' && r.Unit === 'StateTransitions' && r.StartingRange === '0',
  });
  log('AWS: EventBridge Scheduler…');
  const scheduler = await awsLookup('AWSEvents', {
    invocationsPaid: (r) => onDemand(r) && r.usageType === 'USE1-ScheduledInvocation' && r.StartingRange === '14000000',
  });
  log('AWS: API Gateway WebSocket…');
  const websocket = await awsLookup('AmazonApiGateway', {
    messagesFirstTier: (r) => onDemand(r) && r.operation === 'ApiGatewayWebSocket' && r.usageType.endsWith('-ApiGatewayMessage') && r.StartingRange === '0',
  });
  log('AWS: Secrets Manager…');
  const secrets = await awsLookup('AWSSecretsManager', {
    perSecret: (r) => onDemand(r) && r.usageType.endsWith('-AWSSecretsManager-Secrets'),
    apiCalls: (r) => onDemand(r) && r.usageType.endsWith('-AWSSecretsManagerAPIRequest'),
  });
  log('AWS: Cloud Map…');
  const cloudmap = await awsLookup('AWSCloudMap', {
    discoveryCalls: (r) => onDemand(r) && r.usageType.endsWith('-Cloud-Map-DIR-API-Calls'),
    resources: (r) => onDemand(r) && r.usageType.endsWith('-Cloud-Map-Resources'),
  });
  log('AWS: SES…');
  const ses = await awsLookup('AmazonSES', {
    recipients: (r) => onDemand(r) && r.usageType === 'Recipients' && r['Product Family'] === 'Sending Email',
  });
  log('AWS: CloudWatch Logs…');
  const cloudwatch = await awsLookup('AmazonCloudWatch', {
    ingestGb: (r) => onDemand(r) && r.usageType === 'USE1-DataProcessing-Bytes' && r.operation === 'PutLogEvents',
  });
  log('AWS: Cognito (read for the note only)…');
  const cognito = await awsLookup('AmazonCognito', {
    userPoolsTier1: (r) => onDemand(r) && r.usageType === 'USE1-CognitoUserPoolsMAU' && r.StartingRange === '0',
    essentials: (r) => onDemand(r) && r.usageType === 'USE1-CognitoEssentialsMAU',
  });
  log('AWS: WAF…');
  const waf = await awsLookup('awswaf', {
    // Shield-protected accounts get these free; the plain rows are the list price.
    webAclMonth: (r) =>
      onDemand(r) && r.usageType.endsWith('-WebACLV2') && !/ShieldProtected/.test(r.usageType) && r.Unit === 'Month',
    requestsTier1: (r) =>
      onDemand(r) && r.usageType.endsWith('-RequestV2-Tier1') && !/ShieldProtected/.test(r.usageType) && r.Unit === 'Request',
  });

  // ---- Azure ---------------------------------------------------------
  log('Azure: VMs…');
  const b2s = await azureVmLinux('Standard_B2s');
  const d2s = await azureVmLinux('Standard_D2s_v5');
  const d4s = await azureVmLinux('Standard_D4s_v5');
  const d8s = await azureVmLinux('Standard_D8s_v5');
  log('Azure: PostgreSQL…');
  const pgCompute = await azureOne(
    `serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and productName eq 'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute' and skuName eq '2 vCore'`,
  );
  const pgStorage = await azureOne(
    `serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and productName eq 'Azure Database for PostgreSQL Flex Server Storage' and meterName eq 'Storage Data Stored'`,
  );
  log('Azure: Redis, LB, Service Bus, bandwidth…');
  const redisC1 = await azureOne(
    `serviceName eq 'Redis Cache' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and productName eq 'Azure Redis Cache Standard' and skuName eq 'C1'`,
  );
  const lb = await azureOne(
    `serviceName eq 'Load Balancer' and priceType eq 'Consumption' and armRegionName eq 'Global' and meterName eq 'Standard Included LB Rules and Outbound Rules'`,
  );
  const serviceBusBasic = await azureOne(
    `serviceName eq 'Service Bus' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and meterName eq 'Basic Messaging Operations'`,
  );
  log('Azure: Blob storage, Functions…');
  const blobFilter =
    `serviceName eq 'Storage' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and productName eq 'General Block Blob v2' and skuName eq 'Hot LRS'`;
  const blobStored = await azureOne(`${blobFilter} and meterName eq 'Hot LRS Data Stored'`, (items) => items.find((i) => i.tierMinimumUnits === 0));
  const blobWrites = await azureOne(`${blobFilter} and meterName eq 'Hot LRS Write Operations'`);
  const blobReads = await azureOne(`${blobFilter} and meterName eq 'Hot Read Operations'`);
  const fnFilter = `serviceName eq 'Functions' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and productName eq 'Functions' and skuName eq 'Standard'`;
  // The first tier of each is free; the paid tier is the list price.
  const fnExecutions = await azureOne(`${fnFilter} and meterName eq 'Standard Total Executions'`, (items) => items.find((i) => i.retailPrice > 0));
  const fnGbSeconds = await azureOne(`${fnFilter} and meterName eq 'Standard Execution Time'`, (items) => items.find((i) => i.retailPrice > 0));
  log('Azure: DNS, CDN…');
  const azureDnsQueries = await azureOne(
    `serviceName eq 'Azure DNS' and priceType eq 'Consumption' and meterName eq 'Public Queries' and armRegionName eq 'Zone 1'`,
    (items) => items.find((i) => i.tierMinimumUnits === 0),
  );
  const azureCdnTransfer = await azureOne(
    `serviceName eq 'Content Delivery Network' and priceType eq 'Consumption' and productName eq 'Azure CDN from Microsoft' and armRegionName eq 'Zone 1' and meterName eq 'Standard Data Transfer'`,
    (items) => items.find((i) => i.tierMinimumUnits === 0),
  );
  const azureCdnRequests = await azureOne(
    `serviceName eq 'Content Delivery Network' and priceType eq 'Consumption' and productName eq 'Azure CDN from Microsoft' and armRegionName eq 'Zone 1' and meterName eq 'Standard Requests'`,
    (items) => items.find((i) => i.tierMinimumUnits === 0),
  );
  const egress = await azureOne(
    `serviceName eq 'Bandwidth' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and meterName eq 'Standard Data Transfer Out'`,
    (items) =>
      items
        .filter((i) => /MGN/.test(i.productName) && i.tierMinimumUnits > 0)
        .sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0],
  );

  // ---- Assemble ------------------------------------------------------
  const awsServer = (id, type, sizeClass, label, description) => {
    const r = ec2.rows[type];
    return {
      id,
      provider: 'aws',
      providerName: 'Amazon Web Services',
      region: AWS_REGION,
      regionName: AWS_REGION_NAME,
      appliesTo: ['server'],
      sizeClass,
      label,
      description: `${description} ${r.vCPU} vCPU, ${r.Memory}. ${r['Physical Processor']}.`,
      verified: true,
      priceSourceUrl: awsUrl('AmazonEC2'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonEC2', ec2.publication, `Linux, shared tenancy. ${AWS_EGRESS_NOTE}`),
      charges: {
        compute: { unit: 'instance-hour', amount: amount(r.PricePerUnit) },
        egress: { unit: 'GB', amount: amount(transfer.rows.internetFirstTier.PricePerUnit) },
      },
    };
  };
  const azureServer = (id, item, vcpu, memoryGiB, sizeClass, label, description) => ({
    id,
    provider: 'azure',
    providerName: 'Microsoft Azure',
    region: AZURE_REGION,
    regionName: 'East US (Virginia)',
    appliesTo: ['server'],
    sizeClass,
    label,
    description: `${description} ${vcpu} vCPU, ${memoryGiB} GiB.`,
    verified: true,
    priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
    priceCheckedAt: today,
    priceNote: azureNote(`Linux, ${item.productName}. ${AZURE_EGRESS_NOTE}`),
    charges: {
      compute: { unit: 'instance-hour', amount: amount(item.retailPrice) },
      egress: { unit: 'GB', amount: amount(egress.retailPrice) },
    },
  });

  const profiles = [
    // ---- Application servers ----------------------------------------
    awsServer('aws.ec2.t3-medium.us-east-1', 't3.medium', 'small', 'EC2 t3.medium', 'Burstable general purpose.'),
    awsServer('aws.ec2.m7i-large.us-east-1', 'm7i.large', 'medium', 'EC2 m7i.large', 'General purpose.'),
    awsServer('aws.ec2.m7i-xlarge.us-east-1', 'm7i.xlarge', 'large', 'EC2 m7i.xlarge', 'General purpose.'),
    awsServer('aws.ec2.m7i-2xlarge.us-east-1', 'm7i.2xlarge', 'xlarge', 'EC2 m7i.2xlarge', 'General purpose.'),
    azureServer('azure.vm.b2s.eastus', b2s, 2, 4, 'small', 'VM Standard_B2s', 'Burstable general purpose.'),
    azureServer('azure.vm.d2s-v5.eastus', d2s, 2, 8, 'medium', 'VM Standard_D2s_v5', 'General purpose.'),
    azureServer('azure.vm.d4s-v5.eastus', d4s, 4, 16, 'large', 'VM Standard_D4s_v5', 'General purpose.'),
    azureServer('azure.vm.d8s-v5.eastus', d8s, 8, 32, 'xlarge', 'VM Standard_D8s_v5', 'General purpose.'),
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('server')),

    // ---- Load balancers ----------------------------------------------
    {
      id: 'aws.alb.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['loadBalancer'],
      label: 'Application Load Balancer',
      description: 'Managed layer-7 load balancer, billed per hour plus capacity units.',
      verified: true,
      priceSourceUrl: awsUrl('AWSELB'),
      priceCheckedAt: today,
      priceNote: awsNote('AWSELB', elb.publication, 'The hourly charge only. AWS also bills Load Balancer Capacity Units (connections, rules, bandwidth), which Aparecium does not model, so a busy balancer costs more than this.'),
      charges: {
        compute: { unit: 'balancer-hour', amount: amount(elb.rows.albHour.PricePerUnit) },
        egress: { unit: 'GB', amount: amount(transfer.rows.internetFirstTier.PricePerUnit) },
      },
    },
    {
      id: 'azure.lb.eastus',
      provider: 'azure', providerName: 'Microsoft Azure', region: AZURE_REGION, regionName: 'East US (Virginia)',
      appliesTo: ['loadBalancer'],
      label: 'Load Balancer (Standard)',
      description: 'Managed layer-4 load balancer, billed per hour plus data processed.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('Priced globally. The hourly charge covers five rules; Azure also bills per GB processed, which Aparecium does not model.'),
      charges: {
        compute: { unit: 'balancer-hour', amount: amount(lb.retailPrice) },
        egress: { unit: 'GB', amount: amount(egress.retailPrice) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('loadBalancer')),

    // ---- Databases ----------------------------------------------------
    {
      id: 'aws.rds.m7g-large-postgres.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['database', 'readReplica'],
      label: 'RDS PostgreSQL db.m7g.large, single AZ',
      description: `Managed relational database instance with separately billed storage. ${rds.rows['db.m7g.large'].vCPU} vCPU, ${rds.rows['db.m7g.large'].Memory}.`,
      verified: true,
      priceSourceUrl: awsUrl('AmazonRDS'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonRDS', rds.publication, 'Single-AZ; Multi-AZ roughly doubles the instance charge. Storage is General Purpose (gp3), billed per provisioned GB-month whether or not it is queried.'),
      charges: {
        compute: { unit: 'instance-hour', amount: amount(rds.rows['db.m7g.large'].PricePerUnit) },
        storage: { unit: 'GB-month', amount: amount(rds.rows.gp3.PricePerUnit) },
      },
    },
    {
      id: 'azure.postgres.d2ds-v5.eastus',
      provider: 'azure', providerName: 'Microsoft Azure', region: AZURE_REGION, regionName: 'East US (Virginia)',
      appliesTo: ['database', 'readReplica'],
      label: 'Azure Database for PostgreSQL Flexible Server, D2ds_v5',
      description: 'Managed PostgreSQL, General Purpose, 2 vCore, with separately billed storage.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('Azure prices this per vCore-hour; the amount here is the 2-vCore SKU. Storage is billed per GB-month.'),
      charges: {
        compute: { unit: 'instance-hour', amount: amount(pgCompute.retailPrice) },
        storage: { unit: 'GB-month', amount: amount(pgStorage.retailPrice) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('database') && !p.appliesTo.includes('server')),

    // ---- Caches -------------------------------------------------------
    {
      id: 'aws.elasticache.r7g-large-redis.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['cache'],
      label: 'ElastiCache Redis cache.r7g.large',
      description: 'Managed in-memory cache node. Memory is part of the node, not billed per GB.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonElastiCache'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonElastiCache', cache.publication, 'Cache capacity is included in the node price, so no separate storage charge applies.'),
      charges: {
        compute: { unit: 'node-hour', amount: amount(cache.rows['cache.r7g.large'].PricePerUnit) },
      },
    },
    {
      id: 'azure.redis.c1.eastus',
      provider: 'azure', providerName: 'Microsoft Azure', region: AZURE_REGION, regionName: 'East US (Virginia)',
      appliesTo: ['cache'],
      label: 'Azure Cache for Redis, Standard C1 (1 GB)',
      description: 'Managed Redis, replicated. Memory is part of the tier, not billed per GB.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('Cache capacity is included in the tier price, so no separate storage charge applies.'),
      charges: {
        compute: { unit: 'node-hour', amount: amount(redisC1.retailPrice) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('cache') && !p.appliesTo.includes('server')),

    // ---- Edge: DNS ----------------------------------------------------
    {
      id: 'aws.route53.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['dns'],
      label: 'Route 53 (standard queries)',
      description: 'Managed DNS. Billed per query answered; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsGlobalUrl('AmazonRoute53'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonRoute53', route53.publication, 'Route 53 is priced globally, not per region. First tier (up to one billion queries a month). AWS also charges $0.50 per hosted zone per month, which Aparecium does not model.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(Number(route53.rows.queriesFirstTier.PricePerUnit) * 1_000_000),
          note: 'One lookup = one billed query.',
        },
      },
    },
    {
      id: 'azure.dns.zone1',
      provider: 'azure', providerName: 'Microsoft Azure', region: 'zone1', regionName: 'Zone 1 (North America, Europe)',
      appliesTo: ['dns'],
      label: 'Azure DNS (public queries)',
      description: 'Managed DNS. Billed per query answered; nothing is provisioned.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('DNS is priced by zone, not region; Zone 1 covers North America and Europe. First tier (up to one billion queries a month). Azure also charges $0.50 per hosted zone per month, which Aparecium does not model.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(azureDnsQueries.retailPrice),
          note: 'One lookup = one billed query.',
        },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('dns')),

    // ---- Edge: CDN ----------------------------------------------------
    {
      id: 'aws.cloudfront.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['cdn'],
      label: 'CloudFront (United States edge)',
      description: 'Managed CDN. Billed per request and per GB sent to users; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsGlobalUrl('AmazonCloudFront'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonCloudFront', cloudfront.publication, 'CloudFront is priced by edge location, not by region; these are the United States rates. HTTPS requests. Transfer to users uses the first tier (up to 10 TB/month); AWS charges less beyond that, and gives 1 TB/month and 10 million requests free. Transfer from your origin to CloudFront is not modelled.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(Number(cloudfront.rows.usHttpsRequests.PricePerUnit) * 1_000_000),
          note: 'Every request through the CDN is billed, hit or miss.',
        },
        egress: { unit: 'GB', amount: amount(cloudfront.rows.usTransferFirstTier.PricePerUnit) },
      },
    },
    {
      id: 'azure.cdn.zone1',
      provider: 'azure', providerName: 'Microsoft Azure', region: 'zone1', regionName: 'Zone 1 (North America, Europe)',
      appliesTo: ['cdn'],
      label: 'Azure CDN from Microsoft (Standard)',
      description: 'Managed CDN. Billed per request and per GB sent to users; nothing is provisioned.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('CDN is priced by zone, not region; Zone 1 covers North America and Europe. First tier of transfer.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(azureCdnRequests.retailPrice),
          note: 'Every request through the CDN is billed, hit or miss.',
        },
        egress: { unit: 'GB', amount: amount(azureCdnTransfer.retailPrice) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('cdn')),

    // ---- Edge: WAF ----------------------------------------------------
    {
      id: 'aws.waf.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['waf'],
      label: 'AWS WAF (one web ACL)',
      description: 'Managed web application firewall. A monthly charge for the rule set, plus a charge per request inspected.',
      verified: true,
      priceSourceUrl: awsUrl('awswaf'),
      priceCheckedAt: today,
      priceNote: awsNote('awswaf', waf.publication, 'One web ACL, prorated hourly from the monthly charge, plus the first request tier. AWS also charges $1.00 per rule per month, which Aparecium does not model, so a real firewall costs a little more.'),
      charges: {
        compute: {
          unit: 'web ACL-hour',
          amount: amount(Number(waf.rows.webAclMonth.PricePerUnit) / 730),
          note: 'The monthly web ACL charge spread over 730 hours.',
        },
        requests: {
          unit: 'million requests',
          amount: amount(Number(waf.rows.requestsTier1.PricePerUnit) * 1_000_000),
          note: 'Every request inspected is billed, allowed or blocked.',
        },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('waf')),

    // ---- Edge: API gateway -------------------------------------------
    {
      id: 'aws.apigateway-http.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['apiGateway'],
      label: 'API Gateway (HTTP API)',
      description: 'Managed API front door. Billed per request; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonApiGateway'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonApiGateway', apigw.publication, 'HTTP API, first tier (up to 300 million requests a month). The first million requests a month are free for a year and are not modelled.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(Number(apigw.rows.httpApiFirstTier.PricePerUnit) * 1_000_000),
          note: 'Every request through the gateway is billed, forwarded or refused.',
        },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('apiGateway')),

    // ---- Queues -------------------------------------------------------
    {
      id: 'aws.sqs.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['queue', 'deadLetter'],
      label: 'SQS standard queue',
      description: 'A managed message queue. Nothing is provisioned: the whole charge is what passes through it.',
      verified: true,
      priceSourceUrl: awsUrl('AWSQueueService'),
      priceCheckedAt: today,
      priceNote: awsNote('AWSQueueService', sqs.publication, 'First tier, standard queue. AWS counts every API call as a request — send, receive and delete — so one message is billed as three requests, which the multiplier below applies. The first million requests a month are free and are not modelled.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(Number(sqs.rows.standardFirstTier.PricePerUnit) * 1_000_000),
          unitsPerOperation: 3,
          note: 'One message = send + receive + delete = three billed requests.',
        },
      },
    },
    {
      id: 'azure.servicebus.basic.eastus',
      provider: 'azure', providerName: 'Microsoft Azure', region: AZURE_REGION, regionName: 'East US (Virginia)',
      appliesTo: ['queue'],
      label: 'Service Bus queue, Basic tier',
      description: 'A managed message queue billed per operation, with nothing to provision.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('Basic tier. Azure counts send, receive and complete as separate operations, so one message is billed as three, which the multiplier below applies.'),
      charges: {
        requests: {
          unit: 'million requests',
          amount: amount(serviceBusBasic.retailPrice),
          unitsPerOperation: 3,
          note: 'One message = send + receive + complete = three billed operations.',
        },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('queue')),

    // ---- Specialised data stores -------------------------------------
    {
      id: 'aws.documentdb.r6g-large-io.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['documentDb'],
      label: 'DocumentDB db.r6g.large, I/O-Optimized',
      description: 'Managed document database, MongoDB-compatible. One instance billed per hour, storage per GB-month; reads and writes are included in the I/O-Optimized configuration.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonDocDB'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonDocDB', docdb.publication, 'One db.r6g.large instance in the I/O-Optimized configuration, which includes all I/O in the instance and storage rates, so there is no per-request charge to map. Backups beyond the free allowance are not modelled.'),
      charges: {
        compute: { unit: 'instance-hour', amount: amount(docdb.rows.r6gLargeIo.PricePerUnit, 6) },
        storage: { unit: 'GB-month', amount: amount(docdb.rows.ioStorage.PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('documentDb')),
    {
      id: 'aws.keyspaces.on-demand.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['wideColumn'],
      label: 'Keyspaces (for Apache Cassandra), on-demand',
      description: 'Managed wide-column store that scales itself. Billed per read, per write and per GB stored.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonMCS'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonMCS', keyspaces.publication, 'On-demand capacity. One read request unit per read and one write request unit per write, which holds for rows up to 4 KB read and 1 KB written; the synchronous write copies drawn on the component are how Keyspaces replicates internally and are not billed separately.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(keyspaces.rows.readUnits.PricePerUnit) * 1_000_000), note: 'One read = one billed read request unit.' },
        writes: { unit: 'million requests', amount: amount(Number(keyspaces.rows.writeUnits.PricePerUnit) * 1_000_000), note: 'One write = one billed write request unit.' },
        storage: { unit: 'GB-month', amount: amount(keyspaces.rows.storage.PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('wideColumn')),
    {
      id: 'aws.opensearch.r6g-large.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['searchIndex'],
      label: 'OpenSearch Service r6g.large.search',
      description: 'Managed search cluster. One data node billed per hour, plus its gp3 storage per GB-month; searches and indexing are not billed per request.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonES'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonES', opensearch.publication, 'One r6g.large.search data node with gp3 storage. A production domain usually has three or more nodes; multiply the compute line by your node count. Dedicated master nodes are not modelled.'),
      charges: {
        compute: { unit: 'node-hour', amount: amount(opensearch.rows.r6gLarge.PricePerUnit) },
        storage: { unit: 'GB-month', amount: amount(opensearch.rows.gp3.PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('searchIndex')),
    {
      id: 'aws.athena.s3.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['warehouse'],
      label: 'Athena over S3 Standard (per TB scanned)',
      description: 'Serverless reporting over files in S3. Billed per terabyte a report scans, plus S3 storage for the data; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonAthena'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonAthena', athena.publication, 'The scan rate is $5.00 per terabyte read, expressed here per GB (1,024 GB to the terabyte). Storage is the S3 Standard first-tier rate for the data the reports scan. Athena rounds each query up to 10 MB; that minimum is not modelled.'),
      charges: {
        scan: { unit: 'GB scanned', amount: amount(Number(athena.rows.scannedTb.PricePerUnit) / 1024, 6) },
        storage: { unit: 'GB-month', amount: amount(s3.rows.standardStorageFirstTier.PricePerUnit) },
      },
    },
    {
      id: 'aws.redshift.ra3-xlplus.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['warehouse'],
      label: 'Redshift ra3.xlplus, one node',
      description: 'A provisioned warehouse: one node billed per hour, plus managed storage per GB-month. Reports are not billed by what they scan.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonRedshift'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonRedshift', redshift.publication, 'One ra3.xlplus node with Redshift Managed Storage. Provisioned Redshift does not charge per scan, so the component\'s scanned volume affects time, not cost, on this profile. Concurrency scaling and Spectrum are not modelled.'),
      charges: {
        compute: { unit: 'node-hour', amount: amount(redshift.rows.ra3xlplus.PricePerUnit) },
        storage: { unit: 'GB-month', amount: amount(redshift.rows.rms.PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('warehouse')),
    {
      id: 'aws.timestream.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['timeSeries'],
      label: 'Timestream for LiveAnalytics',
      description: 'Managed time-series store. Billed per GB of points taken in and per GB-month kept in the magnetic store; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonTimestream'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonTimestream', timestream.publication, 'Ingestion is billed by the gigabyte: the run\'s writes times the record size drawn on the component. Storage is the magnetic store rate; the memory store ($0.036 per GB-hour) and queries ($0.01 per GB scanned) are not modelled, because this model does not measure what a query scans.'),
      charges: {
        ingest: { unit: 'GB', amount: amount(timestream.rows.ingestGb.PricePerUnit), note: 'Writes times record size.' },
        storage: { unit: 'GB-month', amount: amount(timestream.rows.magnetic.PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('timeSeries')),

    // ---- Background jobs ------------------------------------------------
    {
      id: 'aws.kinesis.provisioned.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['eventStream'],
      label: 'Kinesis Data Streams, provisioned shards',
      description: 'A managed event stream. Each partition is a shard billed per hour, and every record written is a payload unit.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonKinesis'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonKinesis', kinesis.publication, 'Provisioned mode. The hourly charge is per shard and is multiplied by the partitions drawn on the component. One payload unit per record up to 25 KB. Retention beyond 24 hours and enhanced fan-out are not modelled.'),
      charges: {
        compute: { unit: 'shard-hour', amount: amount(kinesis.rows.shardHour.PricePerUnit), note: 'One shard per partition.' },
        requests: { unit: 'million requests', amount: amount(Number(kinesis.rows.putUnits.PricePerUnit) * 1_000_000), note: 'One record written = one payload unit.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('eventStream')),
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('deadLetter')),
    {
      id: 'aws.eventbridge-scheduler.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['scheduler'],
      label: 'EventBridge Scheduler',
      description: 'Managed schedules. Billed per job started; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AWSEvents'),
      priceCheckedAt: today,
      priceNote: awsNote('AWSEvents', scheduler.publication, 'Paid tier. The first 14 million scheduled invocations a month are free and are not modelled.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(scheduler.rows.invocationsPaid.PricePerUnit) * 1_000_000), note: 'One job started = one billed invocation.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('scheduler')),
    {
      id: 'aws.stepfunctions.standard.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['workflow'],
      label: 'Step Functions (Standard workflows)',
      description: 'Managed workflows. Billed per state transition — every step executed, retries included; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonStates'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonStates', states.publication, 'Standard workflows. The first 4,000 state transitions a month are free per account and are not deducted. Express workflows bill per request and duration instead and are not modelled. The workers each step calls are priced on their own lines.'),
      charges: {
        requests: { unit: 'million state transitions', amount: amount(Number(states.rows.transition.PricePerUnit) * 1_000_000), note: 'One step executed, or retried, = one state transition.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('workflow')),

    // ---- Shared services and real-time -----------------------------------
    {
      id: 'aws.apigateway-websocket.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['websocket'],
      label: 'API Gateway WebSocket API',
      description: 'Managed WebSocket connections. Billed per message; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonApiGateway'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonApiGateway', websocket.publication, 'First message tier (up to one billion a month). AWS also bills $0.25 per million connection-minutes, which this model does not measure and does not include, so a chatty long-lived connection costs a little more than shown.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(websocket.rows.messagesFirstTier.PricePerUnit) * 1_000_000), note: 'One message either way = one billed message.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('websocket')),
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('rateLimiter')),
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('serviceMesh')),
    {
      id: 'aws.ec2.m7i-large.lock.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['lock'],
      label: 'EC2 m7i.large per cluster node (self-run etcd or ZooKeeper)',
      description: `No provider sells a lock service by the request, so a lock cluster is priced as the machines it runs on: one ${ec2.rows['m7i.large'].vCPU} vCPU, ${ec2.rows['m7i.large'].Memory} instance per node.`,
      verified: true,
      priceSourceUrl: awsUrl('AmazonEC2'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonEC2', ec2.publication, 'Linux, shared tenancy. The machine size is a judgement, not a provider product: etcd recommends 2 vCPU and 8 GB for a small cluster, which is an m7i.large. The node count comes from the canvas. Disks and traffic between the nodes are not included.'),
      charges: {
        compute: { unit: 'instance-hour', amount: amount(ec2.rows['m7i.large'].PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('lock')),

    // ---- Blockchain (entry 076) --------------------------------------------
    // Nothing here has a machine-readable price list, and gas and token prices
    // move by the minute, so every piece starts on its rate-less shape.
    ...['wallet', 'rpcNode', 'smartContract', 'indexer', 'oracle', 'ipfs'].flatMap((kind) =>
      ILLUSTRATIVE.filter((p) => p.appliesTo.includes(kind))),
    {
      id: 'aws.cognito.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['identity'],
      label: 'Cognito user pool (no rates applied)',
      description: 'A managed identity service billed per monthly active user, a unit this simulation does not measure, so its charge is reported as unpriced rather than as zero.',
      verified: false,
      priceSourceUrl: awsUrl('AmazonCognito'),
      priceCheckedAt: today,
      priceNote: `No rates applied. Cognito bills per monthly active user, not per check: the price list read on ${today} (published ${cognito.publication}) gives $${Number(cognito.rows.userPoolsTier1.PricePerUnit)} per MAU for the first 50,000 after the free tier on the User Pools tier, and $${Number(cognito.rows.essentials.PricePerUnit)} per MAU on the Essentials tier. The simulation measures access checks, and an active user count is not a monthly active user count, so no rate is applied.`,
      charges: {
        requests: { unit: 'million requests', amount: null, note: 'Billed per monthly active user, which the simulation does not measure.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('identity')),
    {
      id: 'aws.cloudmap.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['discovery'],
      label: 'Cloud Map',
      description: 'Managed service discovery. Billed per registered resource per month and per discovery call.',
      verified: true,
      priceSourceUrl: awsUrl('AWSCloudMap'),
      priceCheckedAt: today,
      priceNote: awsNote('AWSCloudMap', cloudmap.publication, 'One registered resource, its monthly charge spread over 730 hours, plus discovery API calls. DNS-based discovery through Route 53 is billed separately and is not modelled.'),
      charges: {
        compute: { unit: 'resource-hour', amount: amount(Number(cloudmap.rows.resources.PricePerUnit) / 730, 6), note: 'One registered resource, $0.10 a month spread over 730 hours.' },
        requests: { unit: 'million requests', amount: amount(Number(cloudmap.rows.discoveryCalls.PricePerUnit) * 1_000_000), note: 'One lookup = one billed API call.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('discovery')),
    {
      id: 'aws.secretsmanager.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['secrets'],
      label: 'Secrets Manager, one secret',
      description: 'Managed secrets. Billed per secret per month and per API call.',
      verified: true,
      priceSourceUrl: awsUrl('AWSSecretsManager'),
      priceCheckedAt: today,
      priceNote: awsNote('AWSSecretsManager', secrets.publication, 'One secret, its monthly charge spread over 730 hours, plus API calls. Rotation runs a Lambda function, whose cost is not modelled here.'),
      charges: {
        compute: { unit: 'secret-hour', amount: amount(Number(secrets.rows.perSecret.PricePerUnit) / 730, 6), note: 'One secret, $0.40 a month spread over 730 hours.' },
        requests: { unit: 'million requests', amount: amount(Number(secrets.rows.apiCalls.PricePerUnit) * 1_000_000), note: 'One fetch = one billed API call.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('secrets')),
    {
      id: 'aws.ses.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['notification'],
      label: 'SES outbound email',
      description: 'Managed email delivery. Billed per recipient; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonSES'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonSES', ses.publication, 'Email only, one recipient per notification. SMS and push notifications are billed by other services at other rates. Attachments and dedicated IPs are not modelled.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(ses.rows.recipients.PricePerUnit) * 1_000_000), note: 'One delivery attempt = one recipient billed.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('notification')),
    {
      id: 'aws.cloudwatch-logs.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['monitoring'],
      label: 'CloudWatch Logs, Standard class',
      description: 'Managed logging. Billed per GB of records taken in; nothing is provisioned.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonCloudWatch'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonCloudWatch', cloudwatch.publication, 'Ingestion into the Standard log class: the run\'s records times the record size drawn on the component. Log storage ($0.03 per GB-month) is not modelled — at the default sixty-second retention it is negligible — and custom metrics, alarms and dashboards are separate charges not included here.'),
      charges: {
        ingest: { unit: 'GB', amount: amount(cloudwatch.rows.ingestGb.PricePerUnit), note: 'Records times record size.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('monitoring')),

    // ---- Pub/sub topics ----------------------------------------------
    {
      id: 'aws.sns.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['pubsub'],
      label: 'SNS standard topic',
      description: 'A managed topic: one publish, a copy to every subscriber. Billed per publish; delivery to queues is free.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonSNS'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonSNS', sns.publication, 'Paid tier. The first million requests a month are free and are not modelled. Delivery to SQS queues and Lambda is free; HTTP and email deliveries cost extra and are not modelled.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(sns.rows.requestsPaidTier.PricePerUnit) * 1_000_000), note: 'One publish = one billed request, however many listeners copy it.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('pubsub') && !p.appliesTo.includes('queue')),

    // ---- Serverless functions ----------------------------------------
    {
      id: 'aws.lambda.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['serverless'],
      label: 'Lambda (x86)',
      description: 'Code run per request with nothing provisioned. Billed per invocation and per gigabyte-second alive.',
      verified: true,
      priceSourceUrl: awsUrl('AWSLambda'),
      priceCheckedAt: today,
      priceNote: awsNote('AWSLambda', lambda.publication, 'x86, first duration tier (up to 6 billion GB-seconds a month). The free tier — a million requests and 400,000 GB-seconds a month — is not modelled.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(lambda.rows.requests.PricePerUnit) * 1_000_000), note: 'One invocation = one billed request.' },
        duration: { unit: 'GB-second', amount: amount(lambda.rows.gbSecondsTier1.PricePerUnit), note: 'Wall-clock time alive times memory allotted, rounded to the millisecond by the provider.' },
      },
    },
    {
      id: 'azure.functions.consumption.eastus',
      provider: 'azure', providerName: 'Microsoft Azure', region: AZURE_REGION, regionName: 'East US (Virginia)',
      appliesTo: ['serverless'],
      label: 'Azure Functions, Consumption plan',
      description: 'Code run per request with nothing provisioned. Billed per execution and per gigabyte-second alive.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('Consumption plan, paid tiers. The free grant — a million executions and 400,000 GB-seconds a month — is not modelled.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(fnExecutions.retailPrice * 100_000), note: 'One execution = one billed request.' },
        duration: { unit: 'GB-second', amount: amount(fnGbSeconds.retailPrice), note: 'Wall-clock time alive times memory allotted.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('serverless')),

    // ---- Key-value stores ----------------------------------------------
    {
      id: 'aws.dynamodb.on-demand.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['kvStore'],
      label: 'DynamoDB, on-demand',
      description: 'A managed key-value store that scales itself. Billed per read, per write and per GB stored.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonDynamoDB'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonDynamoDB', dynamo.publication, 'On-demand (pay per request), standard table class. One read request unit per read and one write request unit per write, which holds for items up to 4 KB read and 1 KB written; larger items cost more units. The first 25 GB of storage a month are free and are not modelled.'),
      charges: {
        requests: { unit: 'million requests', amount: amount(Number(dynamo.rows.readUnits.PricePerUnit) * 1_000_000), note: 'One read = one billed read request unit.' },
        writes: { unit: 'million requests', amount: amount(Number(dynamo.rows.writeUnits.PricePerUnit) * 1_000_000), note: 'One write = one billed write request unit.' },
        storage: { unit: 'GB-month', amount: amount(dynamo.rows.storage.PricePerUnit) },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('kvStore')),

    // ---- Object storage ------------------------------------------------
    {
      id: 'aws.s3.standard.us-east-1',
      provider: 'aws', providerName: 'Amazon Web Services', region: AWS_REGION, regionName: AWS_REGION_NAME,
      appliesTo: ['objectStorage'],
      label: 'S3 Standard',
      description: 'Managed object storage. Billed per GB kept, per read and per write.',
      verified: true,
      priceSourceUrl: awsUrl('AmazonS3'),
      priceCheckedAt: today,
      priceNote: awsNote('AmazonS3', s3.publication, 'S3 Standard, first storage tier (up to 50 TB). Reads are GET requests and writes are PUT requests. Transfer out to the internet is billed separately and is not on this profile, since the server in front of the bucket carries the response.'),
      charges: {
        storage: { unit: 'GB-month', amount: amount(s3.rows.standardStorageFirstTier.PricePerUnit) },
        requests: { unit: 'million requests', amount: amount(Number(s3.rows.getRequests.PricePerUnit) * 1_000_000), note: 'One read = one GET request.' },
        writes: { unit: 'million requests', amount: amount(Number(s3.rows.putRequests.PricePerUnit) * 1_000_000), note: 'One write = one PUT request.' },
      },
    },
    {
      id: 'azure.blob.hot-lrs.eastus',
      provider: 'azure', providerName: 'Microsoft Azure', region: AZURE_REGION, regionName: 'East US (Virginia)',
      appliesTo: ['objectStorage'],
      label: 'Blob Storage, Hot, LRS',
      description: 'Managed object storage. Billed per GB kept, per read and per write.',
      verified: true,
      priceSourceUrl: 'https://prices.azure.com/api/retail/prices',
      priceCheckedAt: today,
      priceNote: azureNote('General-purpose v2 block blobs, Hot tier, locally redundant, first storage tier (up to 50 TB).'),
      charges: {
        storage: { unit: 'GB-month', amount: amount(blobStored.retailPrice) },
        requests: { unit: 'million requests', amount: amount(blobReads.retailPrice * 100), note: 'One read = one read operation.' },
        writes: { unit: 'million requests', amount: amount(blobWrites.retailPrice * 100), note: 'One write = one write operation.' },
      },
    },
    ...ILLUSTRATIVE.filter((p) => p.appliesTo.includes('objectStorage')),
  ];

  const notice =
    `AWS and Azure profiles in this file were read from the providers' own machine-readable price lists — the AWS Price List Bulk API and the Azure Retail Prices API — by scripts/refresh-cloud-prices.mjs on ${today}, and carry the provider's publication date in their priceNote. They are on-demand, single-instance, Linux rates in one region each, and are exact quotes of those lists on that date; prices change, and the same script refreshes them. Google Cloud profiles are ILLUSTRATIVE placeholders: the Cloud Billing Catalog API needs an API key (set GCP_BILLING_API_KEY to read it), and the pricing web page carries no figures as text. Self-managed profiles have no rates by design. Every profile says which of these it is in its verified flag and priceNote.`;

  return {
    catalogId: 'cloud-profiles',
    version: 1,
    currency: 'USD',
    publishedAt: today,
    notice,
    profiles,
  };
}

/* ---------------------------------------------- unverified, unchanged */

/**
 * Profiles no open source could price. Kept exactly as they were, labelled as
 * placeholders, so the app can still show a Google Cloud shape and say so.
 */
const gcpNote =
  'Placeholder rate. Google Cloud publishes prices only through the Cloud Billing Catalog API, which needs an API key, and its pricing web page renders the table with JavaScript so nothing could be read from the page text. Nothing here was verified.';
const gcp = (fields) => ({
  provider: 'gcp',
  providerName: 'Google Cloud',
  region: 'us-central1',
  regionName: 'Iowa (us-central1)',
  verified: false,
  priceCheckedAt: '2026-09-09',
  priceNote: gcpNote,
  ...fields,
});
/**
 * The sixteen newest kinds' self-managed shapes live in their own file, so a
 * deployment nobody can price still has an honest, rate-less profile to pick.
 */
const ADDITIONAL = JSON.parse(
  await readFile(new URL('../public/catalogs/additional-profiles.v1.json', import.meta.url), 'utf8'),
);

const ILLUSTRATIVE = [
  ...ADDITIONAL,
  gcp({
    id: 'gcp.gce.e2-standard-2.us-central1', appliesTo: ['server'], sizeClass: 'medium',
    label: 'Compute Engine e2-standard-2 (illustrative)',
    description: 'General purpose, roughly 2 vCPU and 8 GiB.',
    priceSourceUrl: 'https://cloud.google.com/compute/vm-instance-pricing',
    charges: { compute: { unit: 'instance-hour', amount: '0.07' }, egress: { unit: 'GB', amount: null, note: 'Tiered by destination; no single per-GB rate applies.' } },
  }),
  gcp({
    id: 'gcp.gce.n2-standard-4.us-central1', appliesTo: ['server'], sizeClass: 'large',
    label: 'Compute Engine n2-standard-4 (illustrative)',
    description: 'General purpose, roughly 4 vCPU and 16 GiB.',
    priceSourceUrl: 'https://cloud.google.com/compute/vm-instance-pricing',
    charges: { compute: { unit: 'instance-hour', amount: '0.20' }, egress: { unit: 'GB', amount: null, note: 'Tiered by destination; no single per-GB rate applies.' } },
  }),
  gcp({
    id: 'gcp.lb.us-central1', appliesTo: ['loadBalancer'],
    label: 'Cloud Load Balancing forwarding rule (illustrative)',
    description: 'Managed load balancer, billed per forwarding rule per hour plus processed data.',
    priceSourceUrl: 'https://cloud.google.com/vpc/network-pricing',
    charges: { compute: { unit: 'forwarding-rule-hour', amount: '0.03' }, egress: { unit: 'GB', amount: null, note: 'Tiered by destination; no single per-GB rate applies.' } },
  }),
  gcp({
    id: 'gcp.cloudsql.postgres-2vcpu-8gb.us-central1', appliesTo: ['database', 'readReplica'],
    label: 'Cloud SQL for PostgreSQL, 2 vCPU 8 GB (illustrative)',
    description: 'Managed relational database instance with separately billed storage.',
    priceSourceUrl: 'https://cloud.google.com/sql/pricing',
    charges: { compute: { unit: 'instance-hour', amount: '0.20' }, storage: { unit: 'GB-month', amount: '0.17' } },
  }),
  gcp({
    id: 'gcp.memorystore.redis-basic-4gb.us-central1', appliesTo: ['cache'],
    label: 'Memorystore for Redis, Basic 4 GB (illustrative)',
    description: 'Managed in-memory cache. Billed per GB-hour of provisioned capacity.',
    priceSourceUrl: 'https://cloud.google.com/memorystore/docs/redis/pricing',
    charges: { compute: { unit: 'instance-hour', amount: '0.20' } },
  }),
  gcp({
    id: 'gcp.pubsub.us-central1', appliesTo: ['queue', 'pubsub'],
    label: 'Pub/Sub topic (illustrative)',
    description: 'A managed message service charged by volume, with nothing to provision up front.',
    priceSourceUrl: 'https://cloud.google.com/pubsub/pricing',
    charges: { requests: { unit: 'million requests', amount: '0.40', note: 'Illustrative. Pub/Sub is charged by data volume rather than per message; this profile approximates it per message so the shape of the bill is visible.' } },
  }),
  {
    id: 'self-managed.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['server', 'database', 'readReplica', 'cache'],
    label: 'Self-managed hardware (no rates)',
    description: 'Hardware you already own. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-09',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: {
      compute: { unit: 'instance-hour', amount: null, note: 'Depends on your own hardware and amortisation.' },
      storage: { unit: 'GB-month', amount: null, note: 'Depends on your own storage.' },
    },
  },
  {
    id: 'self-managed.dns.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['dns'],
    label: 'Self-managed DNS (no rates)',
    description: 'A resolver you run yourself, such as BIND or CoreDNS. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { requests: { unit: 'million requests', amount: null, note: 'Depends on the hardware you run the resolver on.' } },
  },
  {
    id: 'self-managed.cdn.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['cdn'],
    label: 'Self-managed edge cache (no rates)',
    description: 'Caching proxies you run yourself, such as Varnish or nginx at the edge. Aparecium has no rates for them, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: {
      requests: { unit: 'million requests', amount: null, note: 'Depends on the hardware you run the caches on.' },
      egress: { unit: 'GB', amount: null, note: 'Depends on your own network contract.' },
    },
  },
  {
    id: 'self-managed.waf.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['waf'],
    label: 'Self-managed WAF / reverse proxy (no rates)',
    description: 'A proxy you run yourself, such as nginx with ModSecurity or HAProxy. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { compute: { unit: 'instance-hour', amount: null, note: 'Depends on the hardware you run the proxy on.' } },
  },
  {
    id: 'self-managed.apigateway.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['apiGateway'],
    label: 'Self-managed API gateway (no rates)',
    description: 'A gateway you run yourself, such as Kong or Envoy. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { compute: { unit: 'instance-hour', amount: null, note: 'Depends on the hardware you run the gateway on.' } },
  },
  {
    id: 'self-managed.serverless.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['serverless'],
    label: 'Self-hosted functions (no rates)',
    description: 'A functions platform you run yourself, such as OpenFaaS or Knative. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { compute: { unit: 'instance-hour', amount: null, note: 'Depends on the hardware you run the platform on.' } },
  },
  {
    id: 'self-managed.kvstore.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['kvStore'],
    label: 'Self-managed key-value store (no rates)',
    description: 'A store you run yourself, such as MongoDB, Cassandra or ScyllaDB. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: {
      compute: { unit: 'instance-hour', amount: null, note: 'Depends on the hardware you run the store on.' },
      storage: { unit: 'GB-month', amount: null, note: 'Depends on your own storage.' },
    },
  },
  {
    id: 'self-managed.objectstorage.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['objectStorage'],
    label: 'Self-managed object storage (no rates)',
    description: 'Storage you run yourself, such as MinIO or Ceph. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { storage: { unit: 'GB-month', amount: null, note: 'Depends on your own disks.' } },
  },
  {
    id: 'self-managed.pubsub.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['pubsub'],
    label: 'Self-managed topic (no rates)',
    description: 'A broker with topics you run yourself, such as RabbitMQ exchanges or Kafka. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-12',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { requests: { unit: 'million requests', amount: null, note: 'Depends on the hardware you run the broker on.' } },
  },
  {
    id: 'self-managed.queue.unpriced', provider: 'self-managed', providerName: 'Self-managed / on-premises',
    region: 'your-datacentre', regionName: 'Your own hardware', appliesTo: ['queue'],
    label: 'Self-managed broker (no rates)',
    description: 'A broker you run yourself, such as RabbitMQ or Kafka. Aparecium has no rates for it, so every charge is reported as unpriced rather than as zero.',
    verified: false, priceSourceUrl: '', priceCheckedAt: '2026-09-10',
    priceNote: 'Deliberately has no amounts. Use this to see how Aparecium reports a charge it cannot price.',
    charges: { requests: { unit: 'million requests', amount: null, note: 'Depends on the hardware you run the broker on.' } },
  },
];

/* ------------------------------------------------------------------ main */

const catalog = await build();
const text = `${JSON.stringify(catalog, null, 2)}\n`;

if (CHECK) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => '');
  const strip = (s) => s.replace(/"(publishedAt|priceCheckedAt)": "[^"]*"/g, '').replace(/on \d{4}-\d{2}-\d{2}/g, '');
  if (strip(current) === strip(text)) {
    console.log('Catalog is up to date with the providers.');
  } else {
    console.log('Catalog differs from what the providers publish now. Run without --check to update it.');
    process.exit(1);
  }
} else {
  await writeFile(OUTPUT, text);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)} with ${catalog.profiles.length} profiles.`);
}
