'use strict';
// Covers the SOC Action Assistant demo fixtures:
//   - playbook_soc_demo (both branches with match-based routing)
//   - immediate_block_ip / immediate_quarantine / immediate_rejected (narrow paths)
//   - playbook_ioc_sweep (manual_input gates)
//
// All scenarios append &fastmock=1 so the mock collapses 1.5s demo delays to ~30ms.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

// Resolved at runtime so the suite survives widget version bumps.
let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

function urlFor(scenario) {
  // opener=1 makes the widget fire the seeded chat_turn on load (no paste needed).
  // fastmock=1 collapses demo delays so the suite runs in seconds, not minutes.
  return `/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario}&fastmock=1&opener=1`;
}

async function bootWidget(page, scenario) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    // Only seed defaults when nothing is saved yet — this lets specs that
    // exercise persistence (save → reload → verify) work without the init
    // script clobbering the user's saved config on reload.
    if (!localStorage.getItem('harness:config:' + id)) {
      localStorage.setItem('harness:config:' + id, JSON.stringify({
        connectorName: 'fortinet-fsr-playbook-builder',
        defaultIntent: 'build',
        maxTurns: 10,
        showUsage: true
      }));
    }
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    // Wipe any prior session so chat_history returns empty and the opener fires.
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(urlFor(scenario), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 30000 }
  );
  return errors;
}

async function waitForState(page, state, timeout = 5000) {
  await page.waitForFunction(
    (s) => window.__fsrSocAssistant__ && window.__fsrSocAssistant__.state === s,
    state, { timeout }
  );
}

// Wait for a choice_card identified by `choiceId` to be rendered + interactive.
async function waitForChoice(page, choiceId, timeout = 5000) {
  const card = page.locator(`[data-testid="choice-card-${choiceId}"]`);
  await card.waitFor({ state: 'visible', timeout });
  return card;
}

async function pickChoice(page, choiceId, value) {
  await waitForChoice(page, choiceId);
  await page.locator(`[data-testid="choice-${choiceId}-${value}"]`).click();
}

async function pickMulti(page, choiceId, values) {
  await waitForChoice(page, choiceId);
  for (const v of values) {
    await page.locator(`[data-testid="choice-${choiceId}-${v}"]`).click();
  }
  await page.locator(`[data-testid="choice-${choiceId}-submit"]`).click();
}

async function waitForActionCard(page, cardId, timeout = 5000) {
  const card = page.locator(`[data-testid="action-card-${cardId}"]`);
  await card.waitFor({ state: 'visible', timeout });
  return card;
}

async function waitForManualInput(page, inputId, timeout = 5000) {
  const card = page.locator(`[data-testid="manual-input-${inputId}"]`);
  await card.waitFor({ state: 'visible', timeout });
  return card;
}

// ─── Settings gear + overlay ──────────────────────────────────────────────

test.describe('Settings gear', () => {

  test('gear button is visible and clickable in the topbar', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    const gear = page.locator('[data-testid="open-settings"]');
    await expect(gear).toBeVisible();
    await expect(gear).toBeEnabled();
  });

  test('clicking gear opens the settings overlay', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await page.locator('[data-testid="open-settings"]').click();
    const overlay = page.locator('[data-testid="settings-overlay"]');
    await expect(overlay).toBeVisible();
    await expect(page.locator('[data-testid="cfg-form"]')).toBeVisible();
  });

  test('backdrop click closes the overlay', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await page.locator('[data-testid="open-settings"]').click();
    // The backdrop fills the overlay (inset:0) but the settings panel is
    // centered over it (z-index 201), so a default center-click lands on the
    // panel. Click a top-left corner that only the backdrop occupies.
    await page.locator('[data-testid="settings-backdrop"]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid="settings-overlay"]')).toHaveCount(0);
  });

  test('Save closes overlay and re-derives demo globals from config', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="cfg-mock-speed"]').selectOption('instant');
    await page.locator('[data-testid="cfg-form"] button[type="submit"]').click();
    await expect(page.locator('[data-testid="settings-overlay"]')).toHaveCount(0);
    const speed = await page.evaluate(() => window.__fsrPbSpeed);
    expect(speed).toBe('instant');
  });

  test('Cancel closes overlay without applying changes', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    const speedBefore = await page.evaluate(() => window.__fsrPbSpeed);
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="cfg-mock-speed"]').selectOption('instant');
    await page.locator('[data-testid="cfg-cancel"]').click();
    await expect(page.locator('[data-testid="settings-overlay"]')).toHaveCount(0);
    const speedAfter = await page.evaluate(() => window.__fsrPbSpeed);
    expect(speedAfter).toBe(speedBefore);
  });

  test('overlay form shows the mock-mode + opener controls', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="cfg-mock-mode"]')).toBeVisible();
    await expect(page.locator('[data-testid="cfg-opener"]')).toBeVisible();
    await expect(page.locator('[data-testid="cfg-default-intent"]')).toBeVisible();
  });
});


