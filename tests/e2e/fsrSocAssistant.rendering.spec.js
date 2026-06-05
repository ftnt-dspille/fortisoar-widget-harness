'use strict';
// Consolidates rendering-focused single-scenario tests:
//   - alertCard: Jinja stripped from alert description, severity badge correct
//   - detailView: entity seed renders as info_card, build/triage toggle round-trips
//   - infoCards: info_cards fixture renders all card variants without errors

const { test, expect } = require('@playwright/test');
const { waitForWidgetIdle } = require('./_waitForWidgetIdle');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

// ─── Alert card rendering ────────────────────────────────────────────────────

const ALERT = {
  '@id': '/api/3/alerts/deadbeef-1111-2222-3333-444455556666',
  '@type': 'Alert',
  name: 'Immediate Action Required: Password Reset Notice',
  description: '{{vars.input.records[0].eventTime }}',   // unrendered Jinja
  source: 'User Reported',
  severity: { '@type': 'Picklist', itemValue: 'Critical' },
  status: { '@type': 'Picklist', itemValue: 'Pending' },
  recordTags: ['Phishing'],
  id: 777, uuid: 'deadbeef-1111-2222-3333-444455556666'
};

test('alert: jinja stripped, badge shows real severity not ERROR', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({ connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id); localStorage.setItem('harness.ctx', 'dashboard'); localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: ALERT });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=incident_smtp_intrusion&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__fsrSocAssistant__');

  const card = page.locator('[data-testid="info-card-entity-777"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.status-sev-tag')).toHaveText('Critical');
  await expect(card).not.toContainText('{{');
  await expect(card).not.toContainText('vars.input');
  await expect(card.locator('.status-row-label', { hasText: 'Status' })).toBeVisible();
  await page.screenshot({ path: '/tmp/alert_card.png' });
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

// ─── Detail-view / entity seed ───────────────────────────────────────────────

const INCIDENT_DETAIL = {
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
  }, { id: WIDGET_ID, entity: INCIDENT_DETAIL });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=incident_smtp_intrusion&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__fsrSocAssistant__');

  const card = page.locator('[data-testid="info-card-entity-558"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.status-title')).toContainText('Detected intrusion');
  await expect(card.locator('.status-row-label', { hasText: 'Source IP' })).toBeVisible();
  await expect(card.locator('.status-row-label', { hasText: 'Dest IP' })).toBeVisible();
  await expect(card.locator('.status-row-label', { hasText: 'MITRE' })).toBeVisible();
  await expect(card.locator('.status-tag').first()).toBeVisible();

  expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('triage');
  await page.locator('[data-testid="switch-to-build"]').click();
  expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('build');
  await expect(page.locator('[data-testid="build-hint"]')).toBeVisible();
  await expect(page.locator('[data-testid="switch-to-triage"]')).toBeVisible();
  await page.locator('[data-testid="switch-to-triage"]').click();
  expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('triage');

  await page.screenshot({ path: '/tmp/detail_view.png', fullPage: true });
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

// ─── Info-cards fixture (all card variants) ──────────────────────────────────

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
  await waitForWidgetIdle(page, '__fsrSocAssistant__');

  // Backend pre-flight activity trail (contract 2.8.0) coalesces into one
  // block of bulleted phase lines, rendered ahead of the cards.
  await expect(page.locator('.pb-activity').first()).toBeVisible();
  await expect(page.locator('.pb-activity .pb-activity-line')).toHaveCount(3);
  await expect(page.locator('.pb-activity')).toContainText('Classified as C2/exfil');
  await expect(page.locator('[data-testid="info-card-status-splunk"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-status-fortigate"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-score')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-tag').first()).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-table')).toBeVisible();
  // playbook_pushed card renders the designer deep link as a real anchor.
  const pbLink = page.locator('[data-testid="info-card-pushed-offer1"] .status-link a');
  await expect(pbLink).toBeVisible();
  await expect(pbLink).toHaveAttribute('href', '/playbooks/wf-uuid-1');
  await expect(pbLink).toHaveAttribute('target', '_blank');
  await page.screenshot({ path: '/tmp/info_cards.png', fullPage: true });
  expect(errors, 'no console/page errors: ' + errors.join(' | ')).toEqual([]);
});
