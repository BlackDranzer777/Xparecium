import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
});

test('Live keeps counting beyond the duration; Stop freezes it and restart works', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  expect(await page.getByLabel('Simulation mode').inputValue()).toBe('live');
  await page.evaluate(() => {
    const s = window.aparecium!.store.getState();
    s.stopSimulation();
    s.setWorkload({ durationSeconds: 0.5, drainSeconds: 0 });
  });
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByRole('button', { name: 'Stop simulation' })).toBeVisible();
  const state = () => page.evaluate(() => {
    const s = window.aparecium!.store.getState();
    return { id: s.currentRunId, completed: s.latestRun?.result.completed ?? 0,
      ms: s.latestRun?.result.simulatedMs ?? 0, status: s.latestRun?.result.status, history: s.runs.length };
  });
  await expect.poll(async () => (await state()).ms).toBeGreaterThan(1000);
  const a = await state();
  await expect.poll(async () => (await state()).completed).toBeGreaterThan(a.completed);
  expect((await state()).id).toBe(a.id);
  expect((await state()).status).toBe('running');
  expect((await state()).history).toBe(0);
  // A layout edit must leave the very same run alive.
  await page.evaluate(() => window.aparecium!.store.getState().mutate(d => { d.nodes[0]!.position.x += 30; }));
  await expect.poll(async () => (await state()).ms).toBeGreaterThan(a.ms + 500);
  expect((await state()).id).toBe(a.id);
  await page.getByRole('button', { name: 'Stop simulation' }).click();
  await expect.poll(async () => (await state()).status).toBe('cancelled');
  const stopped = await state();
  await page.waitForTimeout(800);
  expect(await state()).toEqual(stopped);
  expect(await page.locator('.ap-packet').first().evaluate(el => (el as SVGElement).style.opacity)).toBe('0');
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(async () => (await state()).status).toBe('running');
  expect((await state()).id).not.toBe(a.id);
  expect(errors).toEqual([]);
});

test('Keep, export, import and reopen preserve live snapshots without resuming them', async ({ page }) => {
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  const kept = await page.evaluate(() => JSON.stringify(window.aparecium!.store.getState().runs[0]));
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.simulatedMs)).toBeGreaterThan(1200);
  expect(await page.evaluate(() => JSON.stringify(window.aparecium!.store.getState().runs[0]))).toBe(kept);
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => window.aparecium!.store.getState().exportCurrent());
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const json = Buffer.concat(chunks).toString('utf8');
  const exported = JSON.parse(json);
  expect(exported.runs).toHaveLength(2);
  expect(exported.runs[0].result.status).toBe('running');
  await page.evaluate(text => window.aparecium!.store.getState().importFile(text), json);
  await expect(page.getByText('Snapshot', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.aparecium!.store.getState().running)).toBe(false);
  await page.reload();
  await expect(page.getByText('Snapshot', { exact: true })).toBeVisible();
  expect(await page.locator('.ap-packet').first().evaluate(el => (el as SVGElement).style.opacity)).toBe('0');
});

test('the reported 470/s scenario has 9400 arrivals and visible small utilisation', async ({ page }, testInfo) => {
  await page.getByLabel('Simulation mode').selectOption('timed');
  await page.evaluate(async () => {
    const s = window.aparecium!.store.getState();
    await s.createProject('serverless-api');
    window.aparecium!.store.getState().mutate(d => {
      const c = d.nodes.find(n => n.kind === 'client')!;
      if (c.kind === 'client') c.settings.activeUsers = 1410;
    });
    await window.aparecium!.store.getState().run();
  });
  const r = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result);
  expect(r.offered).toBe(9400);
  expect(r.completed).toBe(9400);
  expect(r.messagesProcessed).toBe(18800);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Orders table' }).getByText('<1%', { exact: true })).toBeVisible();
  await expect(page.getByText('per month (estimate)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop simulation' })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('fixed-serverless-scenario.png') });
});
