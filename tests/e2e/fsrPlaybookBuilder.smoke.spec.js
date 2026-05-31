'use strict';
const { test, expect } = require('@playwright/test');

const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

// Resolved at runtime so the suite survives widget version bumps.
let WIDGET_ID = DEFAULT_ID;
let WIDGET_URL = `/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`;
test.beforeAll(async ({ request }) => {
  WIDGET_ID = await resolveWidgetId(request);
  WIDGET_URL = `/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`;
});

function urlFor(scenario) {
  return `/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario}`;
}

async function gotoWidget(page, scenario) {
  const url = scenario ? urlFor(scenario) : WIDGET_URL;
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  // Pre-seed widget config + harness UI prefs so the harness doesn't block on
  // the "Configure this widget to preview it" prompt.
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'build',
      maxTurns: 10,
      showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Wait for the widget's controller to boot and the test probe to attach.
  await page.waitForFunction(
    () => window.__fsrPlaybookBuilder__ &&
          typeof window.__fsrPlaybookBuilder__.state === 'string',
    null,
    { timeout: 15000 }
  );
  return errors;
}

async function waitForState(page, state, timeout = 5000) {
  await page.waitForFunction(
    (s) => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === s,
    state,
    { timeout }
  );
}

// The "Create Playbook" button (yaml-push) no longer validates/compiles via the
// mock track. pushPlaybook() in the agent service ALWAYS dispatches to the LIVE
// connector — compile_yaml(yaml) → workflow_json → push_playbook(workflow_json)
// — because creating a playbook is a real SOAR mutation even when the chat track
// is mocked. In the fully-mocked e2e harness there is no live connector, so we
// intercept the two integration endpoints it hits and serve deterministic
// envelopes. Routes are installed BEFORE goto so they cover the first call.
async function installLiveConnectorRoutes(page, opts) {
  opts = opts || {};
  const compile = opts.compile || {
    ok: true,
    workflow_json: { name: 'Ping Host And Alert', uuid: 'mock-uuid-0001', steps: [] }
  };
  const push = opts.push || {
    ok: true,
    workflow_iri: '/api/3/workflows/mock-uuid-0001',
    collection_uuid: 'coll-0001',
    raw: { name: 'Ping Host And Alert' }
  };

  // Connector lookup: /api/integration/connectors/?search=playbook
  await page.route(/\/api\/integration\/connectors\//, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{
        name: 'fsr-playbook-builder',
        version: '1.0.0',
        configuration: [{ name: 'fsrpb-live', config_id: 'cfg-0001', default: true }]
      }] })
    })
  );

  // Action dispatch: POST /api/integration/execute/?format=json — the connector
  // envelope is { status:'Success', data:<payload> }; the agent service unwraps
  // resp.data when resp.status is a string.
  await page.route(/\/api\/integration\/execute\//, route => {
    let op = '';
    try { op = (JSON.parse(route.request().postData() || '{}').operation) || ''; } catch (e) { /* noop */ }
    const data = op === 'compile_yaml' ? compile
               : op === 'push_playbook' ? push
               : { ok: true };
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'Success', operation: op, data })
    });
  });
}

