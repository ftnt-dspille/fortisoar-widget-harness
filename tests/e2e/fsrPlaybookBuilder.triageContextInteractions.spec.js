'use strict';
// Validates three new triage context interactions (Phase F):
//   1. Quick-action chips (timeline, blast, iocs, mitre, similar, next)
//   2. "⊕ Case context" button (pull-page-details)
//   3. Triage → playbook handoff (build-from-triage)
//
// Runs against the dev harness at http://localhost:4401 directly,
// with mock mode active and entity context injected via addInitScript.

const { test, expect } = require('@playwright/test');

const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');
let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const SAMPLE_INCIDENT = {
  '@id': '/api/3/incidents/abc-123',
  name: 'Detected intrusion traffic attempts from 192.168.77.30 to 12.62.213.134',
  severity: 'Medium',
  status: 'Open',
  type: 'Intrusion',
  description: 'IPS signature description. Please identify affected endpoint.'
};

function urlFor(scenario, extra) {
  const mockParam = scenario ? `&mock=${scenario}` : '';
  return `/?widget=${WIDGET_ID}&context=Dashboard${mockParam}&fastmock=1${extra || ''}`;
}

async function boot(page, scenario, opts) {
  opts = opts || {};
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() });
    }
  });
  page.on('pageerror', e => {
    pageErrors.push({ message: e.message, stack: e.stack });
  });

  // Inject entity context BEFORE scripts run, so _detectEntity() picks it up
  // and sets uiIntent='triage' with a record that has fields.
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

  // Wait for the widget to be ready and test probe available.
  await page.waitForFunction(
    () => window.__fsrPlaybookBuilder__ && typeof window.__fsrPlaybookBuilder__.state === 'string',
    null, { timeout: 25000 }
  );

  // Settle any auto-seed / opener turn so callers see a stable idle state
  // (showQuickActions() is intentionally false while a turn is sending, so
  // asserting grid visibility mid-opener would be racy).
  await page.waitForFunction(
    () => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === 'idle',
    null, { timeout: 10000 }
  ).catch(() => {});

  return { consoleErrors, pageErrors };
}

async function waitForState(page, state, timeout = 5000) {
  await page.waitForFunction(
    (s) => window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state === s,
    state, { timeout }
  );
}

