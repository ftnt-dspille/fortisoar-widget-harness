'use strict';
// LIVE detached-turn probe (contract 2.7.0 / §11) — the path the mock specs
// never exercise.
//
// Every other fsrSocAssistant e2e runs in MOCK mode (`?mock=…`), where a
// chat_turn returns the full transcript inline and synchronously. The real
// product bug the analyst hit ("ask to build a playbook → stuck on the typing
// bubbles forever") lives in the LIVE path: in live mode the widget sends
// `detached:true`, the connector returns a bare {accepted} ack with NO
// transcript, and the turn is driven entirely off `chat_poll`. The viewState
// only returns to 'idle' when a terminal `stream_end` frame commits — so any
// way the poll loop can end WITHOUT committing leaves `viewState==='sending'`
// and the typing indicator (`[data-testid="typing-indicator"]`,
// ng-if="viewState === 'sending'") spinning forever.
//
// This spec stubs the FortiSOAR connector HTTP layer (page.route on
// /api/integration/{connectors,execute}) so we can drive the detached contract
// deterministically — no live SOAR box, no LLM, no paid calls — and assert the
// frontend ALWAYS leaves the 'sending' state, in the happy path and in every
// degenerate terminal the connector can hand it.

const { test, expect } = require('@playwright/test');
const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const TYPING = '[data-testid="typing-indicator"]';
const SEND   = '[data-testid="chat-send"]';
const INPUT  = '[data-testid="chat-input"]';

// ── Wire shapes ──────────────────────────────────────────────────────────────
const CONTRACT = '2.8.0';

function connectorsBody() {
  // Shape consumed by fsrPbAgentService._resolveConnector: resp.data.data[].
  return {
    data: [{
      name: 'fsr-playbook-builder',
      version: CONTRACT,
      configuration: [{ name: 'fsrpb-live', config_id: 'cfg-live-1', default: true }]
    }]
  };
}
// SOAR execute envelope: {operation,status,data}. The service unwraps `.data`.
const envelope = (operation, data) => ({ operation, status: 'Success', message: 'ok', data });

const ackData = (turn) => ({
  ok: true, accepted: true, session_id: 'sess-probe', turn,
  turn_id: 'turn-' + turn, stop_reason: 'accepted', contract_version: CONTRACT
});

const frame = (type, extra) => Object.assign({ type }, extra || {});

// A realistic build transcript: model narrates, runs one op, then offers to
// save the session as a playbook.
function buildTranscript() {
  return [
    frame('text', { text: 'Drafting a containment playbook for 102.220.160.21.' }),
    frame('tool_use', { id: 'tu-1', name: 'find_containment_actions', input: { ip: '102.220.160.21' } }),
    frame('tool_result', { tool_use_id: 'tu-1', tool: 'find_containment_actions',
                           content: JSON.stringify({ actions: ['block_ip'] }) }),
    frame('playbook_offer', {
      id: 'pb-offer-live-1',
      summary: 'Save this investigation as a repeatable playbook?',
      title_suggestion: 'C2 Containment — 102.220.160.21',
      ops_summary: [{ connector: 'fortigate', operation: 'block_ip', label: 'Block 102.220.160.21' }]
    })
  ];
}

// Scriptable poll feeds. Each entry is the ORDERED list of {data} bodies the
// connector returns for successive chat_poll calls on the same turn. The route
// handler advances a per-test cursor and repeats the LAST entry once exhausted
// (mirrors a real connector that keeps reporting `done` after completion).
function pollScript(scenario, turn) {
  const tid = 'turn-' + turn;
  const term = (extra) => ({
    ok: true, contract_version: CONTRACT, turn, cursor: 99, done: true,
    frames: [frame('stream_end', Object.assign({ turn, turn_id: tid }, extra))]
  });
  const start = {
    ok: true, contract_version: CONTRACT, turn, cursor: 1, done: false,
    frames: [frame('turn_start', { turn, turn_id: tid })]
  };
  const progress = {
    ok: true, contract_version: CONTRACT, turn, cursor: 2, done: false,
    frames: [frame('text', { text: 'Working…' })]
  };
  switch (scenario) {
    // Happy detached build: start → progress → authoritative terminal.
    case 'happy':
      return [start, progress, term({
        ok: true, stop_reason: 'awaiting_playbook_offer', transcript: buildTranscript()
      })];
    // BUG A — signal-only terminal: connector finishes (done:true) but the
    // stream_end carries NO transcript. _absorbPoll's stream_end branch falls
    // through to "defer to chat_turn's blocking return" — but in detached mode
    // that return was a bare ack with no transcript. Nothing ever commits.
    case 'signal_only':
      return [start, progress, term({ ok: true, stop_reason: 'end_turn' /* no transcript */ })];
    // BUG B — lost producer: frames stream, but the terminal never arrives
    // (done stays false forever). With no widget-side wall-clock cap the poll
    // loop spins indefinitely.
    case 'never_terminal':
      return [start, progress, progress, progress, progress, progress, progress];
    // BUG C — connector raised: terminal carries stop_reason:error + an error
    // event transcript. Must surface as an error, not a hang.
    case 'error_terminal':
      return [start, term({
        ok: false, stop_reason: 'error',
        transcript: [frame('error', { message: 'agent run failed: provider unreachable' })]
      })];
    default:
      throw new Error('unknown scenario ' + scenario);
  }
}

