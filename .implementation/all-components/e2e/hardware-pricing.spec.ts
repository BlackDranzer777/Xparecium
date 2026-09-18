import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * Changing the machine changes its price.
 *
 * The unit tests prove the mapping and the arithmetic. What has to be proved
 * here is that the control does it: picking a Resource profile moves the cloud
 * profile with it, survives undo, a reload and a round trip through the export
 * file, and does the same thing for a server draining a queue as for one
 * serving users.
 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function openFresh(page: Page) {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('aparecium');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
}

/** The one server's hardware, its rates, and the software settings on it. */
async function serverState(page: Page) {
  return page.evaluate(() => {
    const store = window.aparecium!.store.getState();
    const node = store.project!.document.nodes.find((n) => n.kind === 'server')!;
    if (node.kind !== 'server') throw new Error('not a server');
    const line =
      store.latestRun?.cost.lines.find(
        (l) => l.nodeId === node.id && l.chargeType === 'compute',
      ) ?? null;
    return {
      profile: node.settings.profile,
      cpuSlots: node.settings.cpuSlots,
      ramMb: node.settings.ramMb,
      cpuMsPerRequest: node.settings.cpuMsPerRequest,
      concurrencyLimit: node.settings.concurrencyLimit,
      memoryPerRequestMb: node.settings.memoryPerRequestMb,
      cloudProfileId: node.cloud.profileId,
      computeMonthly: line?.monthly ?? null,
      computeUnpriced: line?.unpriced ?? null,
    };
  });
}

