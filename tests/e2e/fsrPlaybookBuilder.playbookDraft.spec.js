'use strict';
// playbook_offer 2.6.0 — the reviewable playbook-draft card. End-of-triage the
// agent compiles a playbook from the recorded action trace; the offer now
// carries `draft_steps` (the branch view) + per-step verify/wiring/gaps. This
// spec drives the `playbook_draft_branching` fixture and asserts:
//   1. branch view renders (decision fork, plain-English wiring, step rows)
//   2. per-step verify badges + an amber gap field show
//   3. a safe inline edit (manual_input prompt) round-trips into the accept
//      payload as `edits.steps[...]`
//   4. the FLAT fallback still renders when the new fields are absent
//      (pre-2.6.0 `playbook_offer_decline` fixture)

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, mock, extra) {
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
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=${mock}&fastmock=1&opener=1${extra || ''}`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForFunction(
    () => window.__fsrPlaybookBuilder__ && typeof window.__fsrPlaybookBuilder__.state === 'string',
    null, { timeout: 25000 }
  );
}

const OFFER = 'pb-offer-c2-draft';
const CARD = `[data-testid="playbook-offer-${OFFER}"]`;

test.describe('playbook_offer 2.6.0 reviewable draft', () => {
  const ENRICH = 'Enrich 102.220.160.21';
  const QUAR = 'Quarantine smithDesktop';

  test('renders the branch view, verify badges and a gap field', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await boot(page, 'playbook_draft_branching');
    const card = page.locator(CARD);
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/playbook-offer-card/);

    // draft present => flat list suppressed, "Review steps (N)" toggle shown
    await expect(card.locator('.po-steps')).toHaveCount(0);
    const review = card.locator(`[data-testid="playbook-offer-review-${OFFER}"]`);
    await expect(review).toContainText('Review steps (4)'); // 4 ops nodes

    // progressive disclosure: steps hidden until expanded
    await expect(card.locator(`[data-testid="playbook-offer-draft-${OFFER}"]`)).toHaveCount(0);
    await review.click();
    const draft = card.locator(`[data-testid="playbook-offer-draft-${OFFER}"]`);
    await expect(draft).toBeVisible();
    // two top-level draft nodes (Enrich + the Malicious? fork)
    await expect(draft.locator('> .po-draft-step')).toHaveCount(2);

    // plain-English wiring (NOT raw jinja)
    await expect(draft).toContainText('uses the IP from Enrich 102.220.160.21');

    // decision fork renders both branches with editable labels
    await expect(card.locator(`[data-testid="playbook-offer-branch-${OFFER}-1-0"]`))
      .toHaveValue('if malicious');
    await expect(card.locator(`[data-testid="playbook-offer-branch-${OFFER}-1-1"]`))
      .toHaveValue('else');
    // both branch children render under the fork
    await expect(draft.locator('.po-branch-child')).toHaveCount(3); // Block + Quarantine + Ticket

    // verify badge on a verified node; amber gap on the verified:false node
    await expect(card.locator(`[data-testid="playbook-offer-verified-${OFFER}-${ENRICH}"]`)).toBeVisible();
    await expect(card.locator(`[data-testid="playbook-offer-verified-${OFFER}-${QUAR}"]`)).toHaveCount(0);
    await expect(card.locator(`[data-testid="playbook-offer-gapbadge-${OFFER}-${QUAR}"]`)).toBeVisible();
    await expect(card.locator(`[data-testid="playbook-offer-gap-${OFFER}-${QUAR}"]`)).toBeVisible();

    await page.screenshot({ path: '/tmp/playbook_draft_card.png', fullPage: true });
    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('safe inline edits round-trip into the accept payload as edits', async ({ page }) => {
    await boot(page, 'playbook_draft_branching');
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator(`[data-testid="playbook-offer-review-${OFFER}"]`).click();

    // fill the verified:false gap (→ edits.manual_input_prompts[label])
    await page.locator(`[data-testid="playbook-offer-gap-${OFFER}-${QUAR}"]`)
      .fill('Enter host to isolate');
    // rename a branch label (→ edits.branch_labels[node][key])
    await page.locator(`[data-testid="playbook-offer-branch-${OFFER}-1-0"]`)
      .fill('Confirmed C2');

    await page.locator(`[data-testid="playbook-offer-accept-${OFFER}"]`).click();

    await expect(page.locator(`[data-testid="playbook-offer-resolution-${OFFER}"]`)).toBeVisible();
    await expect(page.locator('.fsr-pb-widget')).toContainText('repeatable playbook');

    // the resume payload (captured by the widget debug probe) carries the
    // contract-shaped edits: manual_input_prompts + branch_labels
    const accept = await page.evaluate(() => window.__fsrPlaybookBuilder__.lastPayload);
    expect(accept, 'accept resume payload was sent').toBeTruthy();
    expect(accept.decision).toBe('accept');
    expect(accept.title).toContain('C2 Containment');
    expect(accept.edits).toBeTruthy();
    expect(accept.edits.manual_input_prompts[QUAR]).toBe('Enter host to isolate');
    expect(accept.edits.branch_labels['Malicious?']['if malicious']).toBe('Confirmed C2');
  });

  test('flat fallback still renders when draft_steps is absent (pre-2.6.0)', async ({ page }) => {
    await boot(page, 'playbook_offer_decline');
    const card = page.locator('[data-testid="playbook-offer-pb-offer-c2-1"]');
    await expect(card).toBeVisible();
    // no review toggle, the legacy flat ordered list is shown
    await expect(card.locator('[data-testid="playbook-offer-review-pb-offer-c2-1"]')).toHaveCount(0);
    await expect(card.locator('.po-steps')).toBeVisible();
    await expect(card.locator('[data-testid="playbook-offer-step-pb-offer-c2-1-0"]'))
      .toContainText('Block 102.220.160.21');
  });
});
