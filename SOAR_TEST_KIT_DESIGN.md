# SOAR Widget Test Architecture + Reusable Test Kit — Design

Status: **DRAFT for review** (2026-05-30). Author: working session on fsrPlaybookBuilder.
Scope: the testing foundation for FortiSOAR AngularJS widgets in this repo, and the
reusable kit that lifts the FortiSOAR-specific parts out for other projects.

---

## 1. Why (the payoff)

Widget tests today are **one inverted layer**: ~31 Playwright e2e specs per widget, each
booting Angular in Chromium (~15s), and *all* logic — fixture replay, transcript→render-model
mapping, card normalization, contract-drift handling — is asserted only through the browser.
Consequences observed this session:

- A full fsrPlaybookBuilder e2e subset took **7.7 min**; 4 flaky tests burned the **60s
  per-test timeout** then retried (`retries:1`), wasting ~4 min on timing races alone.
- A trivial **version/controller-name desync** (`info.json` 1.0.30 vs `…1029DevCtrl`) was
  discovered as a *15s browser-bootstrap timeout* instead of a sub-second static check.
- Fixed `waitForTimeout(2500/1000/500)` calls and a dead-feeling `fastmock` flag mean waits
  are **time-based, not state-based** — slow when they pass, catastrophic when they fail.

The thesis: **make speed and determinism structural, not luck.** Catch each class of failure
with the cheapest mechanism that can catch it. Done once, every widget and every future
project inherits it — that's the exponential return.

## 2. Principles

1. **Cheapest-mechanism-wins.** A failure catchable by a static check must not require a
   browser. A failure catchable by pure-function replay must not require the DOM.
2. **One fixture set, every layer.** A scenario fixture (e.g. `c2_hunt.json`) is validated
   once for shape, replayed in jest for logic, rendered once in Playwright for DOM, and
   matched in live-parity tests. No parallel fixtures per layer.
3. **No artificial waits, ever.** Tests wait on the widget's own observable state/event log,
   never `waitForTimeout`. Test mode runs fixture delays at **0ms** (`?mode=instant`).
4. **Fail fast.** Per-test timeout 10s (not 60s); `retries:0` locally so flakiness is visible,
   not masked behind a doubled run.
5. **FortiSOAR oddities live in one place.** Every quirk below is handled by the kit, with a
   citation to the memory/KB note that documents it — so it's never re-discovered per widget.

## 3. The layered architecture

| Layer | Tool | Runs in | Cost | What belongs here |
|---|---|---|---|---|
| **0 — Static guards** | jest (no runtime) | node | <1s total | controller-name↔`info.json` version sync; fixture→contract-shape validation; CSS-bleed scan; `cs-*` data-prefix lint; `data-ng-controller`-on-root check |
| **1 — Pure logic** | jest | node | ms/test | render pipeline: `buildAssistantMessage`, `normalizeInfoCard/Blocks`, `inferToolStatus`, contract-drift decision, action-card validity, markdown strip, message→wire serialization. Fixture-replay assertions. |
| **2 — DOM smoke** | Playwright | chromium | ~few s/test, ~5 tests | real Angular render; action_card confirm/cancel gating; choice click; composer sticky; in-situ CSS bleed; drawer height; mount-context (drawer vs dashboard) |
| **3 — Live parity** | jest (`tests/live/`, gated) | node→SOAR | network | connector produces identical stop_reason/card-id sequences for the same fixtures |

Layer 1 absorbs ~20 of today's 31 e2e assertions. Layer 0 would have caught today's
bootstrap failure instantly. Layer 2 shrinks to the irreducibly-browser interactions.

### Determinism rules (enforced, not aspirational)
- A repo guard (grep test or eslint rule) **fails CI if a spec contains `waitForTimeout`**.
- Test URLs use `?mode=instant`; the mock service maps `instant`→0ms (today it has
  `fast`→≤30ms and `instant`→0 already — we standardize on `instant` for tests).
- `playwright.config.js`: `timeout: 10000`, `retries: 0` locally (`process.env.CI ? 1 : 0`).

## 4. The reusable SOAR Test Kit

A library that encapsulates "what it takes to faithfully mount and drive a FortiSOAR widget
in a test," so other widget projects depend on it instead of re-deriving each oddity.

### 4.1 Oddities it owns (each cited to its source note)
- **Stripped vendor modules** — ui-bootstrap et al. live in separate bundles; `uib-*`
  directives silently no-op. Kit loads the vendor lib + `templates.min.js` and registers
  `HARNESS_VENDOR_DEPS`. *(memory: harness_stripped_vendors)*
- **`templates.min.js` dangling `||`** on ui-select-choices — patched on serve; do NOT
  re-strip once CDN ui-select 0.20.0 is loaded. *(harness_uiselect_ngshow, harness_stripped_vendors)*
- **Empty `moduleAttribute` registry** — `.attribute()` configs don't run under the patched
  cybersponse module; kit seeds the 45 field-type→templateUrl entries from a `.run` block.
  *(soar_module_attribute_registry)*
- **csField `$parent.value` misbinding under cs-conditional** — kit ships the patched field
  templates (`input.html` done; integer/datetime/multiselect/select/etc. are latent). *(harness_csfield_parent_value_bug)*
