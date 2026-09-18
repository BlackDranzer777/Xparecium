import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * The four edge components, in a real browser.
 *
 * The engine tests prove the arithmetic. What this proves is that a person can
 * get to it: the components are in the palette, the template builds, the CDN's
 * numbers reach the canvas and the results sheet, the WAF's blocks show up as
 * rejections with their own reason, and the cost sheet prices the four with
 * the verified rates.
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

test('the edge template keeps most of the load off the origin', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  // ---- The palette has a group for them -------------------------------------
  await expect(page.getByText('Edge', { exact: true }).first()).toBeVisible();
  for (const name of ['DNS', 'CDN', 'WAF', 'API Gateway']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }

  // ---- The template builds a working design ---------------------------------
  await page.getByText('Edge in front: DNS, CDN, WAF and API gateway').click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'API Gateway' })).toBeVisible();
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const summary = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    const station = (kind: string) => result.stations.find((s) => s.kind === kind)!;
    const cdn = station('cdn');
    const waf = station('waf');
    const gateway = station('apiGateway');
    const dns = station('dns');
    const balancer = station('loadBalancer');
    return {
      offered: result.offered,
      completed: result.completed,
      rejected: result.rejected,
      reasons: result.rejectionsByReason,
      cdn: { hits: cdn.hits ?? 0, misses: cdn.misses ?? 0, operations: cdn.operations },
      waf: { inspected: waf.operations, blocked: waf.blocked ?? 0 },
      gateway: { operations: gateway.operations, throttled: gateway.throttled ?? 0 },
      dns: { lookups: dns.operations },
      balancerForwarded: balancer.operations,
      served: result.servers.reduce((sum, s) => sum + s.completed, 0),
    };
  });

  // Every request went through the CDN; about four in five never went further.
  expect(summary.cdn.operations).toBe(summary.offered);
  expect(summary.cdn.hits + summary.cdn.misses).toBe(summary.offered);
  expect(summary.cdn.hits / summary.offered).toBeGreaterThan(0.7);
  expect(summary.cdn.hits / summary.offered).toBeLessThan(0.9);

  // Only the misses reached the WAF, and only what the WAF let through reached
  // the gateway; with no rate limit, all of that reached the balancer.
  expect(summary.waf.inspected).toBe(summary.cdn.misses);
  expect(summary.gateway.operations).toBe(summary.waf.inspected - summary.waf.blocked);
  expect(summary.gateway.throttled).toBe(0);
  expect(summary.balancerForwarded).toBe(summary.gateway.operations);

  // The WAF's blocks are the only rejections, under their own reason. At a 1%
  // block share and ~260 requests reaching it, a run may honestly block none;
  // what must hold is that every block is a rejection and nothing else is.
  expect(summary.rejected).toBe(summary.waf.blocked);
  expect(summary.reasons['waf-blocked'] ?? 0).toBe(summary.waf.blocked);

  // A small share of requests asked the DNS first.
  expect(summary.dns.lookups).toBeGreaterThan(0);
  expect(summary.dns.lookups).toBeLessThan(summary.offered * 0.1);

  // Nothing was lost: hits + served + blocked = everything.
  expect(summary.cdn.hits + summary.served + summary.waf.blocked).toBe(summary.offered);
  expect(summary.completed).toBe(summary.offered - summary.rejected);

  // ---- The canvas says so on the CDN itself ----------------------------------
  const cdnCard = page.locator('.react-flow__node').filter({ hasText: 'CDN' });
  await expect(cdnCard).toContainText('hits');
  await expect(cdnCard).toContainText('to origin');
  const wafCard = page.locator('.react-flow__node').filter({ hasText: 'WAF' });
  await expect(wafCard).toContainText('blocked');

  // ---- And the results sheet gives them a section of their own ---------------
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText(/answered \d+ of \d+ requests at the edge/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Components' }).nth(1).click();
  await expect(page.getByText('Edge', { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/API gateway · 0 throttled/)).toBeVisible();

  // ---- The cost sheet prices the four with verified rates --------------------
  await page.getByRole('tab', { name: 'Cost' }).click();
  await expect(page.getByText('Route 53 (standard queries)').first()).toBeVisible();
  await expect(page.getByText('CloudFront (United States edge)').first()).toBeVisible();
  await expect(page.getByText('AWS WAF (one web ACL)').first()).toBeVisible();
  await expect(page.getByText('API Gateway (HTTP API)').first()).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a rate limit on the gateway turns the excess away instead of queueing it', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByText('Edge in front: DNS, CDN, WAF and API gateway').click();
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();

  // Set a limit far below the load through the Inspector, the way a person would.
  await page.locator('.react-flow__node').filter({ hasText: 'API Gateway' }).click();
  await page.getByLabel('Enforce a rate limit').check();
  const limit = page.getByLabel('Requests let through');
  await limit.fill('2');
  await limit.press('Enter');

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const summary = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    const gateway = result.stations.find((s) => s.kind === 'apiGateway')!;
    return {
      throttled: gateway.throttled ?? 0,
      operations: gateway.operations,
      queuePeak: gateway.queuePeak,
      reason: result.rejectionsByReason['gateway-throttled'] ?? 0,
    };
  });
  expect(summary.throttled).toBeGreaterThan(0);
  expect(summary.reason).toBe(summary.throttled);
  // Refused, not queued: the gateway's own queue never built up.
  expect(summary.queuePeak).toBe(0);

  const card = page.locator('.react-flow__node').filter({ hasText: 'API Gateway' });
  await expect(card).toContainText('throttled');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