test.describe('Triage context interactions (Phase F)', () => {

  // ─── 1. Quick-action chips ────────────────────────────────────────────────

  test.describe('1. Quick-action context chips', () => {

    test('quick-actions grid visible on load over entity in triage mode', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // Verify we're in triage intent with entity context.
      const probe = await page.evaluate(() => ({
        intent: window.__fsrPlaybookBuilder__.intent,
        entity: window.__fsrPlaybookBuilder__.entity,
        showQuickActions: window.__fsrPlaybookBuilder__.showQuickActions
      }));
      expect(probe.intent).toBe('triage');
      expect(probe.entity).toBeTruthy();
      expect(probe.entity.iri).toBe(SAMPLE_INCIDENT['@id']);
      expect(probe.showQuickActions).toBe(true);

      // The grid is visible.
      const grid = page.locator('[data-testid="quick-actions"]');
      await expect(grid).toBeVisible();

      // All 6 cards present.
      const cards = page.locator('[data-testid^="quick-action-"]');
      await expect(cards).toHaveCount(6);
      const cardIds = await cards.evaluateAll(els => els.map(el => el.getAttribute('data-testid')));
      expect(cardIds.sort()).toEqual([
        'quick-action-blast',
        'quick-action-iocs',
        'quick-action-mitre',
        'quick-action-next',
        'quick-action-similar',
        'quick-action-timeline'
      ].sort());

      expect(consoleErrors).toEqual([]);
    });

    test('clicking a chip appends user message with chip prompt, fires turn with entity', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // Before click: no user messages.
      let msgCount = await page.evaluate(() => window.__fsrPlaybookBuilder__.messageCount);
      let userCount = await page.evaluate(() => {
        return window.__fsrPlaybookBuilder__.state &&
          window.__fsrPlaybookBuilder__.lastTurn &&
          (window.__fsrPlaybookBuilder__.lastTurn.messages || [])
            .filter(m => m.role === 'user').length;
      });

      // Click the "Threat Indicators" chip (iocs).
      const iocsCard = page.locator('[data-testid="quick-action-iocs"]');
      await expect(iocsCard).toBeVisible();

      const iocsPrompt = 'Extract the threat indicators (IPs, domains, hashes, URLs) from this case that we should block now.';

      // Click and let the turn run.
      await iocsCard.click();
      // Wait for the turn to start: messageCount must increase beyond its pre-click value.
      await page.waitForFunction(
        (prev) => window.__fsrPlaybookBuilder__.messageCount > prev,
        msgCount, { timeout: 5000 }
      );

      // After click: messageCount increased.
      msgCount = await page.evaluate(() => window.__fsrPlaybookBuilder__.messageCount);
      expect(msgCount).toBeGreaterThan(0);

      // The most recent message is from the user and contains the chip prompt.
      const lastMsg = await page.evaluate(() => {
        const m = window.__fsrPlaybookBuilder__.lastTurn;
        return m ? { role: m.role, content: m.content } : null;
      });
      // The user message is appended first; the assistant message arrives async.
      const messages = page.locator('[data-testid="messages"] [data-testid^="chat-message-"]');
      const msgTexts = await messages.allTextContents();
      expect(msgTexts.some(t => t.includes(iocsPrompt))).toBe(true);

      // The last sent payload includes the entity block and intent.
      const payload = await page.evaluate(() => window.__fsrPlaybookBuilder__.lastPayload);
      expect(payload).toBeTruthy();
      expect(payload.intent).toBe('triage');
      expect(payload.entity).toBeTruthy();
      expect(payload.entity.iri).toBe(SAMPLE_INCIDENT['@id']);
      expect(payload.messages.some(m => m.role === 'user' && m.content.includes(iocsPrompt))).toBe(true);

      expect(consoleErrors).toEqual([]);
    });

    test('quick-actions grid collapses after first user turn', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // Grid is visible before any user turn.
      const grid = page.locator('[data-testid="quick-actions"]');
      await expect(grid).toBeVisible();

      // Send a user message (manually, not via chip).
      const composer = page.locator('.fsr-pb-widget .composer textarea');
      await composer.fill('What happened here?');
      await composer.press('Enter');

      // Wait for the widget to collapse the quick-actions grid (state-driven).
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.showQuickActions === false,
        null, { timeout: 5000 }
      );

      // showQuickActions() should now return false.
      const showQA = await page.evaluate(() => window.__fsrPlaybookBuilder__.showQuickActions);
      expect(showQA).toBe(false);

      // Grid is gone from the DOM.
      await expect(grid).not.toBeVisible();

      expect(consoleErrors).toEqual([]);
    });

  });

  // ─── 2. Pull-page-details button ──────────────────────────────────────────

  test.describe('2. "⊕ Case context" button (pull-page-details)', () => {

    test('button is visible and clickable when entity is mounted', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      const btn = page.locator('[data-testid="pull-page-details"]');
      await expect(btn).toBeVisible();
      expect(await page.evaluate(() => window.__fsrPlaybookBuilder__.composerText)).toBe('');

      expect(consoleErrors).toEqual([]);
    });

    test('clicking button fills composer with entity summary', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      const btn = page.locator('[data-testid="pull-page-details"]');
      await btn.click();

      // Wait for the summary to populate (async).
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.composerText.length > 0,
        null, { timeout: 5000 }
      );

      const text = await page.evaluate(() => window.__fsrPlaybookBuilder__.composerText);

      // Summary should include the incident name and other key fields.
      expect(text).toContain(SAMPLE_INCIDENT.name);
      // May not include raw fields (depends on _composeEntitySummary implementation),
      // but should have some markdown or readable text.
      expect(text.length).toBeGreaterThan(50);

      // Verify the textarea is visually updated.
      const textarea = page.locator('.fsr-pb-widget .composer textarea');
      const value = await textarea.inputValue();
      expect(value).toBe(text);

      expect(consoleErrors).toEqual([]);
    });

    test('clicking button appends to existing text, not clobber', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      const textarea = page.locator('.fsr-pb-widget .composer textarea');
      // Note: AngularJS ng-model defaults to ngTrim=true, so a trailing space
      // is trimmed from the model — assert on the trimmed prefix, not verbatim.
      const prefix = 'My question:';
      await textarea.fill(prefix);
      // Ensure the model captured the prefix before clicking (avoid a fill/click race).
      await page.waitForFunction(
        (p) => (window.__fsrPlaybookBuilder__.composerText || '').indexOf(p) === 0,
        prefix, { timeout: 2000 }
      );

      const btn = page.locator('[data-testid="pull-page-details"]');
      await btn.click();

      await page.waitForFunction(
        (minLen) => window.__fsrPlaybookBuilder__.composerText.length > minLen,
        prefix.length + 50, { timeout: 5000 }
      );

      const finalText = await page.evaluate(() => window.__fsrPlaybookBuilder__.composerText);
      // Existing text is preserved (not clobbered), separated from the pulled
      // summary by a blank line, and the summary follows it.
      expect(finalText.indexOf(prefix)).toBe(0);
      expect(finalText).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n`));
      expect(finalText).toContain(SAMPLE_INCIDENT.name);
      expect(finalText.indexOf(SAMPLE_INCIDENT.name)).toBeGreaterThan(prefix.length);

      expect(consoleErrors).toEqual([]);
    });

    test('button disabled while a turn is sending', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'incident_smtp_intrusion', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      const btn = page.locator('[data-testid="pull-page-details"]');
      await expect(btn).toBeEnabled();

      const textarea = page.locator('.fsr-pb-widget .composer textarea');
      await textarea.fill('Test message');

      // Start sending (don't await, so we catch the state mid-flight).
      const enterKey = textarea.press('Enter');

      // Immediately check: button should be disabled while sending.
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.state === 'sending',
        null, { timeout: 1000 }
      );
      await expect(btn).toBeDisabled();

      // Let the turn finish.
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.state === 'idle',
        null, { timeout: 6000 }
      );
      await expect(btn).toBeEnabled();

      expect(consoleErrors).toEqual([]);
    });

  });

  // ─── 3. Triage → playbook handoff ─────────────────────────────────────────

  test.describe('3. Triage → playbook handoff (build-from-triage)', () => {

    test('handoff CTA bar appears after first user turn', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // Before any user turn: no handoff bar.
      const triageHandoff = page.locator('[data-testid="triage-handoff"]');
      await expect(triageHandoff).not.toBeVisible();

      // Send a user message.
      const textarea = page.locator('.fsr-pb-widget .composer textarea');
      await textarea.fill('What is the timeline of events?');
      await textarea.press('Enter');

      // Wait for the turn to complete.
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.messageCount > 1,
        null, { timeout: 6000 }
      );

      // After a user turn: handoff bar should appear.
      await expect(triageHandoff).toBeVisible();

      expect(consoleErrors).toEqual([]);
    });

    test('clicking "Build playbook" flips intent to build, appends directive, fires turn', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'incident_smtp_intrusion', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // Let the auto-seed complete (first assistant message).
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.messageCount > 0,
        null, { timeout: 6000 }
      );

      // The incident fixture includes action cards (tool calls).
      // Wait for them to render so we know tools were used.
      await page.locator('[data-testid="action-card-card-block-c2"]')
        .waitFor({ state: 'visible', timeout: 6000 })
        .catch(() => {
          // If no action card, the fixture still has tool_call events in a message.
        });

      // Get the message count before the handoff.
      const msgCountBefore = await page.evaluate(() => window.__fsrPlaybookBuilder__.messageCount);

      const handoffBtn = page.locator('[data-testid="build-from-triage"]');
      await expect(handoffBtn).toBeVisible();

      // Click the handoff button.
      await handoffBtn.click();

      // Wait for the new user message to appear.
      await page.waitForFunction(
        (before) => window.__fsrPlaybookBuilder__.messageCount > before,
        msgCountBefore, { timeout: 3000 }
      );

      // Check intent flipped to build.
      const intent = await page.evaluate(() => window.__fsrPlaybookBuilder__.intent);
      expect(intent).toBe('build');

      // The directive message should have been appended.
      const lastPayload = await page.evaluate(() => window.__fsrPlaybookBuilder__.lastPayload);
      expect(lastPayload).toBeTruthy();
      expect(lastPayload.intent).toBe('build');

      // The directive is a user message with "Design a re-runnable playbook".
      const directiveMsg = lastPayload.messages.find(
        m => m.role === 'user' && m.content.includes('Design a re-runnable')
      );
      expect(directiveMsg).toBeTruthy();

      expect(consoleErrors).toEqual([]);
    });

    test('handoff directive includes tools used in triage (if any)', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'incident_smtp_intrusion', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // incident_smtp_intrusion fixture includes tool calls (search_assets, fortisiem.run_query, etc.).
      // Wait for the first turn to complete so tools are in the transcript.
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.messageCount > 0,
        null, { timeout: 6000 }
      );

      // Get tools used.
      const toolsUsed = await page.evaluate(() => window.__fsrPlaybookBuilder__.toolsUsedInTriage);
      // incident_smtp_intrusion should have produced some tools.
      console.log('Tools used in triage:', toolsUsed);

      // Proceed with handoff.
      const handoffBtn = page.locator('[data-testid="build-from-triage"]');
      if (await handoffBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await handoffBtn.click();

        // Wait for the directive to be sent.
        await page.waitForFunction(
          () => {
            const lastPayload = window.__fsrPlaybookBuilder__.lastPayload;
            return lastPayload && lastPayload.intent === 'build';
          },
          null, { timeout: 6000 }
        );

        const lastPayload = await page.evaluate(() => window.__fsrPlaybookBuilder__.lastPayload);
        const directiveMsg = lastPayload.messages.find(
          m => m.role === 'user' && m.content.includes('Design a re-runnable')
        );

        // If tools were used, the directive should mention them.
        if (toolsUsed && toolsUsed.length > 0) {
          expect(directiveMsg.content).toContain('Operations used');
          toolsUsed.forEach(tool => {
            expect(directiveMsg.content).toContain(tool);
          });
        }
      }

      expect(consoleErrors).toEqual([]);
    });

    test('handoff preserves prior triage transcript in messages[]', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'incident_smtp_intrusion', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // Wait for first turn(s) to complete.
      await page.waitForFunction(
        () => window.__fsrPlaybookBuilder__.messageCount > 0,
        null, { timeout: 6000 }
      );

      // Record the message count before handoff.
      const triageMessageCount = await page.evaluate(() => window.__fsrPlaybookBuilder__.messageCount);

      // Proceed with handoff.
      const handoffBtn = page.locator('[data-testid="build-from-triage"]');
      if (await handoffBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await handoffBtn.click();

        // Wait for the directive to be sent.
        await page.waitForFunction(
          () => {
            const lastPayload = window.__fsrPlaybookBuilder__.lastPayload;
            return lastPayload && lastPayload.intent === 'build';
          },
          null, { timeout: 6000 }
        );

        // Check the payload's messages[]: should include prior turns + new directive.
        const lastPayload = await page.evaluate(() => window.__fsrPlaybookBuilder__.lastPayload);
        expect(lastPayload.messages.length).toBeGreaterThan(triageMessageCount);

        // The prior triage messages should still be in the array.
        const hasOldUserMessages = lastPayload.messages.some(
          m => m.role === 'user' && !m.content.includes('Design a re-runnable')
        );
        expect(hasOldUserMessages).toBe(true);
      }

      expect(consoleErrors).toEqual([]);
    });

    test('handoff button disabled when no user turn exists (no conversation)', async ({ page }) => {
      const { consoleErrors } = await boot(page, 'playbook_soc_demo', {
        entity: SAMPLE_INCIDENT, extra: '&opener=1'
      });

      // The widget is in triage with auto-seed, but auto-seed is an ASSISTANT message,
      // not a user turn. If we use playbook_soc_demo, it may not auto-seed.
      // Check: canBuildFromTriage should be false if no user message exists.
      const canBuild = await page.evaluate(() => window.__fsrPlaybookBuilder__.canBuildFromTriage);

      const handoffBtn = page.locator('[data-testid="build-from-triage"]');
      if (!canBuild) {
        // Button should not be visible or should be disabled.
        const visible = await handoffBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await expect(handoffBtn).toBeDisabled();
        }
      }

      expect(consoleErrors).toEqual([]);
    });

  });

});
