import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import {
  cloudCatalogSchema,
  findProfile,
  serverProfileForHardware,
  serverProfileForSize,
} from '../src/catalogs/types';
import { SERVER_HARDWARE_PROFILES } from '../src/domain/defaults';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation } from '../src/simulation/engine';
import type { ArchNode, ServerSettings } from '../src/domain/types';
import { client, doc, edge, server, INSTANT } from './helpers';

/**
 * Performance and cost describing the same machine.
 *
 * A Resource profile used to set capacity and leave the cloud profile alone, so
 * upgrading a server to Large kept the price of a Medium: the estimate was for
 * a machine that was no longer selected. These tests hold the two together, and
 * hold the line on the three things that must not happen while doing it —
 * crossing a provider, keeping a stale price, or rewriting application
 * settings that belong to the software rather than the box.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);
const hardware = (id: 'small' | 'medium' | 'large' | 'xlarge') =>
  SERVER_HARDWARE_PROFILES.find((p) => p.id === id)!;

describe('matching a cloud profile to a hardware size', () => {
  it('finds the machine of that size in the same provider and region', () => {
    const match = serverProfileForSize(catalog, 'aws.ec2.m7i-large.us-east-1', 'large');
    expect(match.outcome).toBe('matched');
    if (match.outcome !== 'matched') return;
    expect(match.profile.id).toBe('aws.ec2.m7i-xlarge.us-east-1');
    expect(match.profile.provider).toBe('aws');
    expect(match.profile.region).toBe('us-east-1');
  });

  it('stays with the provider it was given, rather than shopping around', () => {
    // Google has a large machine; it is not an answer for an AWS component.
    const match = serverProfileForSize(catalog, 'gcp.gce.e2-standard-2.us-central1', 'large');
    expect(match.outcome).toBe('matched');
    if (match.outcome !== 'matched') return;
    expect(match.profile.provider).toBe('gcp');
    expect(match.profile.region).toBe('us-central1');
    expect(match.profile.id).toBe('gcp.gce.n2-standard-4.us-central1');
  });

  it('reports no match rather than crossing to another provider', () => {
    // Google has nothing small in this catalog, and AWS does. Offering the AWS
    // one would move somebody between providers on the strength of a size.
    expect(serverProfileForSize(catalog, 'gcp.gce.e2-standard-2.us-central1', 'small').outcome).toBe(
      'none',
    );
    expect(
      catalog.profiles.some((p) => p.sizeClass === 'small' && p.provider === 'aws'),
    ).toBe(true);
  });

  it('leaves a size-agnostic profile alone', () => {
    // Self-managed hardware is one catalog entry whatever size you call it, so
    // a change of size says nothing about it.
    const match = serverProfileForSize(catalog, 'self-managed.unpriced', 'large');
    expect(match.outcome).toBe('keep');
  });

  it('has nothing to match when no profile is assigned', () => {
    expect(serverProfileForSize(catalog, null, 'large').outcome).toBe('none');
  });

  it('keeps every suggested profile in step with the size it is suggested for', () => {
    // The hardware catalog names a starting profile per size. If that profile
    // declared a different size the two halves of the catalog would disagree.
    for (const profile of SERVER_HARDWARE_PROFILES) {
      const suggested = findProfile(catalog, profile.suggestedCloudProfileId);
      expect(suggested, profile.id).not.toBeNull();
      expect(suggested!.sizeClass, profile.id).toBe(profile.id);
    }
  });
});

describe('fitting custom hardware to a catalogued machine', () => {
  const sizes = SERVER_HARDWARE_PROFILES;
  const from = 'aws.ec2.m7i-large.us-east-1';

  it('takes the smallest machine that has room on both counts', () => {
    // 3 slots rule out Small and Medium; 6 GB rules out nothing bigger.
    const fit = serverProfileForHardware(catalog, sizes, from, 3, 6_000);
    expect(fit.outcome).toBe('matched');
    if (fit.outcome !== 'matched') return;
    expect(fit.profile.id).toBe('aws.ec2.m7i-xlarge.us-east-1');
    expect(fit.fitted?.id).toBe('large');
  });

  it('does not let a memory shortfall hide behind a CPU fit', () => {
    // 2 slots fit a Medium; 5 GB does not. The answer is the Large.
    const fit = serverProfileForHardware(catalog, sizes, from, 2, 5_000);
    expect(fit.outcome === 'matched' && fit.fitted?.id).toBe('large');
  });

  it('fits eight slots into the Extra large now that one is catalogued', () => {
    // This was the reported case: eight slots typed into a Large. With an
    // 8-slot machine in the catalog it is a real fit with a real price, not a
    // floor.
    const fit = serverProfileForHardware(catalog, sizes, from, 8, 1_604);
    expect(fit.outcome).toBe('matched');
    if (fit.outcome !== 'matched') return;
    expect(fit.profile.id).toBe('aws.ec2.m7i-2xlarge.us-east-1');
    expect(fit.fitted?.id).toBe('xlarge');
    expect(fit.floor).toBeFalsy();
  });

  it('prices hardware bigger than anything catalogued as the largest machine, marked as a floor', () => {
    // Unpriced would drop the line from the total and make the bigger machine
    // look cheaper. The largest machine is a true lower bound, so that is the
    // price — with the floor flagged so nobody reads it as the real figure.
    const fit = serverProfileForHardware(catalog, sizes, from, 16, 4_000);
    expect(fit.outcome).toBe('matched');
    if (fit.outcome !== 'matched') return;
    expect(fit.profile.id).toBe('aws.ec2.m7i-2xlarge.us-east-1');
    expect(fit.fitted?.id).toBe('xlarge');
    expect(fit.floor).toBe(true);
  });

  it('does not call a machine that fits a floor', () => {
    const fit = serverProfileForHardware(catalog, sizes, from, 3, 6_000);
    expect(fit.outcome === 'matched' && fit.floor).toBeFalsy();
  });

  it('stays in its provider even when another one would fit', () => {
    // One slot: AWS has a Small, Google does not. A Google box stays Google.
    const fit = serverProfileForHardware(catalog, sizes, 'gcp.gce.e2-standard-2.us-central1', 1, 1_000);
    expect(fit.outcome).toBe('matched');
    if (fit.outcome !== 'matched') return;
    expect(fit.profile.provider).toBe('gcp');
    expect(fit.fitted?.id).toBe('medium');
  });
});

describe('what an upgrade does to the bill', () => {
  /** One server, sized and priced, with a run behind it so usage is real. */
  function estimateFor(settings: Partial<ServerSettings>, profileId: string | null) {
    const node = server('s1', settings) as ArchNode;
    node.cloud = { profileId };
    const document = doc(
      [client('c1', { requestRateOverridePerSecond: 10 }), node],
      [edge('c1', 's1', INSTANT)],
      { durationSeconds: 10, drainSeconds: 5 },
    );
    const result = runSimulation(document);
    return estimateCost({ document, catalog, usage: result.usage });
  }

  const computeOf = (estimate: ReturnType<typeof estimateCost>) =>
    estimate.lines.find((l) => l.chargeType === 'compute') ?? null;

  it('charges the mapped rate for the machine that is selected', () => {
    // The fixed compute charge is the thing a hardware change must move. The
    // total is not: usage charges move with the simulation too, which is how
    // an upgrade used to make the total fall.
    const medium = hardware('medium');
    const large = hardware('large');

    const before = estimateFor(
      { profile: 'medium', cpuSlots: medium.cpuSlots, ramMb: medium.ramMb },
      'aws.ec2.m7i-large.us-east-1',
    );
    const after = estimateFor(
      { profile: 'large', cpuSlots: large.cpuSlots, ramMb: large.ramMb },
      // what applyProfile resolves to for this provider and region
      'aws.ec2.m7i-xlarge.us-east-1',
    );

    // The published rates: m7i.large 0.1008 and m7i.xlarge 0.2016 an hour,
    // across 730 hours, rounded half-up at the line.
    expect(computeOf(before)?.monthly).toBe('73.58');
    expect(computeOf(after)?.monthly).toBe('147.17');
    expect(computeOf(after)?.unpriced).toBe(false);
    expect(computeOf(after)?.verified).toBe(true);
  });

  it('never lets a bigger custom machine cost less than the largest catalogued one', () => {
    // Sixteen slots, priced as the eight-slot Extra large: the compute line is
    // the m7i.2xlarge's 0.4032 x 730 = 294.34, it counts towards the total, and
    // the estimate says on the line and in its warnings that this is a floor.
    const estimate = estimateFor(
      { profile: 'custom', cpuSlots: 16, ramMb: 4_000 },
      'aws.ec2.m7i-2xlarge.us-east-1',
    );
    const compute = computeOf(estimate);
    expect(compute?.monthly).toBe('294.34');
    expect(compute?.unpriced).toBe(false);
    expect(compute?.basis).toContain('floor');
    expect(estimate.warnings.join(' ')).toContain('is a floor');

    // The same machine within range is not a floor and does not warn.
    const within = estimateFor(
      { profile: 'custom', cpuSlots: 8, ramMb: 16_384 },
      'aws.ec2.m7i-2xlarge.us-east-1',
    );
    expect(computeOf(within)?.basis).not.toContain('floor');
    expect(within.warnings.join(' ')).not.toContain('is a floor');
  });

  it('reports an unassigned machine as unpriced, never as free', () => {
    const large = hardware('large');
    const estimate = estimateFor(
      { profile: 'large', cpuSlots: large.cpuSlots, ramMb: large.ramMb },
      null,
    );
    const compute = computeOf(estimate);
    expect(compute?.unpriced).toBe(true);
    expect(compute?.monthly).toBeNull();
    expect(estimate.unpricedLineCount).toBeGreaterThan(0);
    expect(estimate.warnings.join(' ')).toContain('Unpriced does not mean free');
  });

  it('warns about illustrative rates only when one is actually in use', () => {
    const large = hardware('large');
    // A verified AWS machine: no illustrative warning.
    const verified = estimateFor(
      { profile: 'large', cpuSlots: large.cpuSlots, ramMb: large.ramMb },
      'aws.ec2.m7i-xlarge.us-east-1',
    );
    expect(computeOf(verified)?.verified).toBe(true);
    expect(verified.hasIllustrativeRates).toBe(false);
    expect(verified.warnings.join(' ')).not.toContain('illustrative placeholder rates');

    // A Google Cloud placeholder: the warning comes back.
    const placeholder = estimateFor(
      { profile: 'large', cpuSlots: large.cpuSlots, ramMb: large.ramMb },
      'gcp.gce.n2-standard-4.us-central1',
    );
    expect(computeOf(placeholder)?.verified).toBe(false);
    expect(placeholder.hasIllustrativeRates).toBe(true);
    expect(placeholder.warnings.join(' ')).toContain('illustrative placeholder rates');
  });
});

describe('a bigger machine is also a faster one', () => {
  it('changes what the simulation can do, not only what it costs', () => {
    // The point of holding the two together is that they describe one choice.
    // This is the performance half: same software, more CPU slots, more served.
    const build = (cpuSlots: number) =>
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 400 }),
          server('s1', {
            profile: cpuSlots === 2 ? 'medium' : 'large',
            cpuSlots,
            cpuMsPerRequest: 20,
            concurrencyLimit: 10_000,
            ramMb: 1_000_000,
            queueLimit: 1_000_000,
          }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 20, drainSeconds: 20, seed: 4 },
      );

    const medium = runSimulation(build(2));
    const large = runSimulation(build(4));
    // Two slots at 20 ms is 100 a second; four slots is 200.
    expect(large.completed).toBeGreaterThan(medium.completed);
    expect(large.responseTime.meanMs).toBeLessThan(medium.responseTime.meanMs);
  });
});
