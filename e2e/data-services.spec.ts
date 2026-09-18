import { expect, test } from '@playwright/test';
import { DATA_KINDS, DATA_SERVICES } from '../src/domain/data-services';

test('data workshop settings, automatic recalculation, history and persistence', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.evaluate(() => window.aparecium!.store.getState().stopSimulation());
  await page.getByText('Data workshop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().project!.document.nodes.length)).toBe(7);
  for (const kind of DATA_KINDS) {
    await page.evaluate((id) => window.aparecium!.store.getState().select({ type: 'node', id }), kind);
    for (const field of Object.values(DATA_SERVICES[kind].fields)) {
      await expect(page.getByLabel(field.label)).toBeAttached();
    }
  }
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'warehouse' }));
  await page.getByLabel('Data scanned rate per GB scanned', { exact: true }).fill('0.01');
  await page.getByLabel('Data scanned rate per GB scanned', { exact: true }).blur();
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'documentDb' }));
  await page.getByLabel('Reads using an index (0–1)', { exact: true }).fill('1');
  await page.getByLabel('Reads using an index (0–1)', { exact: true }).blur();
  if (await page.getByRole('button', { name: 'Run simulation' }).isVisible()) await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.dataServices?.length)).toBe(5);
  const oldId = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.id);
  await page.getByLabel('Indexed read time').fill('12');
  await page.getByLabel('Indexed read time').blur();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.id)).not.toBe(oldId);
  const setting = () => page.evaluate(() => {
    const node = window.aparecium!.store.getState().project?.document.nodes.find((n) => n.id === 'documentDb');
    return node?.kind === 'documentDb' ? node.settings.indexedReadMs : -1;
  });
  await page.evaluate(() => window.aparecium!.store.getState().undo());
  await expect.poll(setting).toBe(2);
  await page.evaluate(() => window.aparecium!.store.getState().redo());
  await expect.poll(setting).toBe(12);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().resultsStale)).toBe(false);
  await page.evaluate(async () => {
    const s = window.aparecium!.store.getState();
    await s.keepLatestRun();
    s.stopSimulation();
  });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  await expect.poll(setting).toBe(12);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.dataServices?.length)).toBe(5);
  const before = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.dataServices);
  await page.evaluate(async () => {
    const s = window.aparecium!.store.getState();
    await s.importFile(JSON.stringify({ kind: 'aparecium.project', formatVersion: 1, exportedAt: '', appVersion: '0.1.0', project: s.project, runs: s.runs }));
  });
  await expect.poll(setting).toBe(12);
  expect(await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.dataServices)).toEqual(before);
  await page.getByRole('button', { name: 'Expand results' }).click();
  await page.getByRole('tab', { name: 'Components', exact: true }).last().click();
  await expect(page.getByText('Specialized data stores', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Cost', exact: true }).click();
  // The warehouse starts on the Athena profile (entry 066), so the edited scan
  // rate lives under that profile and the line is priced, marked as edited.
  await expect(page.getByText('Data scanned').first()).toBeVisible();
  expect(await page.evaluate(() => window.aparecium!.store.getState().project!.document.pricingOverrides['aws.athena.s3.us-east-1']?.scan)).toBe('0.01');
  expect(errors).toEqual([]);
});

test('all five data stores can be added from the palette', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  for (const kind of DATA_KINDS) {
    await page.getByRole('tab', { name: 'Components', exact: true }).first().click();
    await page.getByRole('button', { name: DATA_SERVICES[kind].label, exact: true }).click();
    await expect.poll(() => page.evaluate((kind) => window.aparecium!.store.getState().project!.document.nodes.some((n) => n.kind === kind), kind)).toBe(true);
  }
});

test('time-series ingestion is billed for every point in a write', async ({ page }) => {
  // Codex regression. The engine sends itemBytes × pointsPerWrite for each
  // write; pricing counted itemBytes alone, so a hundred points per write
  // carried a hundred times the data for the same ingestion charge.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.evaluate(() => window.aparecium!.store.getState().stopSimulation());
  await page.getByText('Data workshop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().project!.document.nodes.length)).toBe(7);

  const read = () => page.evaluate(() => {
    const s = window.aparecium!.store.getState();
    const run = s.latestRun!;
    const node = run.inputDocument.nodes.find((n) => n.id === 'timeSeries')!;
    if (node.kind !== 'timeSeries') throw new Error('not a time-series store');
    const line = run.cost.lines.find((l) => l.nodeId === 'timeSeries' && l.chargeType === 'ingest')!;
    return {
      points: node.settings.pointsPerWrite, itemBytes: node.settings.itemBytes,
      writes: run.result.usage.writesByNodeId['timeSeries'] ?? 0,
      bytes: run.result.usage.ingestedBytesByNodeId?.['timeSeries'] ?? null,
      seconds: run.result.usage.measuredSeconds,
      quantity: line.quantity, monthly: line.monthly, unpriced: line.unpriced, basis: line.basis,
    };
  });
  const settled = async (points: number) => {
    if (await page.getByRole('button', { name: 'Run simulation' }).isVisible()) await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect.poll(() => page.evaluate((points) => {
      const s = window.aparecium!.store.getState();
      const node = s.latestRun?.inputDocument.nodes.find((n) => n.id === 'timeSeries');
      return !!s.latestRun && !s.resultsStale && !s.running && node?.kind === 'timeSeries' && node.settings.pointsPerWrite === points;
    }, points)).toBe(true);
    return read();
  };

  const hundred = await settled(100);
  expect(hundred.writes).toBeGreaterThan(0);
  expect(hundred.unpriced).toBe(false);
  // The ledger holds the bytes the link carried, and the line bills exactly those.
  expect(hundred.bytes).toBe(hundred.writes * 100 * hundred.itemBytes);
  expect(Number(hundred.quantity)).toBeCloseTo((hundred.bytes! / hundred.seconds) * 730 * 3600 / 1e9, 3);
  expect(hundred.basis).toContain(`${hundred.writes} writes of 100 points at ${hundred.itemBytes} bytes each`);
  await page.getByRole('button', { name: 'Expand results' }).click();
  await page.getByRole('tab', { name: 'Cost', exact: true }).click();
  await expect(page.getByText('Data ingested').first()).toBeVisible();

  // One point per write is one hundredth of the data, and one hundredth of the charge.
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'timeSeries' }));
  await page.getByLabel('Points in each write').fill('1');
  await page.getByLabel('Points in each write').blur();
  const one = await settled(1);
  expect(one.writes).toBe(hundred.writes);
  expect(one.bytes).toBe(hundred.bytes! / 100);
  expect(Number(one.quantity) * 100).toBeCloseTo(Number(hundred.quantity), 1);
  expect(Number(one.monthly) * 100).toBeCloseTo(Number(hundred.monthly), 0);
  expect(errors).toEqual([]);
});
