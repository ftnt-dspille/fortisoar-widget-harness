'use strict';
const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');
let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

test('info_cards fixture renders all card kinds without errors', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=info_cards&fastmock=1&opener=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === 'idle', null, { timeout: 15000 });

  await expect(page.locator('[data-testid="info-card-status-splunk"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-status-fortigate"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"]')).toBeVisible();
  // block kinds inside the IOC card
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-score')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-tag').first()).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-table')).toBeVisible();
  // composer must NOT be gated — state is idle (asserted above)
  await page.screenshot({ path: '/tmp/info_cards.png', fullPage: true });
  expect(errors, 'no console/page errors: ' + errors.join(' | ')).toEqual([]);
});
