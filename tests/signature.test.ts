import { describe, expect, it } from 'vitest';
import { simulationSignature } from '../src/simulation/signature';
import { buildTemplate } from '../src/domain/defaults';
import { runSimulation } from '../src/simulation/engine';
import type { ClientNode, ServerNode } from '../src/domain/types';
import { deepClone } from '../src/storage/runs';

/**
 * The signature is what the editor uses to decide whether an edit is worth
 * re-running. Its contract is: same signature, same run.
 */
describe('simulation signature', () => {
  it('ignores where a component sits on the canvas', () => {
    const before = buildTemplate('starter');
    const after = deepClone(before);
    after.nodes[0]!.position = { x: 999, y: -400 };
    expect(simulationSignature(after)).toBe(simulationSignature(before));

    // And the claim it stands for: the results really are identical.
    expect(JSON.stringify(runSimulation(after))).toBe(JSON.stringify(runSimulation(before)));
  });

  it('ignores what a component is called', () => {
    const before = buildTemplate('starter');
    const after = deepClone(before);
    after.nodes[1]!.name = 'Renamed entirely';
    expect(simulationSignature(after)).toBe(simulationSignature(before));
  });

  it('notices a setting that changes the run', () => {
    const before = buildTemplate('starter');
    const after = deepClone(before);
    (after.nodes.find((n) => n.kind === 'server') as ServerNode).settings.cpuSlots = 8;
    expect(simulationSignature(after)).not.toBe(simulationSignature(before));
  });

  it('notices traffic, workload and connection changes', () => {
    const base = buildTemplate('starter');

    const traffic = deepClone(base);
    (traffic.nodes.find((n) => n.kind === 'client') as ClientNode).settings.activeUsers = 900;
    expect(simulationSignature(traffic)).not.toBe(simulationSignature(base));

    const workload = deepClone(base);
    workload.workload.seed = 999;
    expect(simulationSignature(workload)).not.toBe(simulationSignature(base));

    const link = deepClone(base);
    link.edges[0]!.settings.bandwidthMbps = 10;
    expect(simulationSignature(link)).not.toBe(simulationSignature(base));

    const removed = deepClone(base);
    removed.edges = [];
    expect(simulationSignature(removed)).not.toBe(simulationSignature(base));
  });

  it('notices a cloud profile or an edited rate, because both change the cost', () => {
    const base = buildTemplate('starter');

    const profile = deepClone(base);
    profile.nodes[1]!.cloud.profileId = 'aws.ec2.t3-medium.us-east-1';
    expect(simulationSignature(profile)).not.toBe(simulationSignature(base));

    const rate = deepClone(base);
    rate.pricingOverrides = { 'aws.ec2.m7i-large.us-east-1': { compute: '0.42' } };
    expect(simulationSignature(rate)).not.toBe(simulationSignature(base));
  });
});
