'use strict';
// LIVE end-to-end UI proof (gated, MUTATING) — "ask to build → created a real
// playbook through the UI only".
//
// Unlike every other e2e here this does NOT stub the connector: it runs the
// widget in mode=live against the real fsr-playbook-builder connector on the box
// in .env (FSR_BASE_URL), drives the agent to author YAML, clicks the UI's
// "Create Playbook" button (a real compile_yaml → push_playbook mutation), then
// independently verifies the workflow exists on the box via the SOAR API and
// DELETES it (cleanup in finally). This exercises the exact detached
// streaming/poll path that was hanging.
//
// Gated on FSRPB_LIVE_UI=1 (real agent run + real SOAR mutation). Run:
//   FSRPB_LIVE_UI=1 make test-e2e-spec SPEC="tests/e2e/fsrSocAssistant.createPlaybookLive.spec.js"
// Needs FSR_BASE_URL/FSR_USERNAME/FSR_PASSWORD in the harness .env.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');
const { makeClient } = require('../live/lib/soarClient');

const LIVE = process.env.FSRPB_LIVE_UI === '1';
const d = LIVE ? test.describe : test.describe.skip;

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { if (LIVE) WIDGET_ID = await resolveWidgetId(request); });

const BUILD_PROMPT =
  'Build a simple playbook that blocks a malicious IP address using FortiGate. '
  + 'One block-IP action is enough. Produce the playbook YAML.';

async function probe(page, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const p = window.__fsrSocAssistant__;
      return p ? { state: p.state, yamlLen: (p.currentYaml || '').length, push: p.pushResult || null } : null;
    });
    if (last && pred(last)) return last;
    await page.waitForTimeout(2000);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

d('live UI — create a playbook end-to-end (mutating, auto-cleanup)', () => {
  // The real agent build can take minutes; the push is a real round-trip.
  test.setTimeout(420000);

  test('ask to build → Create Playbook → workflow exists on the box', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('harness:config:' + id, JSON.stringify({
        connectorName: 'fsr-playbook-builder', defaultIntent: 'build',
        maxTurns: 12, showUsage: true, seedFromEntity: false, mockMode: 'real',
        detachedTimeoutMs: 480000
      }));
      localStorage.setItem('harness.widget', id);
      localStorage.setItem('harness.ctx', 'dashboard');
      localStorage.removeItem('fsrPbSession');
    }, WIDGET_ID);

    await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
      null, { timeout: 40000 });
    // Composer enabled ⇒ the connector resolved against the live box.
    await expect(page.locator('[data-testid="chat-input"]')).toBeEnabled({ timeout: 40000 });

    // Ask the agent to build (detached live turn — the path that was hanging).
    await page.locator('[data-testid="chat-input"]').fill(BUILD_PROMPT);
    await page.locator('[data-testid="chat-send"]').click();

    // The turn must complete (no hang) and leave authored YAML on the pane.
    const withYaml = await probe(page,
      s => s.state === 'idle' && s.yamlLen > 0, 300000, 'authored YAML + idle');
    expect(withYaml.yamlLen).toBeGreaterThan(0);

    // Click the UI's "Create Playbook" — real compile_yaml → push_playbook.
    const createBtn = page.locator('[data-testid="yaml-push"]');
    await expect(createBtn).toBeVisible({ timeout: 15000 });
    await createBtn.click();

    const pushed = await probe(page, s => !!s.push, 120000, 'push result');
    const res = pushed.push;
    console.log('[live-ui] PUSH RESULT:', JSON.stringify(res));
    expect(res).toBeTruthy();
    expect(res.ok).not.toBe(false);

    // The widget rendered the success handoff.
    await expect(page.locator('.fsr-pb-widget')).toContainText('Created playbook in FortiSOAR');

    // ── Independent verification on the box + cleanup ──────────────────────
    const wfUuid = (res.workflow_uuids && res.workflow_uuids[0])
      || (res.workflows && res.workflows[0] && res.workflows[0].uuid) || null;
    const collUuid = res.collection_uuid
      || (res.collection_iri ? String(res.collection_iri).split('/').pop() : null);

    const soar = await makeClient();
    let verified = false;
    try {
      // soar.get() returns the record JSON directly (or null on a non-2xx body).
      if (wfUuid) {
        const rec = await soar.get(`/api/3/workflows/${wfUuid}`);
        console.log(`[live-ui] GET workflows/${wfUuid} -> uuid=${rec && rec.uuid} name="${rec && rec.name}"`);
        verified = !!(rec && (rec.uuid === wfUuid || rec['@id']));
      } else if (collUuid) {
        const rec = await soar.get(`/api/3/workflow_collections/${collUuid}`);
        console.log(`[live-ui] GET workflow_collections/${collUuid} -> uuid=${rec && rec.uuid}`);
        verified = !!(rec && (rec.uuid === collUuid || rec['@id']));
      }
      expect(verified).toBe(true);
    } finally {
      // Always clean up so the demo box stays tidy, even if an assert failed.
      try {
        if (collUuid) {
          const dd = await soar.del(`/api/3/workflow_collections/${collUuid}`);
          console.log(`[live-ui] cleanup DELETE workflow_collections/${collUuid} -> ${dd.status}`);
        } else if (wfUuid) {
          const dd = await soar.del(`/api/3/workflows/${wfUuid}`);
          console.log(`[live-ui] cleanup DELETE workflows/${wfUuid} -> ${dd.status}`);
        } else {
          console.warn('[live-ui] no uuid in push result — CHECK BOX MANUALLY:', JSON.stringify(res));
        }
      } catch (e) {
        console.warn('[live-ui] cleanup failed — remove manually:', e.message);
      }
    }
  });
});
