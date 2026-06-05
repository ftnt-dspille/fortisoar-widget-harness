'use strict';
// YAML pane hide/show toggle (DOM wiring). Analysts who just want the chat can
// hide the YAML pane; the toggle lives in the topbar (and the pane header), the
// chat goes full width, and a compact "Create Playbook" shortcut moves to the
// topbar so the build is still completable while the pane is hidden.
//
// Runs in mock mode and seeds YAML through the test probe (no live connector).
// The persistence-across-reload behavior is covered by the jest unit test
// (tests/yaml.hide.test.js); here we assert the DOM reacts to the toggle.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const PANE   = '[data-testid="yaml-pane"]';
const TOGGLE = '[data-testid="toggle-yaml"]';
const CREATE = '[data-testid="topbar-create"]';
const HIDE   = '[data-testid="yaml-hide"]';

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    localStorage.removeItem('fsrPbYamlHidden');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 25000 });
  // Seed authored YAML into build mode so the pane is on screen.
  await page.evaluate(() => {
    window.__fsrSocAssistant__.seedTriageDraft('playbooks:\n  - name: Test Playbook');
    window.__fsrSocAssistant__.openDraftInBuild();
  });
}

test.describe('YAML pane hide/show toggle', () => {
  test('toggle hides the pane, moves Create to the topbar, and shows it again', async ({ page }) => {
    await boot(page);

    // Visible by default: pane + header Hide button + topbar toggle reads "Hide".
    await expect(page.locator(PANE)).toBeVisible();
    await expect(page.locator(HIDE)).toBeVisible();
    await expect(page.locator(TOGGLE)).toContainText('Hide YAML');
    await expect(page.locator(CREATE)).toHaveCount(0);   // no topbar Create while pane is shown

    // Hide via the topbar toggle.
    await page.locator(TOGGLE).click();
    await expect(page.locator(PANE)).toHaveCount(0);     // pane gone, chat full width
    await expect(page.locator(TOGGLE)).toContainText('Show YAML');
    await expect(page.locator(CREATE)).toBeVisible();    // Create shortcut available while hidden
    await expect(page.locator(CREATE)).toBeEnabled();

    // Show again restores the pane and removes the topbar shortcut.
    await page.locator(TOGGLE).click();
    await expect(page.locator(PANE)).toBeVisible();
    await expect(page.locator(CREATE)).toHaveCount(0);
    await expect(page.locator(TOGGLE)).toContainText('Hide YAML');
  });

  test('the pane header "Hide" button also hides the pane', async ({ page }) => {
    await boot(page);
    await expect(page.locator(PANE)).toBeVisible();
    await page.locator(HIDE).click();
    await expect(page.locator(PANE)).toHaveCount(0);
    await expect(page.locator(TOGGLE)).toContainText('Show YAML');
  });
});
