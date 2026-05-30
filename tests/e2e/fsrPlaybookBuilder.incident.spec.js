'use strict';
// Covers the Phase A–E work on the FortiSOC Action Assistant widget:
//   - Phase A: contract_version drift (banner + strict halt), mode/intent/entity
//              stamped into outgoing payloads
//   - Phase B: auto-seed a record summary as the assistant's first message
//   - Phase C: triage hides the YAML pane; "Build mode" reveals it
//   - Phase D: incident_smtp_intrusion fixture (intel hops → action_card → exec)
//   - Phase E: action_card Confirm gated on required fields
//
// All scenarios append &fastmock=1 so fixture delays collapse to ~30ms.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

// Resolved at runtime so the suite survives widget version bumps.
let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const SAMPLE_INCIDENT = {
  '@id': '/api/3/incidents/11111111-2222-3333-4444-555555555555',
  name: 'SMTP intrusion on mail-relay-02',
  severity: { itemValue: 'High' },
  status: { itemValue: 'Open' },
  source: 'FortiSIEM',
  type: 'Intrusion',
  description: 'Outbound beaconing detected from mail-relay-02 (10.20.4.11) to 185.220.101.47 over SMTP submission port.'
};

function urlFor(scenario, extra) {
  // scenario null → omit &mock= (used to test the ?mode=mock override, where
  // the scenario comes from config.mockScenario instead of the URL).
  const mockParam = scenario ? `&mock=${scenario}` : '';
  return `/?widget=${WIDGET_ID}&context=Dashboard${mockParam}&fastmock=1${extra || ''}`;
}

async function boot(page, scenario, opts) {
  opts = opts || {};
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    const { id, entity, cfg } = args;
    if (!localStorage.getItem('harness:config:' + id)) {
      localStorage.setItem('harness:config:' + id, JSON.stringify(Object.assign({
        connectorName: 'fortinet-fsr-playbook-builder',
        defaultIntent: 'build',
        maxTurns: 10,
        showUsage: true,
        seedFromEntity: true
      }, cfg || {})));
    }
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    if (entity) window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: opts.entity || null, cfg: opts.cfg || null });
  await page.goto(urlFor(scenario, opts.extra), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrPlaybookBuilder__ && typeof window.__fsrPlaybookBuilder__.state === 'string',
    null, { timeout: 15000 }
  );
  return errors;
}

async function waitForState(page, state, timeout = 5000) {
  await page.waitForFunction(
    (s) => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === s,
    state, { timeout }
  );
}

// ─── Phase D + B + E: incident_smtp_intrusion ──────────────────────────────

test.describe('incident_smtp_intrusion — triage flow', () => {

  test('seeds the record summary, runs intel hops, blocks the C2 on approve', async ({ page }) => {
    const errors = await boot(page, 'incident_smtp_intrusion', {
      entity: SAMPLE_INCIDENT, extra: '&opener=1'
    });

    // Phase B: the first assistant message is the seeded record summary.
    await page.waitForFunction(
      () => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.messageCount > 0,
      null, { timeout: 5000 }
    );
    const messages = page.locator('[data-testid="messages"]');
    await expect(messages).toContainText('Triaging incident: SMTP intrusion on mail-relay-02');
    await expect(messages).toContainText('Severity: High');

    // Phase A: intent is triage (drawer mount) and payloads carry it + entity + mock mode.
    const probe = await page.evaluate(() => ({
      intent: window.__fsrPlaybookBuilder__.intent,
      entity: window.__fsrPlaybookBuilder__.entity,
      lastPayload: window.__fsrPlaybookBuilder__.lastPayload
    }));
    expect(probe.intent).toBe('triage');
    expect(probe.entity && probe.entity.iri).toBe(SAMPLE_INCIDENT['@id']);
    expect(probe.entity.module).toBe('incidents');
    expect(probe.lastPayload.intent).toBe('triage');
    expect(probe.lastPayload.mode).toBe('mock');
    expect(probe.lastPayload.entity.iri).toBe(SAMPLE_INCIDENT['@id']);
    // summary_seed is forwarded so the connector can use it verbatim.
    expect(probe.lastPayload.entity.summary_seed).toContain('Triaging incident');

    // Phase D: the opener turn surfaces the two intel hops as "Used skill X".
    await page.locator('[data-testid="action-card-card-block-c2"]').waitFor({ state: 'visible', timeout: 6000 });
    await expect(messages).toContainText('Used skill');
    await expect(messages).toContainText('search_assets');
    await expect(messages).toContainText('fortisiem.run_query');

    // Phase C: triage hides the YAML pane (none here, and intent is triage).
    await expect(page.locator('[data-testid="yaml-pane"]')).toHaveCount(0);

    // Phase E: required fields are filled → Confirm is enabled.
    const confirm = page.locator('[data-testid="action-confirm-card-block-c2"]');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await waitForState(page, 'idle');
    await expect(messages).toContainText('added to `soc-blocklist`');
    expect(errors).toEqual([]);
  });

  test('Phase E: clearing a required field disables Confirm', async ({ page }) => {
    await boot(page, 'incident_smtp_intrusion', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });
    await page.locator('[data-testid="action-card-card-block-c2"]').waitFor({ state: 'visible', timeout: 6000 });

    const confirm = page.locator('[data-testid="action-confirm-card-block-c2"]');
    await expect(confirm).toBeEnabled();

    // `ip` is a required field — clearing it must disable Confirm.
    const ipInput = page.locator('[data-testid="action-arg-card-block-c2-ip"]');
    await ipInput.fill('');
    await expect(confirm).toBeDisabled();
    await expect(page.locator('[data-testid="action-invalid-card-block-c2"]')).toBeVisible();

    // Refilling re-enables it.
    await ipInput.fill('185.220.101.47');
    await expect(confirm).toBeEnabled();
  });

  test('reject path logs the decision, no block applied', async ({ page }) => {
    await boot(page, 'incident_smtp_intrusion', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });
    await page.locator('[data-testid="action-card-card-block-c2"]').waitFor({ state: 'visible', timeout: 6000 });
    await page.locator('[data-testid="action-cancel-card-block-c2"]').click();
    await waitForState(page, 'idle');
    await expect(page.locator('[data-testid="messages"]')).toContainText('Cancelled');
  });
});

