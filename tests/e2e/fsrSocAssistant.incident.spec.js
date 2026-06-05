'use strict';
// Covers the Phase A–E + c2_hunt work on the FortiSOC Action Assistant widget:
//   - Phase A: contract_version drift (banner + strict halt), mode/intent/entity
//              stamped into outgoing payloads
//   - Phase B: auto-seed a record summary as the assistant's first message
//   - Phase C: triage hides the YAML pane; "Build mode" reveals it
//   - Phase D: incident_smtp_intrusion fixture (intel hops → action_card → exec)
//   - Phase E: action_card Confirm gated on required fields
//   - c2_hunt: multi-pivot enrichment, consolidated IOC card, approve + reject
//
// All scenarios append &fastmock=1 so fixture delays collapse to ~30ms.
// Console errors + [object Object] bindings are caught automatically via _fixtures.

const { test, expect } = require('./_fixtures');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

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

const SAMPLE_ALERT_C2 = {
  '@id': '/api/3/alerts/d39ecc9a-2968-42d5-948d-ce96fd76b227',
  name: 'Outbound C2 traffic - smithDesktop',
  severity: { itemValue: 'Critical' },
  status: { itemValue: 'Open' },
  source: 'FortiSIEM',
  type: 'Exfiltration',
  description: 'smithDesktop (10.50.60.70 / wendy.smith) beaconing to 102.220.160.21 after 7ogger.exe drop. MITRE T1041.'
};

function urlFor(scenario, extra) {
  const mockParam = scenario ? `&mock=${scenario}` : '';
  return `/?widget=${WIDGET_ID}&context=Dashboard${mockParam}&fastmock=1${extra || ''}`;
}

async function boot(page, scenario, opts) {
  opts = opts || {};
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
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 15000 }
  );
}

async function waitForState(page, state, timeout = 10000) {
  await page.waitForFunction(
    (s) => window.__fsrSocAssistant__ && window.__fsrSocAssistant__.state === s,
    state, { timeout }
  );
}

// ─── Phase D + B + E: incident_smtp_intrusion ──────────────────────────────

test.describe('incident_smtp_intrusion — triage flow', () => {

  test('seeds the record summary, runs intel hops, blocks the C2 on approve', async ({ page }) => {
    await boot(page, 'incident_smtp_intrusion', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });

    // Phase B: the first assistant message is the seeded record summary.
    await page.waitForFunction(
      () => window.__fsrSocAssistant__ && window.__fsrSocAssistant__.messageCount > 0,
      null, { timeout: 5000 }
    );
    const messages = page.locator('[data-testid="messages"]');
    await expect(messages).toContainText('Triaging incident: SMTP intrusion on mail-relay-02');
    await expect(messages.locator('.status-sev-tag').first()).toContainText('High');
    await expect(messages).toContainText('Open');

    // Phase A: intent + entity + mode stamped into outgoing payload.
    const probe = await page.evaluate(() => ({
      intent: window.__fsrSocAssistant__.intent,
      entity: window.__fsrSocAssistant__.entity,
      lastPayload: window.__fsrSocAssistant__.lastPayload
    }));
    expect(probe.intent).toBe('triage');
    expect(probe.entity && probe.entity.iri).toBe(SAMPLE_INCIDENT['@id']);
    expect(probe.entity.module).toBe('incidents');
    expect(probe.lastPayload.intent).toBe('triage');
    expect(probe.lastPayload.mode).toBe('mock');
    expect(probe.lastPayload.entity.iri).toBe(SAMPLE_INCIDENT['@id']);
    expect(probe.lastPayload.entity.summary_seed).toContain('Triaging incident');

    // Phase D: opener surfaces intel hops as "Used skill X" then action_card.
    await page.locator('[data-testid="action-card-card-block-c2"]').waitFor({ state: 'visible', timeout: 6000 });
    await expect(messages).toContainText('Used skill');
    await expect(messages).toContainText('search_assets');
    await expect(messages).toContainText('fortisiem.run_query');

    // Phase C: triage hides the YAML pane.
    await expect(page.locator('[data-testid="yaml-pane"]')).toHaveCount(0);

    // Phase E: required fields filled → Confirm enabled.
    const confirm = page.locator('[data-testid="action-confirm-card-block-c2"]');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await waitForState(page, 'idle');
    await expect(messages).toContainText('added to soc-blocklist');
  });

  test('Phase E: clearing a required field disables Confirm', async ({ page }) => {
    await boot(page, 'incident_smtp_intrusion', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });
    await page.locator('[data-testid="action-card-card-block-c2"]').waitFor({ state: 'visible', timeout: 6000 });

    const confirm = page.locator('[data-testid="action-confirm-card-block-c2"]');
    await expect(confirm).toBeEnabled();

    const ipInput = page.locator('[data-testid="action-arg-card-block-c2-ip"]');
    await ipInput.fill('');
    await expect(confirm).toBeDisabled();
    await expect(page.locator('[data-testid="action-invalid-card-block-c2"]')).toBeVisible();

    await ipInput.fill('185.220.101.47');
    await expect(confirm).toBeEnabled();
  });

  test('reject path logs the decision, no block applied', async ({ page }) => {
    await boot(page, 'incident_smtp_intrusion', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });
    await page.locator('[data-testid="action-card-card-block-c2"]').waitFor({ state: 'visible', timeout: 6000 });
    await page.locator('[data-testid="action-cancel-card-block-c2"]').click();
    await waitForState(page, 'idle');
    // The resolved action card shows "Cancelled" in its resolution text.
    await expect(page.locator('[data-testid="messages"]')).toContainText('Cancelled');
  });
});

