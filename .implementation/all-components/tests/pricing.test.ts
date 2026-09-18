import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation } from '../src/simulation/engine';
import { HOURS_PER_MONTH, SECONDS_PER_MONTH } from '../src/domain/units';
import type { ArchNode } from '../src/domain/types';
import { client, database, doc, edge, queue, server, INSTANT } from './helpers';

const catalog = cloudCatalogSchema.parse(rawCatalog);

function withProfile(node: ArchNode, profileId: string | null): ArchNode {
  return { ...node, cloud: { profileId } };
}

describe('a message queue is charged for what went through it', () => {
  it('projects a monthly message count from the measured rate, never the run total', () => {
    // 1,000 messages in 10 measured seconds. AWS bills send, receive and
    // delete as separate requests, so that is 3,000 requests, 300 a second.
    // Over a 730-hour month: 300 * 730 * 3600 = 788,400,000, or 788.4 million,
    // at the published 0.40 per million = 315.36.
    const estimate = estimateCost({
      document: doc([withProfile(queue('q1'), 'aws.sqs.us-east-1')], []),
      catalog,
      usage: {
        measuredSeconds: 10,
        egressBytes: 0,
        totalBytes: 0,
        completedRequests: 0,
        egressByNodeId: {},
        requestsByNodeId: { q1: 1000 },
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
    });
    const metered = estimate.lines.find((l) => l.chargeType === 'requests');
    expect(metered?.quantity).toBe('788.4000');
    expect(metered?.monthly).toBe('315.36');
    expect(estimate.totalMonthly).toBe('315.36');
    expect(metered?.basis).toContain('3 requests per message');
  });

  it('bills one request per message where the catalog says nothing else', () => {
    // The multiplier is the provider's rule, stated on the profile. A profile
    // without one counts a message as one request — which is what the Pub/Sub
    // placeholder does, and says so.
    const estimate = estimateCost({
      document: doc([withProfile(queue('q1'), 'gcp.pubsub.us-central1')], []),
      catalog,
      usage: {
        measuredSeconds: 10,
        egressBytes: 0,
        totalBytes: 0,
        completedRequests: 0,
        egressByNodeId: {},
        requestsByNodeId: { q1: 1000 },
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
    });
    const metered = estimate.lines.find((l) => l.chargeType === 'requests');
    expect(metered?.quantity).toBe('262.8000');
    expect(metered?.basis).not.toContain('per message');
  });

  it('reports a broker with no rate as unpriced, not as free', () => {
    const estimate = estimateCost({
      document: doc([withProfile(queue('q1'), 'self-managed.queue.unpriced')], []),
      catalog,
      usage: {
        measuredSeconds: 10,
        egressBytes: 0,
        totalBytes: 0,
        completedRequests: 0,
        egressByNodeId: {},
        requestsByNodeId: { q1: 1000 },
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
    });
    const metered = estimate.lines.find((l) => l.chargeType === 'requests');
    expect(metered?.unpriced).toBe(true);
    expect(metered?.monthly).toBeNull();
    expect(estimate.unpricedLineCount).toBe(1);
    expect(estimate.pricedLineCount).toBe(0);
    expect(estimate.totalMonthly).toBe('0.00');
    expect(estimate.warnings.join(' ')).toContain('Unpriced does not mean free');
  });
});

describe('the catalog itself', () => {
  it('uses the requested monthly hours for outbound projections', () => {
    const estimate = estimateCost({ document: doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []),
      catalog, hoursPerMonth: 100, usage: { measuredSeconds: 1, egressBytes: 1e9, totalBytes: 1e9,
        completedRequests: 1, egressByNodeId: { s1: 1e9 }, requestsByNodeId: {}, writesByNodeId: {}, busyMsByNodeId: {} } });
    expect(estimate.lines.find((l) => l.chargeType === 'egress')?.quantity).toBe('360000.000');
  });
  it('validates against the schema and is honestly labelled, both ways', () => {
    expect(catalog.catalogId).toBe('cloud-profiles');
    expect(catalog.profiles.length).toBeGreaterThan(4);
    // At least two providers with verified rates, as the specification asks
    // for, and every profile says which kind it is.
    const verified = catalog.profiles.filter((p) => p.verified);
    expect(new Set(verified.map((p) => p.provider))).toEqual(new Set(['aws', 'azure']));
    for (const p of verified) {
      // A verified rate names the machine-readable source it was read from.
      expect(p.priceSourceUrl, p.id).toMatch(/^https:\/\/(pricing\.us-east-1\.amazonaws\.com|prices\.azure\.com)\//);
      expect(p.priceNote, p.id).toMatch(/Read from the (AWS Price List Bulk API|Azure Retail Prices API)/);
      expect(p.label, p.id).not.toMatch(/illustrative/i);
    }
    for (const p of catalog.profiles.filter((x) => !x.verified)) {
      // An unverified rate says so in its label or note, never silently.
      expect(`${p.label} ${p.priceNote}`, p.id).toMatch(/illustrative|placeholder|no rates|no amounts/i);
    }
    expect(catalog.notice).toMatch(/ILLUSTRATIVE/);
    expect(catalog.notice).toMatch(/refresh-cloud-prices/);
    for (const p of catalog.profiles) {
      // An entry with no rates has no retrieval date to invent.
      if (p.verified || Object.values(p.charges).some((c) => c.amount !== null) || p.priceCheckedAt !== '') {
        expect(p.priceCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});

describe('acceptance 10 — fixed costs remain for idle provisioned resources', () => {
  it('charges a disconnected database for compute and storage', () => {
    const idle = withProfile(
      database('spare', { dataSizeGb: 50 }),
      'aws.rds.m7g-large-postgres.us-east-1',
    );
    const estimate = estimateCost({
      document: doc([idle], []),
      catalog,
      usage: null,
    });

    const compute = estimate.lines.find((l) => l.key === 'spare:compute')!;
    const storage = estimate.lines.find((l) => l.key === 'spare:storage')!;
    // RDS db.m7g.large: 0.168 per instance-hour x 730 hours = 122.64
    expect(compute.monthly).toBe('122.64');
    expect(compute.basis).toContain('does not depend on how much traffic');
    // gp3 storage: 0.115 per GB-month x 50 GB = 5.75
    expect(storage.monthly).toBe('5.75');
    expect(estimate.totalMonthly).toBe('128.39');
  });

  it('still charges a component that handled no traffic in a real run', () => {
    const document = doc(
      [
        client('c1', { requestRateOverridePerSecond: 5 }),
        withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1'),
        withProfile(database('d1', { dataSizeGb: 10 }), 'aws.rds.m7g-large-postgres.us-east-1'),
        withProfile(database('idle', { dataSizeGb: 10 }), 'aws.rds.m7g-large-postgres.us-east-1'),
      ],
      [edge('c1', 's1', INSTANT), edge('s1', 'd1', INSTANT)],
      { durationSeconds: 2, drainSeconds: 2 },
    );
    const result = runSimulation(document);
    const estimate = estimateCost({ document, catalog, usage: result.usage });

    const idleCompute = estimate.lines.find((l) => l.key === 'idle:compute')!;
    expect(idleCompute.monthly).toBe('122.64');
    // It moved no bytes, so its outbound transfer projection is zero...
    const idleEgress = estimate.lines.find((l) => l.key === 'idle:egress');
    expect(idleEgress).toBeUndefined(); // the RDS profile has no egress charge
    // ...but the server did move bytes.
    const serverEgress = estimate.lines.find((l) => l.key === 's1:egress')!;
    expect(Number(serverEgress.quantity)).toBeGreaterThan(0);
  });
});

describe('acceptance 11 — a missing rate is unpriced, not zero', () => {
  it('reports the charge, excludes it from the total, and says why', () => {
    const node = withProfile(server('s1'), 'self-managed.unpriced');
    const estimate = estimateCost({ document: doc([node], []), catalog, usage: null });

    const compute = estimate.lines.find((l) => l.key === 's1:compute')!;
    expect(compute.unpriced).toBe(true);
    expect(compute.monthly).toBeNull();
    expect(compute.rate).toBeNull();
    expect(compute.unpricedReason).toContain('your own hardware');
    expect(estimate.totalMonthly).toBe('0.00');
    expect(estimate.unpricedLineCount).toBe(1);
    expect(estimate.warnings.join(' ')).toContain('Unpriced does not mean free');
  });

  it('flags a component with no cloud profile at all', () => {
    const estimate = estimateCost({
      document: doc([withProfile(server('s1'), null)], []),
      catalog,
      usage: null,
    });
    expect(estimate.lines[0]!.unpriced).toBe(true);
    expect(estimate.lines[0]!.unpricedReason).toContain('No cloud profile');
  });

  it('treats a deliberately unpriced charge inside a priced profile as unpriced', () => {
    // The Google Cloud profiles leave outbound transfer unpriced on purpose,
    // because it is tiered by destination.
    const document = doc(
      [
        client('c1', { requestRateOverridePerSecond: 5 }),
        withProfile(server('s1'), 'gcp.gce.e2-standard-2.us-central1'),
      ],
      [edge('c1', 's1', INSTANT)],
      { durationSeconds: 2, drainSeconds: 2 },
    );
    const result = runSimulation(document);
    const estimate = estimateCost({ document, catalog, usage: result.usage });
    const egress = estimate.lines.find((l) => l.key === 's1:egress')!;
    expect(egress.unpriced).toBe(true);
    expect(egress.unpricedReason).toContain('Tiered by destination');
    // The compute charge is still priced: 0.07 x 730
    expect(estimate.lines.find((l) => l.key === 's1:compute')!.monthly).toBe('51.10');
  });
});

describe('acceptance 12 — units and projection arithmetic', () => {
  it('multiplies the hourly rate by exactly 730 hours', () => {
    const estimate = estimateCost({
      document: doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []),
      catalog,
      usage: null,
    });
    const compute = estimate.lines.find((l) => l.key === 's1:compute')!;
    expect(estimate.hoursPerMonth).toBe(HOURS_PER_MONTH);
    expect(compute.quantity).toBe('730');
    expect(compute.quantityUnit).toBe('instance-hour');
    expect(compute.rateUnit).toBe('USD per instance-hour');
    // m7i.large is 0.1008 an hour: 0.1008 x 730 = 73.584, rounded half-up to
    // 73.58 at the line. Decimal arithmetic; a binary float would drift.
    expect(compute.monthly).toBe('73.58');
  });

  it('projects outbound transfer from a measured rate, not from the run total', () => {
    const measuredSeconds = 20;
    const egressBytes = 1_000_000_000;
    const estimate = estimateCost({
      document: doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []),
      catalog,
      usage: {
        measuredSeconds,
        egressBytes,
        totalBytes: egressBytes,
        completedRequests: 100,
        egressByNodeId: { s1: egressBytes },
    requestsByNodeId: {},
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
    });
    const egress = estimate.lines.find((l) => l.key === 's1:egress')!;

    // 1 GB over 20 s = 0.05 GB/s. Over a 730-hour month (2,628,000 s) that is
    // 131,400 GB, at 0.09 per GB = 11,826.00.
    const gbPerMonth = (egressBytes / measuredSeconds) * (SECONDS_PER_MONTH / 1_000_000_000);
    expect(gbPerMonth).toBeCloseTo(131_400, 6);
    expect(egress.quantity).toBe('131400.000');
    expect(egress.monthly).toBe('11826.00');
    expect(egress.basis).toContain('50.000 MB per second');
    expect(estimate.projectionNote).toContain('20.00 seconds');
  });

  it('doubling the run duration does not double the monthly projection', () => {
    const base = {
      document: doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []),
      catalog,
    };
    const short = estimateCost({
      ...base,
      usage: {
        measuredSeconds: 10,
        egressBytes: 1e9,
        totalBytes: 1e9,
        completedRequests: 10,
        egressByNodeId: { s1: 1e9 },
    requestsByNodeId: {},
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
    });
    const long = estimateCost({
      ...base,
      usage: {
        measuredSeconds: 20,
        egressBytes: 2e9,
        totalBytes: 2e9,
        completedRequests: 20,
        egressByNodeId: { s1: 2e9 },
    requestsByNodeId: {},
        writesByNodeId: {},
        busyMsByNodeId: {},
      },
    });
    // Same rate of traffic, twice as long: the monthly number must be identical.
    expect(long.totalMonthly).toBe(short.totalMonthly);
  });

  it('honours an edited rate and marks the line as edited', () => {
    const document = doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []);
    document.pricingOverrides = { 'aws.ec2.m7i-large.us-east-1': { compute: '0.25' } };
    const estimate = estimateCost({ document, catalog, usage: null });
    const compute = estimate.lines.find((l) => l.key === 's1:compute')!;
    expect(compute.rate).toBe('0.25');
    expect(compute.edited).toBe(true);
    expect(compute.verified).toBe(false);
    expect(compute.monthly).toBe('182.50');
  });

  it('lets an edit remove a rate, making the charge unpriced', () => {
    const document = doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []);
    document.pricingOverrides = { 'aws.ec2.m7i-large.us-east-1': { compute: null } };
    const estimate = estimateCost({ document, catalog, usage: null });
    expect(estimate.lines.find((l) => l.key === 's1:compute')!.unpriced).toBe(true);
    expect(estimate.totalMonthly).toBe('0.00');
  });

  it('never prices a client, and lists what is excluded', () => {
    const estimate = estimateCost({
      document: doc([client('c1'), withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []),
      catalog,
      usage: null,
    });
    expect(estimate.lines.some((l) => l.nodeId === 'c1')).toBe(false);
    // Load balancers are modelled and priced now; only their capacity-unit and
    // processed-data charges are outside the model.
    expect(estimate.excluded.join(' ')).toContain('Load balancer capacity units');
    expect(estimate.included.join(' ')).toContain('Fixed compute');
  });

  it('says outbound transfer is missing when there has been no run', () => {
    const estimate = estimateCost({
      document: doc([withProfile(server('s1'), 'aws.ec2.m7i-large.us-east-1')], []),
      catalog,
      usage: null,
    });
    expect(estimate.hasRun).toBe(false);
    expect(estimate.warnings.join(' ')).toContain('has not been run yet');
    expect(estimate.lines.some((l) => l.chargeType === 'egress')).toBe(false);
  });
});
