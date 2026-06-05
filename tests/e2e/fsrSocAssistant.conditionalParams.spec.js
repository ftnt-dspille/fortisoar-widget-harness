'use strict';
// Contract 2.4.0 — action_card conditional parameter trees (param_schema +
// visibility + onchange branches). Drives the conditional_block_ip fixture
// (FortiGate block_ip_new) and asserts the widget:
//   - renders typed controls (select/integer/checkbox) from param_schema
//   - reveals/hides branch fields recursively as selects change
//   - seeds defaults on first visibility without clobbering edits
//   - gates Confirm on currently-visible required fields only
//   - shows the gating branch label in the card head
//
// All scenarios append &fastmock=1 so fixture delays collapse to ~30ms.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const CARD = 'card-block-new';

async function boot(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    if (!localStorage.getItem('harness:config:' + id)) {
      localStorage.setItem('harness:config:' + id, JSON.stringify({
        connectorName: 'fortinet-fsr-playbook-builder',
        defaultIntent: 'triage', maxTurns: 10, showUsage: true, seedFromEntity: false
      }));
    }
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=conditional_block_ip&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 15000 });
  await page.locator(`[data-testid="action-card-${CARD}"]`).waitFor({ state: 'visible', timeout: 8000 });
  return errors;
}

const arg = (name) => `[data-testid="action-arg-${CARD}-${name}"]`;

test.describe('action_card 2.4.0 — conditional parameters', () => {

  test('Quarantine branch renders defaults + typed controls; Confirm enabled', async ({ page }) => {
    const errors = await boot(page);

    // method is a <select> (not a text input) with both options.
    const method = page.locator(arg('method'));
    await expect(method).toBeVisible();
    expect(await method.evaluate(el => el.tagName.toLowerCase())).toBe('select');
    await expect(method).toHaveValue('Quarantine Based');

    // Quarantine-branch fields visible; time_to_live default seeded.
    await expect(page.locator(arg('ip_addresses'))).toBeVisible();
    await expect(page.locator(arg('time_to_live'))).toHaveValue('12 Hour');
    await expect(page.locator(arg('vdom'))).toBeVisible();

    // Policy-branch fields are NOT present.
    await expect(page.locator(arg('ip_block_policy'))).toHaveCount(0);
    await expect(page.locator(arg('ip_type'))).toHaveCount(0);
    // duration only shows for time_to_live=Custom Time.
    await expect(page.locator(arg('duration'))).toHaveCount(0);

    // Branch label in the head.
    await expect(page.locator(`[data-testid="action-branch-${CARD}"]`))
      .toContainText('Block Method: Quarantine Based');

    // Required fields satisfied → Confirm enabled.
    await expect(page.locator(`[data-testid="action-confirm-${CARD}"]`)).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('nested branch: Custom Time reveals the integer duration field', async ({ page }) => {
    await boot(page);
    await page.locator(arg('time_to_live')).selectOption('Custom Time');
    const duration = page.locator(arg('duration'));
    await expect(duration).toBeVisible();
    expect(await duration.evaluate(el => el.getAttribute('type'))).toBe('number');
    await expect(duration).toHaveValue('21600'); // default seeded on first visibility
  });

  test('switching to Policy Based swaps the branch and recurses into ip_type', async ({ page }) => {
    await boot(page);
    await page.locator(arg('method')).selectOption('Policy Based');

    // Quarantine fields gone, Policy fields in.
    await expect(page.locator(arg('ip_addresses'))).toHaveCount(0);
    await expect(page.locator(arg('ip_block_policy'))).toBeVisible();
    await expect(page.locator(arg('ngfw_mode'))).toHaveValue('Profile Based');

    // ip_type default IPv4 seeded → its children appear.
    await expect(page.locator(arg('ip_type'))).toHaveValue('IPv4');
    await expect(page.locator(arg('ip_group_name'))).toBeVisible();
    await expect(page.locator(arg('ip'))).toBeVisible();

    // is_new has schema visible:false → never rendered as a control.
    await expect(page.locator(arg('is_new'))).toHaveCount(0);

    // ip_block_policy is required + empty → Confirm disabled.
    await expect(page.locator(`[data-testid="action-confirm-${CARD}"]`)).toBeDisabled();
    await page.locator(arg('ip_block_policy')).fill('FortiSOAR_Blocked_Policy');
    await page.locator(arg('ip_group_name')).fill('Blocked_IPs');
    await page.locator(arg('ip')).fill('["1.2.3.4"]');
    await expect(page.locator(`[data-testid="action-confirm-${CARD}"]`)).toBeEnabled();
  });

  test('IPv6 branch keeps ip_group_name + ip visible', async ({ page }) => {
    await boot(page);
    await page.locator(arg('method')).selectOption('Policy Based');
    await page.locator(arg('ip_type')).selectOption('IPv6');
    await expect(page.locator(arg('ip_group_name'))).toBeVisible();
    await expect(page.locator(arg('ip'))).toBeVisible();
  });

  test('edits survive branch toggles (defaults do not clobber)', async ({ page }) => {
    await boot(page);
    await page.locator(arg('method')).selectOption('Policy Based');
    await page.locator(arg('ngfw_mode')).selectOption('Policy Based');
    // Flip away and back; the user edit must persist.
    await page.locator(arg('method')).selectOption('Quarantine Based');
    await page.locator(arg('method')).selectOption('Policy Based');
    await expect(page.locator(arg('ngfw_mode'))).toHaveValue('Policy Based');
  });
});