// ─── Phase C: triage hides the YAML pane, Build mode reveals it ─────────────

test.describe('Phase C — intent-aware layout', () => {

  test('triage hides YAML pane; "Build mode" flips intent and reveals it', async ({ page }) => {
    await boot(page, 'playbook_soc_demo', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });

    // Drawer mount → triage; the Build-mode button is present.
    expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.intent)).toBe('triage');
    const buildBtn = page.locator('[data-testid="switch-to-build"]');
    await expect(buildBtn).toBeVisible();

    // Walk to a point that produces YAML (playbook → hunt template fence).
    await page.locator('[data-testid="choice-intent-playbook"]').click();
    await page.locator('[data-testid="choice-hunt_kind-ioc_sweep"]').click();

    // YAML was extracted but the pane stays hidden in triage.
    await page.waitForFunction(() => window.__fsrPlaybookBuilder__.currentYaml.length > 0, null, { timeout: 6000 });
    await expect(page.locator('[data-testid="yaml-pane"]')).toHaveCount(0);

    // Flip to build mode → pane appears, button disappears.
    await buildBtn.click();
    await expect(page.locator('[data-testid="yaml-pane"]')).toBeVisible();
    await expect(buildBtn).toHaveCount(0);
    expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.intent)).toBe('build');
  });

  test('dashboard mount (no entity) defaults to build — no Build-mode button', async ({ page }) => {
    await boot(page, 'playbook_soc_demo', { extra: '&opener=1' });
    expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.intent)).toBe('build');
    await expect(page.locator('[data-testid="switch-to-build"]')).toHaveCount(0);
  });
});

// ─── Phase A: contract drift ────────────────────────────────────────────────

test.describe('Phase A — contract version drift', () => {

  test('major mismatch shows a banner but still renders (non-strict)', async ({ page }) => {
    await boot(page, 'contract_drift', { extra: '&opener=1' });
    const banner = page.locator('[data-testid="contract-banner"]');
    await expect(banner).toBeVisible({ timeout: 6000 });
    await expect(banner).toContainText('MAJOR mismatch');
    // Turn still completed and rendered.
    await waitForState(page, 'idle');
    await expect(page.locator('[data-testid="messages"]')).toContainText('Hello from a newer connector');
  });

  test('strict mode halts the turn in error state', async ({ page }) => {
    await boot(page, 'contract_drift', { extra: '&opener=1&contract=strict' });
    await waitForState(page, 'error', 6000);
    await expect(page.locator('[data-testid="error-banner"]')).toContainText('Contract check failed');
  });
});

// ─── Phase F: ?mode=mock forces mock even when config says real ─────────────

test.describe('Phase F — ?mode=mock override', () => {

  test('config Backend=real + ?mode=mock still replays the fixture', async ({ page }) => {
    // With config real and no connector, the gate would normally block chat.
    // ?mode=mock forces the mock path so the fixture drives the widget. The
    // scenario comes from config.mockScenario (no ?mock= in the URL) — exactly
    // the durable-config path real SOAR would use.
    const errors = await boot(page, null, {
      cfg: { mockMode: 'real', mockScenario: 'immediate_block_ip', connectorName: '', connectorVersion: '' },
      extra: '&opener=1&mode=mock'
    });
    await page.locator('[data-testid="choice-card-intent"]').waitFor({ state: 'visible', timeout: 6000 });
    const lastPayload = await page.evaluate(() => window.__fsrPlaybookBuilder__.lastPayload);
    expect(lastPayload.mode).toBe('mock');
    expect(errors).toEqual([]);
  });
});