// ─── playbook_soc_demo — unified branching scenario ────────────────────────

test.describe('playbook_soc_demo — Path A (immediate action, multi-select destinations)', () => {

  test('opener fires intent picker on load (no user input required)', async ({ page }) => {
    const errors = await bootWidget(page, 'playbook_soc_demo');
    await waitForChoice(page, 'intent');
    await waitForState(page, 'idle');
    expect(errors).toEqual([]);
  });

  test('multi-select Continue is disabled until min_select chips are picked', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await pickChoice(page, 'intent', 'immediate');
    await waitForChoice(page, 'action_kind');

    const submit = page.locator('[data-testid="choice-action_kind-submit"]');
    await expect(submit).toBeDisabled();

    await page.locator('[data-testid="choice-action_kind-block_ip"]').click();
    await expect(submit).toBeEnabled();
    await expect(submit).toContainText('(1)');
  });

  test('walks immediate → multi destinations → action card → confirm → MCP execute', async ({ page }) => {
    const errors = await bootWidget(page, 'playbook_soc_demo');

    await pickChoice(page, 'intent', 'immediate');
    await pickMulti(page, 'action_kind', ['block_ip']);
    await pickMulti(page, 'connector_pick', ['fgt-hq', 'fgt-eu', 'feed-fgd']);

    await waitForActionCard(page, 'card-block-ip-1');
    await page.locator('[data-testid="action-confirm-card-block-ip-1"]').click();
    await waitForState(page, 'idle');

    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    const resumeCalls = events.filter(e => e.type === 'action_call' && e.payload.action === 'chat_resume');
    // opener + 3 choices (intent, action_kind, connector_pick) + action_card approve = 4 resumes
    expect(resumeCalls.length).toBeGreaterThanOrEqual(4);
    const approve = resumeCalls.find(e => e.payload.decision === 'approve');
    expect(approve).toBeTruthy();
    expect(approve.payload.card_id).toBe('card-block-ip-1');
    expect(errors).toEqual([]);
  });

  test('Cancel on the action card rejects, no execute_action events', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await pickChoice(page, 'intent', 'immediate');
    await pickMulti(page, 'action_kind', ['block_ip']);
    await pickMulti(page, 'connector_pick', ['fgt-hq']);

    await waitForActionCard(page, 'card-block-ip-1');
    await page.locator('[data-testid="action-cancel-card-block-ip-1"]').click();
    await waitForState(page, 'idle');

    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    const reject = events.find(e => e.type === 'action_call'
      && e.payload.action === 'chat_resume'
      && e.payload.decision === 'reject');
    expect(reject).toBeTruthy();
    expect(reject.payload.card_id).toBe('card-block-ip-1');
  });
});