// ─── Phase C: triage hides the YAML pane, Build mode reveals it ─────────────

test.describe('Phase C — intent-aware layout', () => {

  test('triage hides YAML pane; "Build mode" flips intent and reveals it', async ({ page }) => {
    await boot(page, 'playbook_soc_demo', { entity: SAMPLE_INCIDENT, extra: '&opener=1' });

    expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('triage');
    const buildBtn = page.locator('[data-testid="switch-to-build"]');
    await expect(buildBtn).toBeVisible();

    const intentChoice = page.locator('[data-testid="choice-intent-playbook"]');
    await intentChoice.waitFor({ state: 'visible', timeout: 15000 });
    await intentChoice.click();
    const huntChoice = page.locator('[data-testid="choice-hunt_kind-ioc_sweep"]');
    await huntChoice.waitFor({ state: 'visible', timeout: 15000 });
    await huntChoice.click();

    await page.waitForFunction(() => window.__fsrSocAssistant__.currentYaml.length > 0, null, { timeout: 15000 });
    await expect(page.locator('[data-testid="yaml-pane"]')).toHaveCount(0);

    await buildBtn.click();
    await expect(page.locator('[data-testid="yaml-pane"]')).toBeVisible();
    await expect(buildBtn).toHaveCount(0);
    expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('build');
  });

  test('dashboard mount (no entity) defaults to build — no Build-mode button', async ({ page }) => {
    await boot(page, 'playbook_soc_demo', { extra: '&opener=1' });
    expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('build');
    await expect(page.locator('[data-testid="switch-to-build"]')).toHaveCount(0);
  });
});

// ─── Phase A: contract drift ─────────────────────────────────────────────────

test.describe('Phase A — contract version drift', () => {

  test('major mismatch shows a banner but still renders (non-strict)', async ({ page }) => {
    await boot(page, 'contract_drift', { extra: '&opener=1' });
    const banner = page.locator('[data-testid="contract-banner"]');
    await expect(banner).toBeVisible({ timeout: 6000 });
    await expect(banner).toContainText('MAJOR mismatch');
    await waitForState(page, 'idle');
    await expect(page.locator('[data-testid="messages"]')).toContainText('Hello from a newer connector');
  });

  test('strict mode halts the turn in error state', async ({ page }) => {
    await boot(page, 'contract_drift', { extra: '&opener=1&contract=strict' });
    await waitForState(page, 'error', 6000);
    await expect(page.locator('[data-testid="error-banner"]')).toContainText('Contract check failed');
  });
});

// ─── Phase F: ?mode=mock override ─────────────────────────────────────────────

test.describe('Phase F — ?mode=mock override', () => {

  test('config Backend=real + ?mode=mock still replays the fixture', async ({ page }) => {
    await boot(page, null, {
      cfg: { mockMode: 'real', mockScenario: 'immediate_block_ip', connectorName: '', connectorVersion: '' },
      extra: '&opener=1&mode=mock'
    });
    await page.locator('[data-testid="choice-card-intent"]').waitFor({ state: 'visible', timeout: 6000 });
    const lastPayload = await page.evaluate(() => window.__fsrSocAssistant__.lastPayload);
    expect(lastPayload.mode).toBe('mock');
  });
});

// ─── c2_hunt — multi-pivot enrichment triage ─────────────────────────────────

test.describe('c2_hunt — multi-pivot enrichment triage', () => {

  test('renders the pivots, the consolidated IOC card, then blocks the C2 on approve', async ({ page }) => {
    await boot(page, 'c2_hunt', { entity: SAMPLE_ALERT_C2, extra: '&opener=1' });
    const messages = page.locator('[data-testid="messages"]');

    await page.locator('[data-testid="action-card-card-block-c2"]')
      .waitFor({ state: 'visible', timeout: 10000 });

    // Multi-pivot tool calls rendered.
    await expect(messages).toContainText('Used skill');
    await expect(messages).toContainText('get_record');
    await expect(messages).toContainText('search_module_records');
    await expect(messages).toContainText('run_op');

    // Consolidated IOC enrichment card with score, tags, and per-source table.
    const iocCard = page.locator('[data-testid="info-card-ioc-102-220-160-21"]');
    await expect(iocCard).toBeVisible();
    await expect(iocCard.locator('.status-score')).toBeVisible();
    await expect(iocCard.locator('.status-tag').first()).toBeVisible();
    const iocTable = iocCard.locator('.status-table');
    await expect(iocTable).toBeVisible();
    await expect(iocTable).toContainText('VirusTotal');
    await expect(iocTable).toContainText('FortiGuard');
    await expect(iocTable).toContainText('Shodan');
    await expect(iocTable).toContainText('IP Quality Score');

    // Approve the FortiGate block.
    const confirm = page.locator('[data-testid="action-confirm-card-block-c2"]');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await waitForState(page, 'idle');
    await expect(messages).toContainText('added to soc-blocklist');
    await expect(messages).toContainText('FW-OBJ-9024');
  });

  test('reject path: action card shows Cancelled, no block applied', async ({ page }) => {
    await boot(page, 'c2_hunt', { entity: SAMPLE_ALERT_C2, extra: '&opener=1' });

    await page.locator('[data-testid="action-card-card-block-c2"]')
      .waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('[data-testid="action-cancel-card-block-c2"]').click();
    await waitForState(page, 'idle');

    // The resolved action card's resolution text reads "Cancelled <summary>".
    await expect(page.locator('[data-testid="messages"]')).toContainText('Cancelled');
  });
});
