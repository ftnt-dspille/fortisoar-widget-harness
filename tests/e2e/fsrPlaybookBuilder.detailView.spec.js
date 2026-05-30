'use strict';
const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');
let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const INCIDENT = {
  '@id': '/api/3/incidents/a0668705-9dc8-4797-a2c8-8f1e1f34942a',
  '@type': 'Incident',
  name: 'Detected intrusion traffic attempts from 192.168.77.30 to 12.62.213.134',
  incidentsummary: 'Internal host 192.168.77.30 sent unusually large volumes of outbound email traffic to external server 12.62.213.134 on 27 May 2026, flagged as a traffic anomaly.',
  description: 'A series of bidirectional netflow logs indicate excessive outbound SMTP traffic...',
  sourceIP: '192.168.77.30',
  destinationIP: '12.62.213.134',
  mitreattackid: 'T1041 - Exfiltration Over Command and Control Channel',
  source: 'Fortinet FortiSIEM',
  severity: { '@type': 'Picklist', itemValue: 'Medium' },
  status: { '@type': 'Picklist', itemValue: 'Open' },
  phase: { '@type': 'Picklist', itemValue: 'Detection' },
  recordTags: ['Collection', 'Excessive Mail', 'Outbound Email', 'Suspicious IP', 'Traffic Anomaly'],
  id: 558, uuid: 'a0668705-9dc8-4797-a2c8-8f1e1f34942a'
};

test('detail-view entity seed renders as a structured card; build toggle round-trips', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: INCIDENT });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=incident_smtp_intrusion&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === 'idle', null, { timeout: 15000 });

  // Entity seed renders as an info_card (not a raw markdown blob).
  const card = page.locator('[data-testid="info-card-entity-558"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.status-title')).toContainText('Detected intrusion');
  await expect(card.locator('.status-row-label', { hasText: 'Source IP' })).toBeVisible();
  await expect(card.locator('.status-row-label', { hasText: 'Dest IP' })).toBeVisible();
  await expect(card.locator('.status-row-label', { hasText: 'MITRE' })).toBeVisible();
  await expect(card.locator('.status-tag').first()).toBeVisible();

  // Starts in triage (entity present); build toggle round-trips.
  expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.intent)).toBe('triage');
  await page.locator('[data-testid="switch-to-build"]').click();
  expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.intent)).toBe('build');
  await expect(page.locator('[data-testid="build-hint"]')).toBeVisible();
  await expect(page.locator('[data-testid="switch-to-triage"]')).toBeVisible();
  await page.locator('[data-testid="switch-to-triage"]').click();
  expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.intent)).toBe('triage');

  await page.screenshot({ path: '/tmp/detail_view.png', fullPage: true });
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});