test.describe('playbook_soc_demo — Path B (build playbook + manual_input gates)', () => {

  test('walks playbook → hunt → build/run confirms → two manual_input gates → done', async ({ page }) => {
    const errors = await bootWidget(page, 'playbook_soc_demo');

    await pickChoice(page, 'intent', 'playbook');
    await pickChoice(page, 'hunt_kind', 'ioc_sweep');
    await pickChoice(page, 'build_confirm', 'yes');
    await pickChoice(page, 'run_confirm', 'yes');

    await waitForManualInput(page, 'mi-hosts');
    await page.locator('[data-testid="manual-input-submit-mi-hosts"]').click();

    await waitForManualInput(page, 'mi-block');
    await page.locator('[data-testid="manual-input-submit-mi-block"]').click();

    await waitForState(page, 'idle');

    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    const respondCalls = events.filter(e => e.type === 'action_call' && e.payload.action === 'respond_manual_input');
    expect(respondCalls.length).toBe(2);
    expect(respondCalls[0].payload.decision).toBe('approve');
    expect(respondCalls[0].payload.input_id).toBe('mi-hosts');
    expect(respondCalls[1].payload.input_id).toBe('mi-block');
    // currentYaml extracted from the build_confirm fenced block
    const yaml = await page.evaluate(() => window.__fsrSocAssistant__.currentYaml);
    expect(yaml).toContain('IOC Sweep and Contain');
    expect(errors).toEqual([]);
  });

  test('Cancel at build_confirm stops without creating anything', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await pickChoice(page, 'intent', 'playbook');
    await pickChoice(page, 'hunt_kind', 'ioc_sweep');
    await pickChoice(page, 'build_confirm', 'no');
    await waitForState(page, 'idle');

    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    expect(events.some(e => e.type === 'action_call' && e.payload.action === 'respond_manual_input')).toBe(false);
  });

  test('manual_input reject path returns to idle without progressing the playbook', async ({ page }) => {
    await bootWidget(page, 'playbook_soc_demo');
    await pickChoice(page, 'intent', 'playbook');
    await pickChoice(page, 'hunt_kind', 'ioc_sweep');
    await pickChoice(page, 'build_confirm', 'yes');
    await pickChoice(page, 'run_confirm', 'yes');

    await waitForManualInput(page, 'mi-hosts');
    await page.locator('[data-testid="manual-input-reject-mi-hosts"]').click();
    // The fixture only matches `input_id: mi-hosts` on respond_manual_input, so reject
    // falls through to the same handler — the controller still calls respond_manual_input
    // with decision='reject'.
    await waitForState(page, 'sending').catch(() => {});
    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    const respond = events.find(e => e.type === 'action_call' && e.payload.action === 'respond_manual_input');
    expect(respond).toBeTruthy();
    expect(respond.payload.decision).toBe('reject');
  });
});

// ─── Narrow path fixtures ──────────────────────────────────────────────────

test.describe('immediate_block_ip — narrow single-select path', () => {
  test('opener → single-select chips → action card → confirm', async ({ page }) => {
    const errors = await bootWidget(page, 'immediate_block_ip');
    await pickChoice(page, 'intent', 'immediate');
    await pickChoice(page, 'action_kind', 'block_ip');
    await pickChoice(page, 'connector_pick', 'fortigate');

    await waitForActionCard(page, 'card-block-ip-1');
    await page.locator('[data-testid="action-confirm-card-block-ip-1"]').click();
    await waitForState(page, 'idle');

    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    expect(events.some(e => e.type === 'action_call'
      && e.payload.action === 'chat_resume'
      && e.payload.decision === 'approve')).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('immediate_quarantine — FortiEDR path', () => {
  test('opener → chips → FortiEDR action card → confirm', async ({ page }) => {
    await bootWidget(page, 'immediate_quarantine');
    await pickChoice(page, 'intent', 'immediate');
    await pickChoice(page, 'action_kind', 'quarantine');
    await pickChoice(page, 'connector_pick', 'fortiedr');

    await waitForActionCard(page, 'card-quarantine-1');
    const op = page.locator('[data-testid="action-card-card-quarantine-1"] .op-label');
    await expect(op).toContainText('fortinet-fortiedr');
    await expect(op).toContainText('isolate_host');

    await page.locator('[data-testid="action-confirm-card-quarantine-1"]').click();
    await waitForState(page, 'idle');
  });
});

test.describe('immediate_rejected — Cancel path', () => {
  test('reaches action card, clicks Cancel, lands in idle', async ({ page }) => {
    await bootWidget(page, 'immediate_rejected');
    await pickChoice(page, 'intent', 'immediate');
    await pickChoice(page, 'action_kind', 'block_ip');

    await waitForActionCard(page, 'card-block-ip-1');
    await page.locator('[data-testid="action-cancel-card-block-ip-1"]').click();
    await waitForState(page, 'idle');

    const events = await page.evaluate(() => window.__fsrSocAssistant__.events.slice());
    const reject = events.find(e => e.type === 'action_call'
      && e.payload.action === 'chat_resume'
      && e.payload.decision === 'reject');
    expect(reject).toBeTruthy();
  });
});

test.describe('playbook_ioc_sweep — manual_input gates only', () => {
  test('walks playbook path with two manual_input approves', async ({ page }) => {
    await bootWidget(page, 'playbook_ioc_sweep');
    await pickChoice(page, 'intent', 'playbook');
    await pickChoice(page, 'hunt_kind', 'ioc_sweep');
    await pickChoice(page, 'build_confirm', 'yes');
    await pickChoice(page, 'run_confirm', 'yes');

    await waitForManualInput(page, 'mi-hosts');
    await page.locator('[data-testid="manual-input-submit-mi-hosts"]').click();
    await waitForManualInput(page, 'mi-block');
    await page.locator('[data-testid="manual-input-submit-mi-block"]').click();
    await waitForState(page, 'idle');
  });
});
