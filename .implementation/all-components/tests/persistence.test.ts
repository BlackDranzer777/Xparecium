import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { buildTemplate, upgradeDocument } from '../src/domain/defaults';
import { DOCUMENT_SCHEMA_VERSION } from '../src/domain/types';
import type { ArchitectureDocument, Project, ServerNode } from '../src/domain/types';
import { exportToJson, importFromJson, MAX_IMPORT_BYTES } from '../src/storage/exchange';
import { createRunRecord, diffRunInputs } from '../src/storage/runs';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation } from '../src/simulation/engine';

const catalog = cloudCatalogSchema.parse(rawCatalog);

function sampleProject(): Project {
  return {
    id: 'proj_test',
    name: 'Checkout service',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    document: buildTemplate('cache-aside'),
  };
}

function runFor(project: Project, label: string) {
  const result = runSimulation({
    ...project.document,
    workload: { ...project.document.workload, durationSeconds: 2, drainSeconds: 2 },
  });
  const cost = estimateCost({ document: project.document, catalog, usage: result.usage });
  return createRunRecord({
    projectId: project.id,
    label,
    document: project.document,
    catalog,
    result,
    cost,
  });
}

describe('acceptance 13 — saving, reloading and JSON round-tripping preserve a project', () => {
  it('round-trips a project and its runs without losing anything', () => {
    const project = sampleProject();
    const run = runFor(project, 'Baseline');
    const json = exportToJson(project, [run]);

    const imported = importFromJson(json);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.project).toEqual(project);
    expect(imported.value.runs).toHaveLength(1);
    expect(imported.value.runs[0]!.id).toBe(run.id);
    expect(imported.value.runs[0]!.result.completed).toBe(run.result.completed);
    expect(imported.value.runs[0]!.cost.totalMonthly).toBe(run.cost.totalMonthly);
    expect(imported.value.notes).toEqual([]);
  });

  it('a run with a load balancer survives export and import intact', () => {
    // The import schema lists every value it accepts, so anything the engine
    // gained after the schema was written is dropped or, worse, fails the whole
    // record. A load-balanced run exercises the parts most recently added:
    // per-client figures, the balancer as a station, and its own wait stage.
    const project: Project = { ...sampleProject(), document: buildTemplate('load-balanced') };
    const run = runFor(project, 'Load balanced');
    expect(run.result.clients.length).toBeGreaterThan(0);
    expect(run.result.stations.some((s) => s.kind === 'loadBalancer')).toBe(true);

    const imported = importFromJson(exportToJson(project, [run]));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.notes).toEqual([]);
    expect(imported.value.runs).toHaveLength(1);
    const back = imported.value.runs[0]!.result;
    expect(back.clients).toHaveLength(run.result.clients.length);
    expect(back.clients[0]!.offered).toBe(run.result.clients[0]!.offered);
    expect(back.clients[0]!.mode).toBe('open');
    expect(back.stations.filter((s) => s.kind === 'loadBalancer')).toHaveLength(1);
    expect(back.waitByStageMs.balancer).toBe(run.result.waitByStageMs.balancer);
    expect(back.arrivalPattern).toBe('constant');
  });

  it('a run with a message queue survives export and import intact', () => {
    const project: Project = { ...sampleProject(), document: buildTemplate('async-write') };
    const run = runFor(project, 'Async writes');
    expect(run.result.queues.length).toBe(1);
    expect(run.result.messagesPublished).toBeGreaterThan(0);

    const imported = importFromJson(exportToJson(project, [run]));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.notes).toEqual([]);
    const back = imported.value.runs[0]!.result;
    expect(back.queues).toHaveLength(1);
    expect(back.queues[0]!.enqueued).toBe(run.result.queues[0]!.enqueued);
    expect(back.queues[0]!.outstanding).toBe(run.result.queues[0]!.outstanding);
    expect(back.queues[0]!.consumerName).toBe(run.result.queues[0]!.consumerName);
    expect(back.messagesPublished).toBe(run.result.messagesPublished);
  });

  it('exports enough to understand the run on another device', () => {
    const project = sampleProject();
    const run = runFor(project, 'Baseline');
    const parsed = JSON.parse(exportToJson(project, [run]));
    const exportedRun = parsed.runs[0];
    expect(exportedRun.inputDocument).toBeTruthy();
    expect(exportedRun.seed).toBe(project.document.workload.seed);
    expect(exportedRun.engineVersion).toBeTruthy();
    // The catalog rows the run actually used travel with it.
    expect(exportedRun.catalogSnapshot.profiles.length).toBeGreaterThan(0);
    expect(parsed.kind).toBe('aparecium.project');
  });

  it('rejects a newer export format with an explanation instead of guessing', () => {
    const project = sampleProject();
    const parsed = JSON.parse(exportToJson(project, []));
    parsed.formatVersion = 99;
    const result = importFromJson(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('export format version 99');
    expect(result.message).toContain('Update Aparecium');
  });

  it('rejects a newer document schema version', () => {
    const project = sampleProject();
    const parsed = JSON.parse(exportToJson(project, []));
    parsed.project.document.schemaVersion = DOCUMENT_SCHEMA_VERSION + 5;
    const result = importFromJson(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('document schema version');
  });

  it('rejects invalid JSON and files that are too large', () => {
    const bad = importFromJson('{ not json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('not valid JSON');

    const huge = importFromJson('x'.repeat(MAX_IMPORT_BYTES + 1));
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.message).toContain('import limit');
  });

  it('rejects a file that is valid JSON but not an Aparecium export', () => {
    const result = importFromJson(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('not a valid Aparecium project export');
      expect(result.details?.length).toBeGreaterThan(0);
    }
  });

  it('skips an unreadable saved run rather than failing the whole import', () => {
    const project = sampleProject();
    const parsed = JSON.parse(exportToJson(project, [runFor(project, 'Baseline')]));
    parsed.runs.push({ id: 'broken' });
    const result = importFromJson(JSON.stringify(parsed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runs).toHaveLength(1);
    expect(result.value.notes[0]).toContain('missing required fields');
  });

  it('accepts a document saved before rate editing existed', () => {
    const project = sampleProject();
    const parsed = JSON.parse(exportToJson(project, []));
    delete parsed.project.document.pricingOverrides;
    const result = importFromJson(JSON.stringify(parsed));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.project.document.pricingOverrides).toEqual({});
  });
});