test('upgrading the hardware moves the price with it', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  await expect(page.getByLabel('Resource profile')).toBeVisible();

  const before = await serverState(page);
  expect(before.profile).toBe('medium');
  expect(before.cloudProfileId).toBe('aws.ec2.m7i-large.us-east-1');
  expect(before.computeMonthly).toBe('73.58');

  // ---- The upgrade ---------------------------------------------------------
  await page.getByLabel('Resource profile').selectOption('large');
  await expect
    .poll(async () => (await serverState(page)).cloudProfileId)
    .toBe('aws.ec2.m7i-xlarge.us-east-1');

  const after = await serverState(page);
  expect(after.profile).toBe('large');
  expect(after.cpuSlots).toBe(4);
  expect(after.ramMb).toBe(8192);
  // 0.20 an hour across 730 hours, against 0.10 before.
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('147.17');

  // ---- The software on the box is untouched --------------------------------
  expect(after.cpuMsPerRequest).toBe(before.cpuMsPerRequest);
  expect(after.concurrencyLimit).toBe(before.concurrencyLimit);
  expect(after.memoryPerRequestMb).toBe(before.memoryPerRequestMb);

  // ---- One undo puts both halves back --------------------------------------
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await serverState(page);
  expect(undone.profile).toBe('medium');
  expect(undone.cpuSlots).toBe(2);
  expect(undone.cloudProfileId).toBe('aws.ec2.m7i-large.us-east-1');

  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await serverState(page)).cloudProfileId).toBe(
    'aws.ec2.m7i-xlarge.us-east-1',
  );

  // ---- It is still there after a reload ------------------------------------
  await expect
    .poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus))
    .toBe('saved');
  await page.reload();
  await expect(page.getByRole('button', { name: /simulation|Stop updates/ })).toBeVisible();
  const reopened = await serverState(page);
  expect(reopened.profile).toBe('large');
  expect(reopened.cpuSlots).toBe(4);
  expect(reopened.cloudProfileId).toBe('aws.ec2.m7i-xlarge.us-east-1');

  // ---- And after a round trip through the export file ----------------------
  await page.evaluate(async () => {
    const store = window.aparecium!.store.getState();
    await store.importFile(
      JSON.stringify({
        kind: 'aparecium.project',
        formatVersion: 1,
        exportedAt: '',
        appVersion: '0.1.0',
        project: store.project,
        runs: store.runs,
      }),
    );
  });
  const imported = await serverState(page);
  expect(imported.profile).toBe('large');
  expect(imported.cpuSlots).toBe(4);
  expect(imported.cloudProfileId).toBe('aws.ec2.m7i-xlarge.us-east-1');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a size the provider does not offer becomes unpriced, not mispriced', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  await page.getByLabel('Cloud profile').selectOption('gcp.gce.e2-standard-2.us-central1');

  // Google has no small machine in this catalog, and AWS does. Reaching for the
  // AWS one would move the component between providers on the strength of a
  // size; keeping the Google medium would price a machine nobody selected.
  await page.getByLabel('Resource profile').selectOption('small');
  await expect.poll(async () => (await serverState(page)).cloudProfileId).toBeNull();

  const state = await serverState(page);
  expect(state.profile).toBe('small');
  expect(state.cpuSlots).toBe(1);
  await expect(page.getByText('This component is unpriced')).toBeVisible();
  await expect.poll(async () => (await serverState(page)).computeUnpriced).toBe(true);

  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.aparecium?.store.getState().ready)).toBe(true);
  await page.evaluate(async () => {
    const state = window.aparecium!.store.getState();
    await state.importFile(JSON.stringify({ kind: 'aparecium.project', formatVersion: 1,
      exportedAt: '', appVersion: '0.1.0', project: state.project, runs: state.runs }));
  });
  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  // Going back to a size Google does have picks Google, not AWS.
  await page.getByLabel('Resource profile').selectOption('large');
  await expect
    .poll(async () => (await serverState(page)).cloudProfileId)
    .toBe('gcp.gce.n2-standard-4.us-central1');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('manual pricing survives reopening and can be matched without changing hardware', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  await page.getByLabel('Cloud profile').selectOption('aws.ec2.m7i-xlarge.us-east-1');
  await expect(page.getByText('Hardware and price do not match')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.aparecium?.store.getState().ready)).toBe(true);
  expect((await serverState(page)).cloudProfileId).toBe('aws.ec2.m7i-xlarge.us-east-1');
  expect((await serverState(page)).profile).toBe('medium');
  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  await page.getByRole('button', { name: 'Use matching rates' }).click();
  expect((await serverState(page)).cloudProfileId).toBe('aws.ec2.m7i-large.us-east-1');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await serverState(page)).cloudProfileId).toBe('aws.ec2.m7i-xlarge.us-east-1');
  expect(errors).toEqual([]);
});

