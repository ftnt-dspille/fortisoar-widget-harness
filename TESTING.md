# Writing tests that pass in this framework

Every widget change ships with tests: **controller logic → jest**, **DOM/template
→ Playwright e2e**. This guide captures the conventions that aren't obvious — the
ones that otherwise cost an afternoon. Read it before writing your first spec.

## The two test types

| | jest (unit) | Playwright (e2e) |
|---|---|---|
| Tests | controller view-model logic | real DOM rendered in the harness |
| Runs in | jsdom (no browser) | headless Chromium |
| Needs SOAR assets? | **No** | **Yes** — `make assets` first |
| Spec lives in | `widgets-src/<widget>/tests/*.test.js` | `fortisoar-widget-harness/tests/e2e/<widget>.spec.js` |
| Run with | `make test-unit WIDGET=<widget>` | `make test-e2e-widget WIDGET=<widget>` |

Always run through the Makefile — it owns the dev (14400) / test (14401) ports
and kills stale servers. Never hand-start a server or call `playwright` directly.

## Controller naming — the harness lint will block you

The harness refuses to mount a widget whose controllers aren't named by
convention, and a blocked mount makes **every** e2e for that widget fail with
"element(s) not found" (the widget never renders). The rule:

| Controller | Name pattern | Example (widget `incidentSummary` v1.0.0) |
|------------|--------------|-------------------------------------------|
| view | `<name><numericVersion>DevCtrl` | `incidentSummary100DevCtrl` |
| edit | `edit<PascalName><numericVersion>DevCtrl` | `editIncidentSummary100DevCtrl` |

`<numericVersion>` = the `info.json` version with dots removed (1.0.0 → `100`).
`scripts/new-widget.sh` and `widget bump` generate/rewrite these for you — don't
hand-edit the digits. If e2e fails to render, check the harness error panel: a
`[edit-controller-mismatch]` / `[stale-version-ref]` lint there is the cause.

> **Never hardcode the dotted version in the controller** (even in a comment) —
> the harness `stale-version-ref` lint blocks bootstrap on a stale literal after
> a bump, and a jest guard asserts `info.json.version` never appears verbatim in
> `view.controller.js`. Derive it from the served script URL instead.

## Unit tests (jest)

Pattern (see `widgets-src/_template/tests/view.controller.test.js`): boot a bare
`cybersponse` module, `require()` the controller IIFE (it self-registers), then
`$controller`-instantiate it with mocked injectables and assert the view-model.
angular + angular-mocks resolve from the harness `node_modules`.

```js
angular.module("cybersponse", []);
require("../widget/view.controller.js");
// then window.angular.mock.module / .inject to instantiate "<name>100DevCtrl"
```

Keep view logic pure and small so it's exercisable without a browser. Integration
assertions check **every** case (`expect(failures).toEqual([])`) — don't stop at
the first success.

## E2e tests (Playwright)

**Specs live in `fortisoar-widget-harness/tests/e2e/`, not in the widget folder.**
Playwright's `testDir` is the harness, and it does **not** crawl through the
`widgets-src` symlink — a spec left under `widgets-src/<w>/tests/e2e/` is silently
never discovered. `scripts/new-widget.sh` puts it in the right place.

The harness mounts widgets by `info.json` **name**, and selects which to render
from `localStorage`. Seed it before page scripts run:

```js
// resolve the mounted id (survives version bumps) via the harness API
const { widgets } = await (await request.get(`${HARNESS}/_fsr/widgets`)).json();
const id = widgets.find((w) => w.name === 'incidentSummary').id;   // "incidentSummary-1.0.0"

await page.addInitScript((wid) => {
  localStorage.setItem('harness.widget', wid);
  localStorage.setItem('harness.ctx', 'dashboard');
  localStorage.setItem('harness:config:' + wid, JSON.stringify({ title: 'Alice' }));
}, id);
await page.goto('/', { waitUntil: 'domcontentloaded' });
await expect(page.getByTestId('incident-summary-greeting')).toHaveText('Hello, Alice');
```

Conventions that matter:
- **`data-testid` on every element you assert/drive** — kebab-case, prefixed by
  the widget (`incident-summary-…`). `getByTestId` is selector-stable across
  template churn; CSS classes are not.
- **Don't put `data-ng-controller` on the view root** — the harness (and SOAR
  after publish) wraps the widget with its own; a second one creates a dead
  parallel scope and nothing renders. (KNOWLEDGEBASE.md §18.)
- Let Playwright auto-retry: `await expect(locator).toHaveText(...)` waits for the
  async Angular mount; no manual sleeps.

### E2e needs the SOAR app shell

The harness renders widgets inside the real FortiSOAR app bundle, served from
`fsr_src/`. Those are Fortinet platform assets we don't redistribute — run
**`make assets`** once (after setting `fortisoar-widget-harness/.env`) to fetch
them from your own licensed box. Without it, e2e fails with a
`/_fsr/templates.min.js` 500 / "harness boot failed". Unit tests don't need this.

## Quick visual checks

For a one-off "did the color/layout change" check, write a tiny ad-hoc Playwright
snippet (boot the harness on 14401, `addInitScript` the widget, screenshot) — do
**not** spin up the page-tester agent for a single assertion; it's far slower.

## Known issues

- The harness's own `soarEnv` keychain tests can report 2 failures under a
  multi-project run (`make test-unit WIDGET=<x>`) on a fresh install — a jest
  cross-project isolation quirk, not your widget. The default gate `make test`
  (harness only) is clean. Validate your widget with `make test-unit WIDGET=<x>`
  and read the `PASS <widget>` line for your suite specifically.
