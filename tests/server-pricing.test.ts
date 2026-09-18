import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { normaliseServerPricing } from '../src/catalogs/server-pricing';
import { architectureDocumentSchema } from '../src/domain/schema';
import { doc, server } from './helpers';

const catalog = cloudCatalogSchema.parse(rawCatalog);
const medium = 'aws.ec2.m7i-large.us-east-1';
const large = 'aws.ec2.m7i-xlarge.us-east-1';

describe('server pricing at document boundaries', () => {
  it('repairs old preset pricing without changing the input, software or overrides', () => {
    const node = server('s', { profile: 'large', cpuSlots: 4, ramMb: 8192, cpuMsPerRequest: 37 });
    node.cloud = { profileId: medium };
    const original = doc([node], []);
    const fixed = normaliseServerPricing(original, catalog);
    expect(fixed.nodes[0]!.cloud.profileId).toBe(large);
    expect(original.nodes[0]!.cloud.profileId).toBe(medium);
    expect(fixed.nodes[0]!.settings).toEqual(node.settings);
    expect(fixed.pricingOverrides).toEqual(original.pricingOverrides);
    expect(normaliseServerPricing(fixed, catalog)).toBe(fixed);
  });

  it('retains provider and region through an unavailable size and JSON validation', () => {
    const node = server('s', { profile: 'small' });
    node.cloud = { profileId: 'gcp.gce.e2-standard-2.us-central1' };
    const unavailable = normaliseServerPricing(doc([node], []), catalog);
    expect(unavailable.nodes[0]!.cloud.profileId).toBeNull();
    const restored = architectureDocumentSchema.parse(JSON.parse(JSON.stringify(unavailable)));
    const target = restored.nodes[0]!;
    if (target.kind !== 'server') throw new Error('not a server');
    target.settings.profile = 'large';
    expect(normaliseServerPricing(restored, catalog).nodes[0]!.cloud.profileId)
      .toBe('gcp.gce.n2-standard-4.us-central1');
  });

  it('preserves explicit manual rates, on named sizes and on custom hardware alike', () => {
    const manual = server('manual', { profile: 'large' });
    manual.cloud = { profileId: medium, pricingMode: 'manual' };
    const customManual = server('custom', { profile: 'custom', cpuSlots: 17 });
    customManual.cloud = { profileId: medium, pricingMode: 'manual' };
    const document = doc([manual, customManual], []);
    expect(normaliseServerPricing(document, catalog)).toBe(document);
    const restored = architectureDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(normaliseServerPricing(restored, catalog)).toBe(restored);
  });

  it('prices custom hardware as the smallest machine that fits it', () => {
    // Three slots and 6 GB do not fit a Medium (2 slots, 4 GB); they fit a
    // Large. One slot and 1 GB fit a Small. The provider stays where it was.
    const three = server('three', { profile: 'custom', cpuSlots: 3, ramMb: 6_000 });
    three.cloud = { profileId: medium };
    const one = server('one', { profile: 'custom', cpuSlots: 1, ramMb: 1_000 });
    one.cloud = { profileId: medium };
    const fixed = normaliseServerPricing(doc([three, one], []), catalog);
    expect(fixed.nodes[0]!.cloud.profileId).toBe(large);
    expect(fixed.nodes[1]!.cloud.profileId).toBe('aws.ec2.t3-medium.us-east-1');
    // Typing numbers into the box changes the box, never the software on it.
    expect(fixed.nodes[0]!.settings).toEqual(three.settings);
  });

  it('prices custom hardware bigger than the catalog as the largest machine there is', () => {
    // Sixteen CPU slots typed into what used to be a Medium. Nothing catalogued
    // has sixteen, so it is priced as the Extra large — the most it can
    // honestly be matched to — and the estimate marks that price as a floor.
    const custom = server('custom', { profile: 'custom', cpuSlots: 16, ramMb: 4_000 });
    custom.cloud = { profileId: medium };
    const fixed = normaliseServerPricing(doc([custom], []), catalog);
    expect(fixed.nodes[0]!.cloud.profileId).toBe('aws.ec2.m7i-2xlarge.us-east-1');

    // Bring it back within range and it settles on the machine that fits.
    const back = normaliseServerPricing(
      { ...fixed, nodes: fixed.nodes.map((n) => n.kind === 'server'
        ? { ...n, settings: { ...n.settings, cpuSlots: 2, ramMb: 4_096 } } : n) },
      catalog,
    );
    expect(back.nodes[0]!.cloud.profileId).toBe(medium);
  });

  it('leaves a size-agnostic profile alone whatever the custom numbers are', () => {
    const custom = server('custom', { profile: 'custom', cpuSlots: 64, ramMb: 500_000 });
    custom.cloud = { profileId: 'self-managed.unpriced' };
    const document = doc([custom], []);
    expect(normaliseServerPricing(document, catalog)).toBe(document);
  });

  it('leaves deliberately unassigned pricing and unavailable catalogs alone', () => {
    const node = server('s', { profile: 'large' });
    node.cloud = { profileId: null };
    const document = doc([node], []);
    expect(normaliseServerPricing(document, catalog)).toBe(document);
    node.cloud.profileId = medium;
    expect(normaliseServerPricing(document, null)).toBe(document);
  });
});
