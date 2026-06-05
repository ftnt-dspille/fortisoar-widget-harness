'use strict';
// A3 + F (widget side) — TRIAGE_BUILD_AUDIT_PLAN.md
//  A3: when the agent authors YAML in a triage session the build-only YAML pane
//      stays hidden; instead a "playbook drafted from this triage" CTA appears
//      and "Open in Build" flips intent so the existing pane (+ Create) renders.
//  F:  the export modal offers a machine-readable .events.json sidecar download.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: true
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

test.describe('A3 triage-draft handoff', () => {
  test('YAML pane stays hidden in triage; CTA appears and Open in Build reveals it', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await boot(page);

    // Simulate the agent having drafted YAML while still in a triage session.
    await page.evaluate(() => window.__fsrSocAssistant__.seedTriageDraft());

    const cta = page.locator('[data-testid="triage-draft-handoff"]');
    const pane = page.locator('[data-testid="yaml-pane"]');

    // In triage: CTA visible, build-only YAML pane hidden.
    await expect(cta).toBeVisible();
    await expect(pane).toHaveCount(0);

    // Open in Build flips intent -> the existing pane (with Create) renders.
    await page.locator('[data-testid="open-draft-in-build"]').click();
    await expect(pane).toBeVisible();
    await expect(page.locator('[data-testid="yaml-push"]')).toBeVisible();
    await expect(cta).toHaveCount(0); // CTA gone once we're in build
    expect(await page.evaluate(() => window.__fsrSocAssistant__.intent)).toBe('build');

    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('Copy button shows ✓ Copied feedback; width toggle swaps the split', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await page.evaluate(() => window.__fsrSocAssistant__.seedTriageDraft());
    await page.locator('[data-testid="open-draft-in-build"]').click();

    const copy = page.locator('[data-testid="yaml-copy"]');
    await expect(copy).toBeVisible();
    await expect(copy).toHaveText('Copy');
    await copy.click();
    await expect(copy).toHaveText(/Copied/);          // explicit success signal
    await expect(copy).toHaveClass(/copied/);

    // width swap: toggling adds .yaml-wide to .body so the panes re-flow
    const body = page.locator('.fsr-pb-widget .body');
    await expect(body).not.toHaveClass(/yaml-wide/);
    await page.locator('[data-testid="yaml-width-toggle"]').click();
    await expect(body).toHaveClass(/yaml-wide/);
    await page.locator('[data-testid="yaml-width-toggle"]').click();
    await expect(body).not.toHaveClass(/yaml-wide/);
  });
});

test.describe('F export .events.json sidecar', () => {
  test('export modal offers a .events.json download that yields valid JSON', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__fsrSocAssistant__.openExport());

    const dlBtn = page.locator('[data-testid="export-download-json"]');
    await expect(dlBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dlBtn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.events\.json$/);

    const stream = await download.createReadStream();
    let body = '';
    for await (const chunk of stream) body += chunk;
    const doc = JSON.parse(body);
    expect(doc.manifest).toBeTruthy();
    expect(typeof doc.manifest.intent).toBe('string');
    expect(typeof doc.manifest.toolCallCount).toBe('number');
    expect(Array.isArray(doc.messages)).toBe(true);
  });
});
