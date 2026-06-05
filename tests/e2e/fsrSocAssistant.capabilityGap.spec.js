'use strict';
// capability_gap card — the "never dead-end the analyst" card. When the agent
// hits a missing/unconfigured capability it emits a `capability_gap` event whose
// dedicated widget card shows: what's missing, why, ordered fix steps, tips,
// a docs link, a "Re-check & continue" resume button, and alternative actions.
// Drives the mock `capability_gap` fixture: the opener chat_turn returns an
// `awaiting_choice` turn whose last event is the capability_gap card; we assert
// it renders fully (NOT in the generic block) and that both the resume button
// and an alternative chip resolve through chat_resume.

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
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=capability_gap&fastmock=1${extra || ''}`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 25000 }
  );
}

const CARD = '[data-testid="capability-gap-card-capgap-fortiedr-1"]';

test.describe('capability_gap card', () => {
  test('renders as a dedicated card (not the generic block) with all sections', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await boot(page, '&opener=1');
    const card = page.locator(CARD);
    await expect(card).toBeVisible();
    // dedicated class, not a fallthrough generic .pb-card
    await expect(card).toHaveClass(/capability-gap-card/);

    // header / missing / why
    await expect(card.locator('.capgap-title')).toContainText('FortiEDR endpoint isolation');
    await expect(card.locator('.capgap-why')).toContainText("isn't configured");

    // ordered fix steps — all three render
    await expect(card.locator('.capgap-steps li')).toHaveCount(3);
    await expect(card.locator('.capgap-steps li').first()).toContainText('Settings → Connectors');

    // tips (with hint), docs link, resume button, both alternatives
    await expect(card.locator('.capgap-tips li')).toHaveCount(2);
    await expect(card.locator('.capgap-tip-hint')).toContainText('least-privilege');
    await expect(card.locator('.capgap-docs a')).toHaveAttribute('href', 'https://docs.fortinet.com/fortiedr/connector');
    await expect(card.locator('[data-testid="capgap-resume-capgap-fortiedr-1"]')).toContainText('Re-check & continue');
    await expect(card.locator('[data-testid="capgap-alt-capgap-fortiedr-1-block_ip"]')).toBeVisible();
    await expect(card.locator('[data-testid="capgap-alt-capgap-fortiedr-1-escalate"]')).toBeVisible();

    await page.screenshot({ path: '/tmp/capability_gap_card.png', fullPage: true });
    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('resume button resolves the card and surfaces the recheck turn', async ({ page }) => {
    await boot(page, '&opener=1');
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator('[data-testid="capgap-resume-capgap-fortiedr-1"]').click();
    // resolution footer appears, action buttons gone (card consumed)
    await expect(page.locator('[data-testid="capgap-resolution-capgap-fortiedr-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="capgap-resume-capgap-fortiedr-1"]')).toHaveCount(0);
    // the recheck resume turn renders
    await expect(page.locator('.fsr-pb-widget')).toContainText('isolated');
  });

  test('alternative chip resolves the card and surfaces its resume turn', async ({ page }) => {
    await boot(page, '&opener=1');
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator('[data-testid="capgap-alt-capgap-fortiedr-1-block_ip"]').click();
    await expect(page.locator('[data-testid="capgap-resolution-capgap-fortiedr-1"]'))
      .toContainText('Block IP at FortiGate');
    await expect(page.locator('[data-testid="capgap-alt-capgap-fortiedr-1-block_ip"]')).toHaveCount(0);
    await expect(page.locator('.fsr-pb-widget')).toContainText('blocked');
  });
});
