'use strict';
// Refresh durability — build-state reconstruction (export sess-rur4yvdd).
//   After a page refresh the timeline is rebuilt from the connector transcript,
//   but the build-vs-triage UI state is not on the wire. A session that already
//   authored a playbook must come back in BUILD mode — YAML pane + toggle
//   visible — instead of a bare triage view that re-offers "Build playbook" for
//   work already done. This drives the rehydrate path with a canned transcript
//   and asserts the DOM outcome.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  await page.addInitScript((id) => {
    // No defaultIntent:'build' — so the widget boots in TRIAGE, the state a
    // record-mounted drawer returns to after a refresh. The flip to build must
    // come from the replayed transcript, not the config.
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 25000 }
  );
}

test.describe('refresh rehydrate — build-state reconstruction', () => {
  test('a transcript with authored YAML returns in build mode with the YAML toggle', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await boot(page);

    // Starts in triage (no build config).
    expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('triage');

    // Replay a session that authored YAML in one turn and confirmed the save in
    // a later, fence-less turn (the case the old last-transcript-only scan missed).
    await page.evaluate(() => {
      const yaml = 'workflows:\n  - name: Blast Radius\n    steps: []';
      window.__fsrSocAssistant__.replayTurns([
        { user: 'build a blast radius playbook' },
        { transcript: [{ type: 'text', text: "Here's the YAML:\n```yaml\n" + yaml + "\n```" }] },
        { user: 'create it' },
        { transcript: [{ type: 'text', text: 'Done — the playbook is saved.' }] },
      ]);
    });

    // Build mode is restored from the transcript, YAML recovered.
    await expect.poll(() => page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('build');
    expect(await page.evaluate(() => window.__fsrSocAssistant__.currentYaml))
      .toContain('Blast Radius');

    // The YAML toggle and pane render; the redundant build-from-triage CTA does not.
    await expect(page.locator('[data-testid="toggle-yaml"]')).toBeVisible();
    await expect(page.locator('[data-testid="yaml-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="triage-handoff"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
