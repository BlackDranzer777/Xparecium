import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * The asynchronous write path, in a real browser.
 *
 * The engine tests prove the arithmetic. What this proves is that a person can
 * get to it: the component is in the palette, the template builds, the numbers
 * reach the canvas and the results sheet, and the live simulation keeps running
 * while a queue is being wired up.
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

test('a queue lets the caller go while the backlog grows behind it', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  // ---- The palette groups components now that there are enough to group ---
  await expect(page.getByText('Messaging', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Message Queue', exact: true })).toBeVisible();

  // ---- The template builds a working async design -------------------------
  await page.getByText('Async write path: hand the slow work to a queue').click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Email worker' })).toBeVisible();
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const summary = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    const queue = result.queues[0]!;
    return {
      completed: result.completed,
      rejected: result.rejected,
      meanMs: result.responseTime.meanMs,
      published: result.messagesPublished,
      processed: result.messagesProcessed,
      outstanding: queue.outstanding,
      consumerName: queue.consumerName,
    };
  });

  // Every caller was answered, and none of them waited for the worker.
  expect(summary.rejected).toBe(0);
  expect(summary.completed).toBe(1334);
  expect(summary.published).toBe(1334);
  expect(summary.consumerName).toBe('Email worker');

  // The worker is deliberately too slow, so the work is not done.
  expect(summary.processed).toBeLessThan(summary.published);
  expect(summary.outstanding).toBe(summary.published - summary.processed);
  expect(summary.outstanding).toBeGreaterThan(0);

  // ---- The canvas says so on the queue itself -----------------------------
  const queueCard = page.locator('.react-flow__node').filter({ hasText: 'Message Queue' });
  await expect(queueCard).toContainText('waiting');

  // ---- And the results sheet gives it a section of its own ----------------
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText(/still had \d+ messages waiting/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Components' }).nth(1).click();
  await expect(page.getByText('Message queues', { exact: true })).toBeVisible();
  await expect(page.getByText('drained by Email worker')).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * Whether an element is genuinely on screen where a person could click it.
 *
 * Playwright's own visibility check asks whether an element has a box and is
 * not `display:none` — it says nothing about an ancestor's `overflow: hidden`.
 * Both popovers in the control bar were clipped out of existence for exactly
 * that reason while a test asserting them "visible" passed. This asks the page
 * what is actually painted at the element's centre.
 */
async function isReallyOnScreen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return false;
    if (box.top < 0 || box.bottom > window.innerHeight) return false;
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || element.contains(hit);
  }, selector);
}

test('the control bar popovers are on screen, not clipped away', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  // ---- The traffic shape, which is new ------------------------------------
  await page.getByRole('button', { name: 'Steady' }).click();
  await expect(page.getByRole('tab', { name: 'Bursty' })).toBeVisible();
  expect(await isReallyOnScreen(page, 'body > .ap-card')).toBe(true);
  await page.getByRole('tab', { name: 'Bursty' }).click();
  await expect(page.getByRole('button', { name: 'Bursty' })).toBeVisible();
  await page.keyboard.press('Escape');

  // ---- The problems list, which has been there all along ------------------
  await page.evaluate(() => window.aparecium!.store.getState().addComponent('client'));
  await page.getByRole('button', { name: /problem/ }).click();
  await expect(page.getByText(/is not connected to anything/)).toBeVisible();
  expect(await isReallyOnScreen(page, 'body > .ap-card')).toBe(true);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the button that opens a popover also closes it', async ({ page }) => {
  // The panel closed on any press outside itself, including one on its own
  // button — whose click then reopened it. So the menu could be opened but
  // never closed from where it was opened.
  await openFresh(page);
  const menu = page.getByRole('button', { name: 'Projects, import and export' });
  // The glyph folds from three bars into a cross while the menu is open.
  const topBar = menu.locator('.ap-burger-line').first();
  await expect(topBar).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -5)');
  await menu.click();
  await expect(page.getByText('Saved in this browser', { exact: false })).toBeVisible();
  await expect(topBar).toHaveCSS('transform', /matrix\(0\.7071/);
  await menu.click();
  await expect(page.getByText('Saved in this browser', { exact: false })).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(topBar).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -5)');

  // The same for a control-bar popover, and a press elsewhere still closes it.
  const shape = page.getByRole('button', { name: 'Steady' });
  await shape.click();
  await expect(page.getByRole('tab', { name: 'Bursty' })).toBeVisible();
  await shape.click();
  await expect(page.getByRole('tab', { name: 'Bursty' })).toBeHidden();
  await shape.click();
  await expect(page.getByRole('tab', { name: 'Bursty' })).toBeVisible();
  await page.mouse.click(700, 300);
  await expect(page.getByRole('tab', { name: 'Bursty' })).toBeHidden();
});

test('wiring up a queue does not stop the traffic', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByLabel('Simulation mode').selectOption('live');
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const packetOpacity = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ap-packet')]
        .slice(0, 3)
        .map((c) => (c as HTMLElement).style.opacity),
    );
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  // A queue with nothing behind it is an error, exactly like a second database.
  // The simulation stays live and keeps showing what it last managed.
  await page.evaluate(() => window.aparecium!.store.getState().addComponent('queue'));
  await page.evaluate(() => {
    const store = window.aparecium!.store;
    const document = store.getState().project!.document;
    const server = document.nodes.find((n) => n.kind === 'server')!;
    const queue = document.nodes.find((n) => n.kind === 'queue')!;
    store.getState().connect(server.id, queue.id);
  });
  await expect(page.getByRole('button', { name: /problem/ })).toBeVisible();
  expect(await packetOpacity()).toEqual(['1', '1', '1']);
  await expect(page.getByRole('button', { name: /Stop (simulation|updates)/ })).toBeVisible();

  // Finish the wiring and it picks itself up without being asked.
  await page.evaluate(() => {
    const store = window.aparecium!.store;
    store.getState().addComponent('server');
    const document = store.getState().project!.document;
    const queue = document.nodes.find((n) => n.kind === 'queue')!;
    const worker = document.nodes.filter((n) => n.kind === 'server').at(-1)!;
    store.getState().connect(queue.id, worker.id);
  });
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.messagesPublished),
    )
    .toBeGreaterThan(0);
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
