'use strict';
// playbook_offer card (contract 2.5.0) — the end-of-triage "Save as Playbook"
// CTA. Drives the mock `playbook_offer_decline` fixture: the opener chat_turn
// returns an `awaiting_playbook_offer` turn whose last event is a playbook_offer
// card; we assert it renders (summary + step list + editable title) and that
// both the decline and accept resume paths resolve through chat_resume.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, extra) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=playbook_offer_decline&fastmock=1${extra || ''}`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForFunction(
    () => window.__fsrPlaybookBuilder__ && typeof window.__fsrPlaybookBuilder__.state === 'string',
    null, { timeout: 25000 }
  );
}

const OFFER = '[data-testid="playbook-offer-pb-offer-c2-1"]';

test.describe('playbook_offer card', () => {
  test('renders summary, step list and editable title', async ({ page }) => {
    await boot(page, '&opener=1');
    const card = page.locator(OFFER);
    await expect(card).toBeVisible();
    await expect(card.locator('.po-summary')).toContainText('repeatable playbook');
    // both ops_summary entries become numbered steps
    await expect(page.locator('[data-testid="playbook-offer-step-pb-offer-c2-1-0"]')).toContainText('Block 102.220.160.21');
    await expect(page.locator('[data-testid="playbook-offer-step-pb-offer-c2-1-1"]')).toContainText('Quarantine smithDesktop');
    // title input is pre-filled from title_suggestion (so accept works untouched)
    await expect(page.locator('[data-testid="playbook-offer-title-pb-offer-c2-1"]'))
      .toHaveValue('C2 Containment — 102.220.160.21');
  });

  test('decline resolves the card and ends the turn', async ({ page }) => {
    await boot(page, '&opener=1');
    await expect(page.locator(OFFER)).toBeVisible();
    await page.locator('[data-testid="playbook-offer-decline-pb-offer-c2-1"]').click();
    // resolution footer appears, action buttons gone
    await expect(page.locator('[data-testid="playbook-offer-resolution-pb-offer-c2-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="playbook-offer-accept-pb-offer-c2-1"]')).toHaveCount(0);
    // the decline turn's text renders
    await expect(page.locator('.fsr-pb-widget')).toContainText("won't save a playbook");
  });

  test('accept (with edited title) resolves and surfaces the pushed-playbook turn', async ({ page }) => {
    await boot(page, '&opener=1');
    const title = page.locator('[data-testid="playbook-offer-title-pb-offer-c2-1"]');
    await expect(title).toBeVisible();
    await title.fill('My Custom Playbook');
    await page.locator('[data-testid="playbook-offer-accept-pb-offer-c2-1"]').click();
    await expect(page.locator('[data-testid="playbook-offer-resolution-pb-offer-c2-1"]'))
      .toContainText('My Custom Playbook');
    // accept turn returns an info_card confirming the push
    await expect(page.locator('.fsr-pb-widget')).toContainText('Playbook pushed');
  });
});