- **`data-ng-controller` on view.html root is forbidden** — publish rewrites `…DevCtrl`→`…Ctrl`
  but not the attribute, creating a dead parallel scope. Kit's mount wraps the ng-include in
  the dev controller; a Layer-0 guard fails if the widget's own view.html root carries it.
  *(soar_widget_text_interpolation_stripped)*
- **Controller-name convention** `<name><digits>DevCtrl` / `edit<Cap><digits>DevCtrl` — kit
  derives the expected name from `info.json` (mirrors `harnessUtils.deriveControllerName`) and
  the Layer-0 guard asserts the source matches. *(this session's bootstrap failure; dev_workflow bootstrap pattern)*
- **`usersService` absent in harness** — kit provides a stub (current user / avatar).
- **Broken CSP** (`default-src self`, unquoted) blocks Worker `importScripts` — kit documents
  the avoid-worker strategy for Monaco-using widgets. *(soar_csp_bug, soar_monaco_path)*
- **Drawer/standalone mounting** via `metadata.view.enableFor` UI-Router states — kit can mount
  a widget in a simulated `main.playbookDetail`-style context. *(soar_widget_drawer_enable_for)*
- **CSS bleed** from co-installed widgets' unscoped generics — kit's bleed assertion flags
  rules that actually match elements in the widget subtree. *(existing remote.probe.js logic)*
- **`ui-select-tpls` is on jsdelivr, not cdnjs** — kit pins the correct CDN. *(dev_workflow)*

### 4.2 Public API (sketch — to refine during build)
```
// faithful mount + teardown (Playwright)
const w = await mountWidget(page, { id, context: 'drawer'|'dashboard', entity, config, scenario, mode: 'instant' });

// state/event tracking — NEVER a timeout
await w.waitForState('idle');           // polls window.__probe__.state
await w.waitForEvent('turn_result_discarded');
const ev = w.events();                  // the widget's own event log

// interactions
await w.confirmActionCard('card-block-c2');
await w.rejectActionCard('card-id');
await w.pickChoice('intent', 'playbook');

// static guards (Layer 0, node — no page)
assertControllerNameSync(widgetDir);    // info.json ↔ registered controller
assertNoRootNgController(widgetDir);
validateFixtureContract(fixture);       // shape vs contract version + event vocab
assertNoCssBleed(widgetDir);

// fixture loader (shared by jest + Playwright + live)
const fx = loadFixture('c2_hunt');
```

### 4.3 Boundaries — what is kit vs widget
- **Kit (reusable, SOAR-generic):** mount/shim/track/guard, fixture IO, the oddity handling.
- **Widget (per-widget logic):** the extracted pure render module (`fsrPbRender`), its fixtures,
  and the thin Layer-2 smokes that use the kit. The render module is NOT in the kit — it's
  widget-specific; the kit only provides the harness to exercise it.

## 5. Fixture as single source of truth
A fixture declares `scenario`, `contract_version`, `delays` (0 under `instant`), and `responses`.
- Layer 0 validates every fixture against the contract event vocabulary + version.
- Layer 1 replays `responses[].response.transcript` through the pure render module and asserts
  the render-model (card ids, block kinds, stop_reason→halt, choice options).
- Layer 2 loads the same scenario in the browser for the one render+interaction proof.
- Layer 3 asserts the live connector emits the same stop_reason/card-id sequence.

## 6. Proving ground + migration (fsrPlaybookBuilder)
1. **Extract** the pure render pipeline from `view.controller.js` into
   `widgetAssets/js/fsrPbRender.js` (UMD: browser global + `module.exports`), loaded like the
   existing `fsrPbMockConnector.service.js`. Controller delegates; zero behavior change.
2. **Layer 0**: adopt the c3charts bootstrap-test pattern for fsrPlaybookBuilder + add
   contract-shape fixture validation. (Catches the version-sync class instantly.)
3. **Layer 1**: jest replay of every fixture through `fsrPbRender`. Port ~20 e2e assertions.
4. **Layer 2**: cut e2e to ~5 smokes; replace all `waitForTimeout` with kit tracking;
   `mode=instant`; `retries:0`; `timeout:10000`.
5. Measure: target the fsrPlaybookBuilder suite from 7.7 min → well under 1 min.

## 7. Cross-project extraction (phase 2)
Build kit at `fortisoar-widget-harness/lib/soar-test-kit/` with a clean public surface (§4.2).
Once stable on fsrPlaybookBuilder + one more widget (c3charts is the natural second, it already
has the bootstrap pattern), lift it to a standalone versioned package the harness depends on.
Link this doc from `~/PycharmProjects/Miscellaneous/FORTISOAR_RESOURCES_INDEX.md`.

## 8. Open decisions (for review)
- **Test location**: dev_workflow.md says per-widget `widgets-src/<w>/tests/`, but the live e2e
  specs sit in `fortisoar-widget-harness/tests/e2e/`. Pick one home before migrating. *(decision needed)*
- **`fast` vs `instant`**: standardize test mode on `instant` (0ms) and retire the `fastmock=1`
  alias, or keep both? Recommend: tests use `instant`, keep `fast` for human demo speed.
- **Guard enforcement**: grep-based no-`waitForTimeout` test vs a real eslint rule. Recommend
  grep test first (zero deps), eslint later.
- **How much of the kit lands in phase 1** vs deferred (e.g. drawer-context mount, Monaco CSP
  helper) — driven by what fsrPlaybookBuilder actually needs first.
