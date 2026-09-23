import { expect, test } from '@playwright/test';
import { JOB_KINDS, JOB_SERVICES } from '../src/domain/job-services';
import { SUPPORT_KINDS, SUPPORT_SERVICES } from '../src/domain/support-services';

test('background workshop settings, retries and saved result history', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.getByText('Background jobs workshop', { exact: true }).click();
  // The kinds this workshop holds; the workflow engine lives in the Backend workshop.
  for (const kind of JOB_KINDS.filter((k) => k !== 'workflow')) {
    await page.evaluate(id => window.aparecium!.store.getState().select({ type: 'node', id }), kind);
    for (const field of Object.values(JOB_SERVICES[kind].fields)) await expect(page.getByLabel(field.label)).toBeAttached();
  }
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'queue' }));
  await page.getByLabel('Worker failure share (0–1)').fill('1'); await page.getByLabel('Worker failure share (0–1)').blur();
  if (await page.getByRole('button', { name: 'Run simulation' }).isVisible()) await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.jobServices?.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.queues.find(q => q.nodeId === 'queue')?.retries)).toBeGreaterThan(0);
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.keepLatestRun(); s.stopSimulation(); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.jobServices?.length)).toBe(3);
  await page.getByRole('button', { name: 'Expand results' }).click(); await page.getByRole('tab', { name: 'Components', exact: true }).last().click();
  await expect(page.getByText('Background jobs', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('shared workshop exposes every setting and preserves edits through recalculation, undo, reopen and import', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.getByText('Shared services workshop', { exact: true }).click();
  // The kinds this workshop holds; the lock lives in the Backend workshop.
  for (const kind of SUPPORT_KINDS.filter((k) => k !== 'lock')) {
    await page.evaluate(id => window.aparecium!.store.getState().select({ type: 'node', id }), kind);
    for (const field of Object.values(SUPPORT_SERVICES[kind].fields)) await expect(page.getByLabel(field.label)).toBeAttached();
  }
  if (await page.getByRole('button', { name: 'Run simulation' }).isVisible()) await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.supportServices?.length)).toBe(8);
  const oldId = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.id);
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'rateLimiter' }));
  await page.getByLabel('Tokens added per second').fill('5'); await page.getByLabel('Tokens added per second').blur();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.id)).not.toBe(oldId);
  const rate = () => page.evaluate(() => { const n = window.aparecium!.store.getState().project?.document.nodes.find(n => n.id === 'rateLimiter'); return n?.kind === 'rateLimiter' ? n.settings.ratePerSecond : -1; });
  await page.evaluate(() => window.aparecium!.store.getState().undo()); await expect.poll(rate).toBe(1000);
  await page.evaluate(() => window.aparecium!.store.getState().redo()); await expect.poll(rate).toBe(5);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().resultsStale)).toBe(false);
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.keepLatestRun(); s.stopSimulation(); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload(); await expect.poll(rate).toBe(5);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.supportServices?.length)).toBe(8);
  const before = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.supportServices);
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.importFile(JSON.stringify({ kind: 'aparecium.project', formatVersion: 1, exportedAt: '', appVersion: '0.1.0', project: s.project, runs: s.runs })); });
  await expect.poll(rate).toBe(5); expect(await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.supportServices)).toEqual(before);
  await page.getByRole('button', { name: 'Expand results' }).click(); await page.getByRole('tab', { name: 'Components', exact: true }).last().click();
  await expect(page.getByText('Shared services and real-time traffic', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('all new messaging and shared services can be placed from the palette', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  for (const kind of [...JOB_KINDS, ...SUPPORT_KINDS]) {
    await page.getByRole('tab', { name: 'Components', exact: true }).first().click();
    const label = kind in JOB_SERVICES ? JOB_SERVICES[kind as keyof typeof JOB_SERVICES].label : SUPPORT_SERVICES[kind as keyof typeof SUPPORT_SERVICES].label;
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => page.evaluate(kind => window.aparecium!.store.getState().project!.document.nodes.some(n => n.kind === kind), kind)).toBe(true);
  }
});

test('retention housekeeping does not stretch a timed run or shrink its throughput', async ({ page }) => {
  // Codex regression. Ten requests a second for one second into an event
  // stream with no consumer, with a ten-second drain. Every record expires on
  // the simulated clock; a five-second retention used to stretch the measured
  // interval from 1 s to about 5.9 s and cut the reported throughput to match.
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.evaluate(async () => {
    const s = window.aparecium!.store.getState();
    s.stopSimulation();
    await s.createProject('empty', 'Retention check');
    const state = () => window.aparecium!.store.getState();
    const nodes = () => state().project!.document.nodes;
    state().addComponent('client'); const users = nodes()[nodes().length - 1]!;
    state().addComponent('server'); const server = nodes()[nodes().length - 1]!;
    state().addComponent('eventStream'); const stream = nodes()[nodes().length - 1]!;
    state().connect(users.id, server.id); state().connect(server.id, stream.id);
    state().mutate(draft => {
      const u = draft.nodes.find(n => n.id === users.id); if (u?.kind === 'client') u.settings.requestRateOverridePerSecond = 10;
      const log = draft.nodes.find(n => n.id === stream.id); if (log?.kind === 'eventStream') log.settings.retentionSeconds = 0.01;
    });
    state().setWorkload({ durationSeconds: 1, drainSeconds: 10 });
  });
  const measure = async (retention: number) => {
    await page.evaluate(retention => window.aparecium!.store.getState().mutate(draft => {
      const log = draft.nodes.find(n => n.kind === 'eventStream'); if (log?.kind === 'eventStream') log.settings.retentionSeconds = retention;
    }), retention);
    if (await page.getByRole('button', { name: 'Run simulation' }).isVisible()) await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect.poll(() => page.evaluate(retention => {
      const s = window.aparecium!.store.getState();
      const log = s.latestRun?.inputDocument.nodes.find(n => n.kind === 'eventStream');
      return !!s.latestRun && !s.resultsStale && !s.running && log?.kind === 'eventStream' && log.settings.retentionSeconds === retention;
    }, retention)).toBe(true);
    return page.evaluate(() => {
      const r = window.aparecium!.store.getState().latestRun!.result;
      return { status: r.status, simulatedMs: r.simulatedMs, seconds: r.usage.measuredSeconds, throughput: r.throughputPerSecond, completed: r.completed, stream: r.jobServices![0]!.details };
    });
  };
  const short = await measure(0.01);
  const long = await measure(5);
  expect(short).toMatchObject({ status: 'completed', completed: 10, simulatedMs: 1000, seconds: 1, throughput: 10 });
  expect(long).toMatchObject({ status: 'completed', completed: 10, simulatedMs: 1000, seconds: 1, throughput: 10 });
  // The records still expired: the housekeeping ran, it just was not measured as workload.
  expect(long.stream).toMatchObject({ expired: 10, retained: 0 });
  expect(errors).toEqual([]);
});