describe('a document saved by an older build', () => {
  it('opens at the current schema version with sensible defaults filled in', () => {
    // Exactly what version 1 looked like: no arrival shape, and clients with
    // no mode or think time.
    const old = buildTemplate('starter');
    const v1 = {
      ...old,
      schemaVersion: 1,
      workload: { durationSeconds: 20, drainSeconds: 10, seed: 12_345 },
      nodes: old.nodes.map((node) =>
        node.kind === 'client'
          ? {
              ...node,
              settings: {
                activeUsers: 200,
                actionsPerUserPerMinute: 20,
                requestRateOverridePerSecond: null,
                requestBytes: 1_200,
                responseBytes: 24_000,
              },
            }
          : node,
      ),
    } as unknown as ArchitectureDocument;

    const upgraded = upgradeDocument(v1);
    expect(upgraded.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(upgraded.workload.arrivalPattern).toBe('constant');
    expect(upgraded.workload.arrivalOptions.burstMultiplier).toBe(5);
    const users = upgraded.nodes.find((n) => n.kind === 'client');
    expect(users?.kind === 'client' && users.settings.mode).toBe('open');
    expect(users?.kind === 'client' && users.settings.thinkTimeMs).toBeGreaterThan(0);

    // And it still simulates to the same numbers it always did.
    const before = runSimulation(buildTemplate('starter'));
    const after = runSimulation(upgraded);
    expect(after.offered).toBe(before.offered);
    expect(after.responseTime.meanMs).toBeCloseTo(before.responseTime.meanMs, 9);
  });

  it('leaves a current document exactly as it is', () => {
    const current = buildTemplate('starter');
    expect(upgradeDocument(current)).toBe(current);
  });
});

describe('acceptance 14 — a previous run is unchanged by later editing', () => {
  it('preserves the open-ended upper bound of a histogram overflow on export/import', () => {
    const project = sampleProject();
    const run = runFor(project, 'Overflow');
    run.result.responseTime.p95.upperBound = Infinity;
    const result = importFromJson(exportToJson(project, [run]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.runs[0]?.result.responseTime.p95.upperBound).toBe(Infinity);
  });
  it('skips a run with incomplete result data or a future run schema', () => {
    const project = sampleProject();
    const valid = runFor(project, 'Baseline');
    for (const broken of [{ ...valid, result: {} }, { ...valid, cost: undefined },
      { ...valid, schemaVersion: 99 }, { ...valid, inputDocument: { ...valid.inputDocument, schemaVersion: 99 } }]) {
      const imported = importFromJson(exportToJson(project, [broken as typeof valid]));
      expect(imported.ok).toBe(true);
      if (imported.ok) {
        expect(imported.value.runs).toHaveLength(0);
        expect(imported.value.notes.length).toBeGreaterThan(0);
      }
    }
  });

  it('reports edited billing rates in run comparisons', () => {
    const project = sampleProject();
    const before = runFor(project, 'Before');
    project.document.pricingOverrides['aws-app-medium'] = { compute: '0.5' };
    const after = runFor(project, 'After');
    expect(diffRunInputs(before, after).some((d) => d.label.includes('compute') && d.after === '0.5')).toBe(true);
  });
  it('keeps its own deep copy of the document', () => {
    const project = sampleProject();
    const run = runFor(project, 'Baseline');
    const originalCpu = (run.inputDocument.nodes.find((n) => n.kind === 'server') as ServerNode)
      .settings.cpuMsPerRequest;

    // Edit the live project as a user would.
    const liveServer = project.document.nodes.find((n) => n.kind === 'server') as ServerNode;
    liveServer.settings.cpuMsPerRequest = 999;
    liveServer.name = 'Renamed';
    project.document.workload.seed = 777;
    project.document.nodes.push(project.document.nodes[0]!);

    const savedServer = run.inputDocument.nodes.find((n) => n.kind === 'server') as ServerNode;
    expect(savedServer.settings.cpuMsPerRequest).toBe(originalCpu);
    expect(savedServer.name).not.toBe('Renamed');
    expect(run.inputDocument.workload.seed).not.toBe(777);
    expect(run.inputDocument.nodes).toHaveLength(4);
  });

  it('reports which inputs changed between two runs, and which weaken the comparison', () => {
    const project = sampleProject();
    const before = runFor(project, 'Baseline');

    const server = project.document.nodes.find((n) => n.kind === 'server') as ServerNode;
    server.settings.cpuSlots = 8;
    project.document.workload.seed = 999;
    const after = runFor(project, 'More CPU');

    const diffs = diffRunInputs(before, after);
    const cpu = diffs.find((d) => d.label.endsWith('cpuSlots'))!;
    expect(cpu.before).toBe('2');
    expect(cpu.after).toBe('8');
    expect(cpu.weakensComparison).toBe(false);

    const seed = diffs.find((d) => d.label === 'Workload: seed')!;
    expect(seed.weakensComparison).toBe(true);
  });

  it('reports no differences between a run and itself', () => {
    const project = sampleProject();
    const run = runFor(project, 'Baseline');
    expect(diffRunInputs(run, run)).toEqual([]);
  });
});