test('an existing project with old mismatched pricing is repaired without rewriting history', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();
  await page.getByRole('button', { name: /Stop (simulation|updates)/ }).click();
  // Seed the shape an older build saved, directly in storage rather than
  // through today's editor. Keep the earlier run as historical evidence.
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.evaluate(async () => {
    const record = structuredClone(window.aparecium!.store.getState().project!);
    const node = record.document.nodes.find((n) => n.kind === 'server')!;
    if (node.kind !== 'server') throw new Error('not a server');
    Object.assign(node.settings, { profile: 'large', cpuSlots: 4, ramMb: 8192, baselineMemoryMb: 512 });
    node.cloud = { profileId: 'aws.ec2.m7i-large.us-east-1' };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('aparecium');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put({ ...record, schemaVersion: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  expect((await serverState(page)).cloudProfileId).toBe('aws.ec2.m7i-xlarge.us-east-1');
  // Old results remain old. A new run uses the corrected price.
  expect((await serverState(page)).computeMonthly).toBe('73.58');
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('147.17');
});

test('a queue worker is priced the same way as any other server', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByText('Async write path: hand the slow work to a queue').click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Email worker' })).toBeVisible();
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const worker = () =>
    page.evaluate(() => {
      const store = window.aparecium!.store.getState();
      const node = store.project!.document.nodes.find((n) => n.name === 'Email worker')!;
      if (node.kind !== 'server') throw new Error('not a server');
      const line =
        store.latestRun?.cost.lines.find(
          (l) => l.nodeId === node.id && l.chargeType === 'compute',
        ) ?? null;
      return {
        profile: node.settings.profile,
        cpuSlots: node.settings.cpuSlots,
        cpuMsPerRequest: node.settings.cpuMsPerRequest,
        cloudProfileId: node.cloud.profileId,
        computeMonthly: line?.monthly ?? null,
      };
    });

  const before = await worker();
  // The template gives the worker custom hardware: one slow slot on purpose.
  expect(before.profile).toBe('custom');
  expect(before.cpuMsPerRequest).toBe(40);

  await page.locator('.react-flow__node').filter({ hasText: 'Email worker' }).click();
  await page.getByLabel('Resource profile').selectOption('large');
  await expect.poll(async () => (await worker()).cloudProfileId).toBe(
    'aws.ec2.m7i-xlarge.us-east-1',
  );

  const after = await worker();
  expect(after.cpuSlots).toBe(4);
  // Still the worker's own software settings, which is what makes it a worker.
  expect(after.cpuMsPerRequest).toBe(40);
  await expect.poll(async () => (await worker()).computeMonthly).toBe('147.17');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('custom hardware is priced as the machine it fits, not the one it came from', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  await page.getByLabel('Resource profile').selectOption('large');
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('147.17');

  // ---- Type eight CPU slots into the Large --------------------------------
  // The reported case. There is an eight-slot machine in the catalog now, so
  // this is a real fit at a real, published price: m7i.2xlarge at 0.4032 an
  // hour, 294.34 a month. More than the Large, as it should be.
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByLabel('CPU slots').fill('8');
  await page.getByLabel('CPU slots').blur();
  await expect.poll(async () => (await serverState(page)).profile).toBe('custom');
  await expect
    .poll(async () => (await serverState(page)).cloudProfileId)
    .toBe('aws.ec2.m7i-2xlarge.us-east-1');
  await expect(page.getByText('Priced as the smallest machine that fits')).toBeVisible();
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('294.34');
  await expect.poll(async () => (await serverState(page)).computeUnpriced).toBe(false);

  // ---- Beyond the catalog: sixteen slots ----------------------------------
  // Nothing has sixteen. It stays priced as the Extra large — the largest
  // machine there is — and the panel says that price is a floor. Reporting it
  // as unpriced would have dropped the line and made the bigger machine look
  // cheaper.
  await page.getByLabel('CPU slots').fill('16');
  await page.getByLabel('CPU slots').blur();
  await expect
    .poll(async () => (await serverState(page)).cloudProfileId)
    .toBe('aws.ec2.m7i-2xlarge.us-east-1');
  await expect(page.getByText('this price is a floor')).toBeVisible();
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('294.34');

  // ---- Bring it back within range: three slots fit a Large ----------------
  await page.getByLabel('CPU slots').fill('3');
  await page.getByLabel('CPU slots').blur();
  await expect
    .poll(async () => (await serverState(page)).cloudProfileId)
    .toBe('aws.ec2.m7i-xlarge.us-east-1');
  await expect(page.getByText('Priced as the smallest machine that fits')).toBeVisible();
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('147.17');

  // ---- And down to something a Small can hold -----------------------------
  await page.getByLabel('CPU slots').fill('1');
  await page.getByLabel('CPU slots').blur();
  await page.getByLabel('Memory capacity').fill('1500');
  await page.getByLabel('Memory capacity').blur();
  await expect
    .poll(async () => (await serverState(page)).cloudProfileId)
    .toBe('aws.ec2.t3-medium.us-east-1');
  // 0.05 an hour across 730 hours.
  await expect.poll(async () => (await serverState(page)).computeMonthly).toBe('30.37');

  // The software on the box never moved.
  const state = await serverState(page);
  expect(state.cpuMsPerRequest).toBe(8);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
