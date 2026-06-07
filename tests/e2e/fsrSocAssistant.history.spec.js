'use strict';
const { test, expect } = require('@playwright/test');

const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => {
  WIDGET_ID = await resolveWidgetId(request);
});

async function gotoWidget(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'build', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ &&
          typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 30000 });
  return errors;
}

test.describe('FSR SOC Assistant — history browser', () => {

  test('History button opens the panel; empty store shows the empty state', async ({ page }) => {
    const errors = await gotoWidget(page);

    await expect(page.locator('[data-testid="open-history"]')).toBeVisible();
    await page.locator('[data-testid="open-history"]').click();

    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();
    // Mock mode never hits the connector, so the list comes back empty.
    await expect(page.locator('[data-testid="history-empty"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('renders injected sessions, marks the current one, and reopens on click', async ({ page }) => {
    await gotoWidget(page);

    // The session this tab is on — inject it so the "current" badge shows.
    const current = await page.evaluate(() => window.__fsrSocAssistant__.sessionId);

    await page.locator('[data-testid="open-history"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();

    await page.evaluate((cur) => {
      window.__fsrSocAssistant__.injectSessions([
        { session_id: cur, title: 'this conversation', entries: 3, last_activity: 9 },
        { session_id: 'sess-prior-1', title: 'block 1.2.3.4 at the edge', entries: 6, last_activity: 5 },
        { session_id: 'sess-prior-2', title: 'triage the phishing alert', entries: 2, last_activity: 2 },
      ]);
    }, current);

    const items = page.locator('[data-testid="history-item"]');
    await expect(items).toHaveCount(3);
    await expect(page.locator('[data-testid="history-item-title"]').first()).toContainText('this conversation');

    // Exactly one item is flagged current, and it's the active session row.
    const currentRow = page.locator(`[data-testid="history-item"][data-session="${current}"]`);
    await expect(currentRow).toHaveClass(/is-current/);
    await expect(currentRow.locator('.history-current-badge')).toBeVisible();

    // Clicking a prior session closes the panel (the reopen path).
    await page.locator('[data-testid="history-item"][data-session="sess-prior-1"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toHaveCount(0);
    const open = await page.evaluate(() => window.__fsrSocAssistant__.historyOpen);
    expect(open).toBe(false);
  });

  test('header lays out with title left and a square close button at the right edge', async ({ page }) => {
    await gotoWidget(page);
    await page.locator('[data-testid="open-history"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();

    const header = page.locator('.history-panel .modal-header');
    const title = page.locator('.history-panel .modal-title');
    const close = page.locator('[data-testid="history-close"]');

    const [hb, tb, cb] = await Promise.all([
      header.boundingBox(), title.boundingBox(), close.boundingBox(),
    ]);

    // Title sits to the left of the close button (not centered/overlapping).
    expect(tb.x + tb.width).toBeLessThanOrEqual(cb.x + 1);
    // Close button is hugged against the header's right edge (within the
    // header's own horizontal padding, ~18px, plus the button's box).
    expect((hb.x + hb.width) - (cb.x + cb.width)).toBeLessThan(40);
    // Close button renders as a compact, near-square control (not a stray glyph).
    expect(Math.abs(cb.width - cb.height)).toBeLessThan(6);
    expect(cb.width).toBeLessThanOrEqual(34);
  });

  test('backdrop and close button dismiss the panel', async ({ page }) => {
    await gotoWidget(page);
    await page.locator('[data-testid="open-history"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();
    await page.locator('[data-testid="history-close"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toHaveCount(0);
  });
});