test.describe('FSR Playbook Builder — happy path', () => {

  test('widget loads, probe exposed, initial state is idle', async ({ page }) => {
    const errors = await gotoWidget(page);
    const probe = await page.evaluate(() => ({
      hasProbe: typeof window.__fsrPlaybookBuilder__ === 'object',
      state: window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state,
      msgs:  window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.messageCount,
      yaml:  window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.currentYaml
    }));
    expect(probe.hasProbe).toBe(true);
    expect(probe.state).toBe('idle');
    expect(probe.msgs).toBe(0);
    expect(probe.yaml).toBe('');
    expect(errors).toEqual([]);
  });

  test('Send button: types message, fires chat_turn, renders assistant response and YAML', async ({ page }) => {
    const logs = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    const errors = await gotoWidget(page);

    const input = page.locator('[data-testid="chat-input"]');
    const send  = page.locator('[data-testid="chat-send"]');

    await expect(input).toBeVisible();
    await expect(send).toBeVisible();
    await expect(send).toBeDisabled();

    await input.fill('Build me a ping-and-alert playbook');
    await expect(send).toBeEnabled();

    // Capture state right before click.
    const before = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="chat-send"]');
      const ta  = document.querySelector('[data-testid="chat-input"]');
      const scope = window.angular && window.angular.element(btn).scope();
      return {
        state: window.__fsrPlaybookBuilder__.state,
        events: window.__fsrPlaybookBuilder__.events.length,
        btnDisabled: btn ? btn.disabled : 'no button',
        btnOuter: btn ? btn.outerHTML.slice(0,200) : null,
        taValue: ta ? ta.value : null,
        scopeInputText: scope ? scope.inputText : 'no scope',
        scopeViewState: scope ? scope.viewState : null,
        hasSendMessage: scope ? typeof scope.sendMessage : null
      };
    });

    await send.click();

    // First, wait for the click to actually transition state out of idle.
    await page.waitForFunction(
      () => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state !== 'idle',
      null, { timeout: 3000 }
    ).catch(() => { /* fall through to dump */ });

    // Then wait for it to land back at idle (turn complete).
    await waitForState(page, 'idle', 5000).catch(() => {});

    const after = await page.evaluate(() => ({
      state: window.__fsrPlaybookBuilder__.state,
      msgs: window.__fsrPlaybookBuilder__.messageCount,
      yaml: window.__fsrPlaybookBuilder__.currentYaml,
      events: window.__fsrPlaybookBuilder__.events.slice()
    }));

    if (after.msgs !== 2) {
      console.log('BEFORE:', JSON.stringify(before));
      console.log('AFTER :', JSON.stringify(after, null, 2));
      console.log('CONSOLE:\n' + logs.slice(-30).join('\n'));
    }

    expect(after.msgs).toBe(2);
    // YAML is extracted from the assistant's fenced ```yaml block (happy_path fixture).
    expect(after.yaml).toContain('FSRPB Create Alert');
    const actionCalls = after.events.filter(e => e.type === 'action_call');
    expect(actionCalls.some(e => e.payload.action === 'chat_turn')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('Create Playbook: compiles then pushes via the live connector, pushResult populated', async ({ page }) => {
    // Create runs compile_yaml → push_playbook against the live connector; serve both.
    await installLiveConnectorRoutes(page);
    await gotoWidget(page);

    await page.locator('[data-testid="chat-input"]').fill('Draft a ping playbook');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'idle');

    await page.locator('[data-testid="yaml-push"]').click();
    await waitForState(page, 'idle');

    const pushResult = await page.evaluate(() => window.__fsrPlaybookBuilder__.pushResult);
    expect(pushResult).not.toBeNull();
    expect(pushResult.ok).toBe(true);
    expect(pushResult.workflow_iri).toBe('/api/3/workflows/mock-uuid-0001');
  });
});