// Install the connector HTTP stub for a given chat scenario. `pushOk` controls
// the compile_yaml/push_playbook path used when accepting an offer.
async function stubConnector(page, scenario, opts) {
  opts = opts || {};
  const state = { polls: 0, script: null, turn: 1 };

  await page.route(/\/api\/integration\/connectors\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(connectorsBody()) })
  );

  await page.route(/\/api\/integration\/execute\//, async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* */ }
    const op = body.operation;
    let data;
    if (op === 'chat_turn') {
      // Detached turn: the widget sends detached:true and expects a bare ack.
      state.script = pollScript(scenario, state.turn);
      data = ackData(state.turn);
    } else if (op === 'chat_poll') {
      const seq = state.script || pollScript(scenario, state.turn);
      const idx = Math.min(state.polls, seq.length - 1);
      state.polls++;
      data = seq[idx];
    } else if (op === 'compile_yaml') {
      data = { ok: true, workflow_json: { name: 'probe', tag: 'probe' } };
    } else if (op === 'push_playbook') {
      data = { ok: true, collection_uuid: 'coll-1', workflow_uuids: ['wf-1'],
               raw: { '@id': '/api/3/workflow_collections/coll-1' } };
    } else if (op === 'chat_resume') {
      // Accepting the offer compiles+pushes and returns a fresh end_turn turn
      // with a confirmation. Resume is always blocking (not detached).
      data = { ok: true, turn: ++state.turn, turn_id: 'turn-' + state.turn,
               contract_version: CONTRACT, stop_reason: 'end_turn',
               transcript: [frame('text', { text: 'Playbook pushed. Workflow ready.' })] };
    } else {
      data = { ok: true };
    }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(envelope(op, data)) });
  });

  return state;
}

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: false, mockMode: 'real',
      // Short defense-in-depth watchdog so the lost-producer scenario settles
      // within the test wall clock (prod default is 6 min).
      detachedTimeoutMs: 7000
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  // ?mode=live forces the detached/poll path (no mock track).
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__fsrSocAssistant__ && typeof window.__fsrSocAssistant__.state === 'string',
    null, { timeout: 25000 });
  // Composer must come ready (connector resolved against our stub). The input
  // is enabled only when viewState==='idle' && connectorReady!==false.
  await expect(page.locator(INPUT)).toBeEnabled({ timeout: 15000 });
}

async function askToBuild(page) {
  await page.locator(INPUT).fill('Build me a containment playbook for 102.220.160.21');
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();
  // The turn dispatches → typing indicator appears.
  await expect(page.locator(TYPING)).toBeVisible({ timeout: 5000 });
}

test.describe('live detached build — the turn must always leave the sending state', () => {
  test('happy path: detached build streams then commits the playbook offer', async ({ page }) => {
    await stubConnector(page, 'happy');
    await boot(page);
    await askToBuild(page);
    // Authoritative terminal commits → typing bubbles clear, offer renders.
    await expect(page.locator(TYPING)).toBeHidden({ timeout: 15000 });
    await expect(page.locator('[data-testid="playbook-offer-pb-offer-live-1"]')).toBeVisible();
    await expect(page.locator(SEND)).toBeVisible();
  });

  test('accept the offer pushes a real playbook and confirms', async ({ page }) => {
    await stubConnector(page, 'happy');
    await boot(page);
    await askToBuild(page);
    await expect(page.locator('[data-testid="playbook-offer-accept-pb-offer-live-1"]')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-testid="playbook-offer-accept-pb-offer-live-1"]').click();
    await expect(page.locator(TYPING)).toBeHidden({ timeout: 15000 });
    await expect(page.locator('.fsr-pb-widget')).toContainText('Playbook pushed');
  });

  // ── Regression: degenerate terminals must NOT hang the composer ────────────
  test('signal-only terminal (no transcript) does not hang the composer', async ({ page }) => {
    await stubConnector(page, 'signal_only');
    await boot(page);
    await askToBuild(page);
    // Regression: a signal-only terminal once stranded the composer in 'sending'
    // forever (no transcript to commit, detached ack carried none). The settle
    // path must degrade-commit the streamed frames and free the composer.
    await expect(page.locator(TYPING)).toBeHidden({ timeout: 20000 });
    await expect(page.locator(SEND)).toBeVisible();
  });

  test('lost producer (terminal never arrives) does not hang the composer', async ({ page }) => {
    await stubConnector(page, 'never_terminal');
    await boot(page);
    await askToBuild(page);
    await expect(page.locator(TYPING)).toBeHidden({ timeout: 30000 });
    await expect(page.locator(SEND)).toBeVisible();
  });

  test('error terminal surfaces an error instead of hanging', async ({ page }) => {
    await stubConnector(page, 'error_terminal');
    await boot(page);
    await askToBuild(page);
    await expect(page.locator(TYPING)).toBeHidden({ timeout: 15000 });
    await expect(page.locator('.fsr-pb-widget')).toContainText('failed');
  });
});
