'use strict';
// ─── Light/dark auto-theme support ──────────────────────────────────────────
// The widget is dark-by-default. FortiSOAR exposes the active theme via
// $rootScope.theme.id ("light" | "dark" | "steel"/"space"); the controller
// mirrors it onto $scope.currentTheme and the root toggles `.theme-light`.
// The harness seeds $rootScope.theme.id from its theme picker (localStorage
// "harness.theme"), so we drive the two themes from there and verify:
//   1. the root carries (or omits) the theme-light class,
//   2. the computed root background actually flips light vs dark.
const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function gotoWidget(page, theme) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(({ id, theme }) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'build', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness.theme', theme);
  }, { id: WIDGET_ID, theme });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 15000 });
  return errors;
}

// Parse "rgb(r, g, b)" → perceived luminance (0=black .. 255=white).
function luminance(rgb) {
  const m = rgb.match(/(\d+(?:\.\d+)?)/g);
  if (!m) return null;
  const [r, g, b] = m.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('dark theme: root has no theme-light class and renders dark', async ({ page }) => {
  const errors = await gotoWidget(page, 'dark');
  const root = page.locator('[data-testid="fsr-pb-root"]');
  await expect(root).toBeVisible();
  await expect(root).not.toHaveClass(/theme-light/);
  const bg = await root.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(luminance(bg)).toBeLessThan(80); // dark base (#12141d ≈ 20)
  await page.screenshot({ path: 'test-results/fsrpb-theme-dark.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('light theme: root gains theme-light class and renders light', async ({ page }) => {
  const errors = await gotoWidget(page, 'light');
  const root = page.locator('[data-testid="fsr-pb-root"]');
  await expect(root).toBeVisible();
  await expect(root).toHaveClass(/theme-light/);
  // currentTheme propagated from $rootScope.theme.id
  const theme = await page.evaluate(() => window.__fsrSocAssistant__ &&
    window.__fsrSocAssistant__.currentTheme);
  // Background must read as light (#ffffff base ≈ 255).
  const bg = await root.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(luminance(bg)).toBeGreaterThan(180);
  // Primary text must read as dark for contrast on the light surface.
  const composerPlaceholder = page.locator('.fsr-pb-widget .empty-hero .heading, .fsr-pb-widget .topbar .title').first();
  if (await composerPlaceholder.count()) {
    const color = await composerPlaceholder.evaluate(el => getComputedStyle(el).color);
    // title uses a gradient (transparent text); only assert when a solid color.
    if (color && !/rgba\(0, 0, 0, 0\)/.test(color)) {
      const lum = luminance(color);
      if (lum !== null) expect(lum).toBeLessThan(160);
    }
  }
  await page.screenshot({ path: 'test-results/fsrpb-theme-light.png', fullPage: true });
  expect(theme === undefined || theme === 'light').toBeTruthy();
  expect(errors).toEqual([]);
});

const INCIDENT_DETAIL = {
  '@id': '/api/3/incidents/a0668705-9dc8-4797-a2c8-8f1e1f34942a',
  '@type': 'Incident',
  name: 'Detected intrusion traffic attempts from 192.168.77.30 to 12.62.213.134',
  incidentsummary: 'Internal host 192.168.77.30 sent unusually large volumes of outbound email traffic to external server 12.62.213.134, flagged as a traffic anomaly.',
  sourceIP: '192.168.77.30', destinationIP: '12.62.213.134',
  mitreattackid: 'T1041 - Exfiltration Over Command and Control Channel',
  source: 'Fortinet FortiSIEM',
  severity: { '@type': 'Picklist', itemValue: 'Medium' },
  status: { '@type': 'Picklist', itemValue: 'Open' },
  phase: { '@type': 'Picklist', itemValue: 'Detection' },
  recordTags: ['Collection', 'Excessive Mail', 'Outbound Email', 'Suspicious IP'],
  id: 558, uuid: 'a0668705-9dc8-4797-a2c8-8f1e1f34942a'
};

test('light theme: a populated status card renders with readable accent badges', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness.theme', 'light');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: INCIDENT_DETAIL });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=incident_smtp_intrusion&fastmock=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__fsrSocAssistant__ &&
    window.__fsrSocAssistant__.state === 'idle', null, { timeout: 15000 });

  const root = page.locator('[data-testid="fsr-pb-root"]');
  await expect(root).toHaveClass(/theme-light/);
  const card = page.locator('[data-testid="info-card-entity-558"]');
  await expect(card).toBeVisible();
  // Severity tag text colour must be a dark hue (not the pastel dark-theme one).
  const tagColor = await card.locator('.status-sev-tag').first()
    .evaluate(el => getComputedStyle(el).color);
  expect(luminance(tagColor)).toBeLessThan(170);
  await page.screenshot({ path: 'test-results/fsrpb-theme-light-card.png', fullPage: true });
  expect(errors, errors.join(' | ')).toEqual([]);
});