test.describe('FSR Playbook Builder — error & branch scenarios', () => {

  test('Create with a broken playbook surfaces compile/validation errors and lands in error state', async ({ page }) => {
    // Validation now happens server-side as the first step of Create; a failing
    // compile_yaml aborts the push chain and surfaces the errors inline.
    await installLiveConnectorRoutes(page, {
      compile: { ok: false, errors: ['missing required field: connector'] }
    });
    await gotoWidget(page, 'validate_errors');
    await page.locator('[data-testid="chat-input"]').fill('Draft a broken playbook');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'idle');

    await page.locator('[data-testid="yaml-push"]').click();
    await waitForState(page, 'error', 5000);

    const events = await page.evaluate(() => window.__fsrPlaybookBuilder__.events.slice());
    expect(events.some(e => e.type === 'action_call' && e.payload.action === 'push_playbook')).toBe(true);
    const bodyText = await page.locator('[data-testid="fsr-pb-root"]').innerText();
    expect(bodyText).toMatch(/missing required field: connector/);
  });

  test('push_failure surfaces inline error, pushResult.ok is false', async ({ page }) => {
    // compile succeeds, push_playbook reports ok:false → handled gracefully (idle).
    await installLiveConnectorRoutes(page, {
      push: { ok: false, error: 'Playbook "Ping" already exists' }
    });
    await gotoWidget(page, 'push_failure');
    await page.locator('[data-testid="chat-input"]').fill('Push it');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'idle');

    await page.locator('[data-testid="yaml-push"]').click();
    await waitForState(page, 'idle');

    const pushResult = await page.evaluate(() => window.__fsrPlaybookBuilder__.pushResult);
    expect(pushResult).not.toBeNull();
    expect(pushResult.ok).toBe(false);
    const bodyText = await page.locator('[data-testid="fsr-pb-root"]').innerText();
    expect(bodyText).toMatch(/already exists/i);
  });

  test('connector_error rejects chat_turn and lands in error state with banner', async ({ page }) => {
    await gotoWidget(page, 'connector_error');
    await page.locator('[data-testid="chat-input"]').fill('Hello');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'error', 5000);

    const banner = page.locator('[data-testid="error-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/not configured/i);
  });

  test('approval_required pauses on approval modal, approve completes turn', async ({ page }) => {
    await gotoWidget(page, 'approval_required');
    await page.locator('[data-testid="chat-input"]').fill('Run something dangerous');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'awaiting_approval', 5000);

    const modal = page.locator('[data-testid="approval-modal"]');
    await expect(modal).toBeVisible();
    await page.locator('[data-testid="approval-approve"]').click();
    await waitForState(page, 'idle', 5000);
  });

  test('approval_rejected: reject button returns to idle without resuming forever', async ({ page }) => {
    await gotoWidget(page, 'approval_rejected');
    await page.locator('[data-testid="chat-input"]').fill('Try the risky thing');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'awaiting_approval', 5000);

    await page.locator('[data-testid="approval-reject"]').click();
    await waitForState(page, 'idle', 5000);
  });

  test('compile_failure surfaces inline compile errors during Create', async ({ page }) => {
    // Create's first step is compile_yaml; a compile error aborts the push and
    // surfaces inline, leaving the widget in the error state.
    await installLiveConnectorRoutes(page, {
      compile: { ok: false, errors: ['unterminated Jinja expression'] }
    });
    await gotoWidget(page, 'compile_failure');
    await page.locator('[data-testid="chat-input"]').fill('Draft something that will not compile');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'idle');

    await page.locator('[data-testid="yaml-push"]').click();
    await waitForState(page, 'error', 5000);

    const events = await page.evaluate(() => window.__fsrPlaybookBuilder__.events.slice());
    expect(events.some(e => e.type === 'action_call' && e.payload.action === 'push_playbook')).toBe(true);
    const bodyText = await page.locator('[data-testid="fsr-pb-root"]').innerText();
    expect(bodyText).toMatch(/unterminated Jinja expression/);
  });

  test('max_turns: turn ends with stop_reason max_turns, widget returns to idle', async ({ page }) => {
    await gotoWidget(page, 'max_turns');
    await page.locator('[data-testid="chat-input"]').fill('Explore connectors');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'idle', 8000);

    const events = await page.evaluate(() => window.__fsrPlaybookBuilder__.events.slice());
    const turnCalls = events.filter(e => e.type === 'action_call' && e.payload.action === 'chat_turn');
    // Exactly one chat_turn — the loop must not retry past max_turns.
    expect(turnCalls.length).toBe(1);
    const bodyText = await page.locator('[data-testid="fsr-pb-root"]').innerText();
    expect(bodyText).toMatch(/turn limit/i);
  });

  test('Stop button: clicking Stop mid-turn returns to idle and discards the late result', async ({ page }) => {
    await gotoWidget(page, 'slow_turn');
    await page.locator('[data-testid="chat-input"]').fill('A slow request');
    await page.locator('[data-testid="chat-send"]').click();
    await waitForState(page, 'sending', 2000);

    const stop = page.locator('[data-testid="chat-stop"]');
    await expect(stop).toBeVisible();
    await stop.click();
    await waitForState(page, 'idle', 1000);

    // Wait for the widget to record that the late result was discarded — this
    // fires once the fixture delay (2000ms) elapses and the result is dropped.
    await page.waitForFunction(
      () => (window.__fsrPlaybookBuilder__.events || []).some(e => e.type === 'turn_result_discarded'),
      null, { timeout: 5000 }
    );
    const final = await page.evaluate(() => ({
      state: window.__fsrPlaybookBuilder__.state,
      msgs: window.__fsrPlaybookBuilder__.messageCount,
      events: window.__fsrPlaybookBuilder__.events.slice()
    }));
    expect(final.state).toBe('idle');
    // user message + system "Stop requested..." message; assistant should NOT have been appended.
    expect(final.msgs).toBe(2);
    expect(final.events.some(e => e.type === 'stop_requested')).toBe(true);
    expect(final.events.some(e => e.type === 'turn_result_discarded')).toBe(true);
  });

  // Contract 2.2.0: chat_resume(approve) of an action_card can come back with
  // stop_reason 'approval_unverified' — the suspended action failed the
  // connector's HMAC binding check and was NOT executed. The widget must clear
  // the pending card, surface the message, and prompt a re-issue.
  test('approval_unverified: resume fails binding check, action flagged not-executed', async ({ page }) => {
    await gotoWidget(page, 'approval_unverified');
    await page.locator('[data-testid="chat-input"]').fill('Block 1.2.3.4 at the edge');
    await page.locator('[data-testid="chat-send"]').click();

    // The chat_turn yields an action_card — confirm it to drive the resume.
    const confirm = page.locator('[data-testid="action-confirm-card-block-ip-1"]');
    await expect(confirm).toBeVisible({ timeout: 8000 });
    await confirm.click();

    // The resume returns approval_unverified → widget goes to 'error'.
    await waitForState(page, 'error', 8000);

    const banner = page.locator('[data-testid="error-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/not executed/i);

    // The previously-approved action card no longer reads as a success.
    const bodyText = await page.locator('[data-testid="fsr-pb-root"]').innerText();
    expect(bodyText).toMatch(/unverified/i);

    // Probe: a structured approval_unverified event was logged.
    const events = await page.evaluate(() => window.__fsrPlaybookBuilder__.events.slice());
    expect(events.some(e => e.type === 'approval_unverified')).toBe(true);
  });

  test('history_rehydrate populates prior turns on load', async ({ page }) => {
    await gotoWidget(page, 'history_rehydrate');
    // Give the optional chat_history call time to land and render.
    await page.waitForFunction(
      () => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.messageCount > 0,
      null, { timeout: 5000 }
    );
    const msgs = await page.evaluate(() => window.__fsrPlaybookBuilder__.messageCount);
    expect(msgs).toBeGreaterThan(0);
  });
});
