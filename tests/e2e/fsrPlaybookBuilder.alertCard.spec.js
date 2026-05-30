'use strict';
const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');
let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

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
  await page.waitForFunction(() => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === 'idle', null, { timeout: 15000 });

  const card = page.locator('[data-testid="info-card-entity-777"]');
  await expect(card).toBeVisible();
  // badge shows the real severity word, not "error"
  await expect(card.locator('.status-sev-tag')).toHaveText('Critical');
  // raw Jinja must NOT appear anywhere in the card
  await expect(card).not.toContainText('{{');
  await expect(card).not.toContainText('vars.input');
  // no leftover empty summary; status + source present
  await expect(card.locator('.status-row-label', { hasText: 'Status' })).toBeVisible();
  await page.screenshot({ path: '/tmp/alert_card.png' });
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});
