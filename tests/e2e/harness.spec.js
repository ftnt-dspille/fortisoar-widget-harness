"use strict";
// E2E tests for the dev harness UI.
// The harness server is started automatically by Playwright (see playwright.config.js).
// API calls to /api/** and Monaco assets are intercepted so no real SOAR is needed.

const { test, expect } = require("./_fixtures");

// ---------------------------------------------------------------------------
// Minimal Monaco stub injected before any page scripts run.
// The harness's preloadMonaco() checks `if (window.monaco) return window.monaco;`
// first — this satisfies that guard so it never tries to load from the proxy.
// ---------------------------------------------------------------------------
const MONACO_STUB = `
(function() {
  function makeEditor(opts) {
    var val = (opts && opts.value) || '';
    var listeners = [];
    var model = {
      getLanguageId: function() { return (opts && opts.language) || 'text'; },
      getLineContent: function(n) { return (editor._val.split('\\n')[n - 1]) || ''; },
      getValueInRange: function() { return ''; },
    };
    var editor = {
      _val: val,
      getValue: function() { return this._val; },
      setValue: function(v) { this._val = v; },
      // Test hook: set the value AND fire change listeners (mimics user typing).
      _typeValue: function(v) { this._val = v; listeners.forEach(function(fn) { fn({}); }); },
      getModel: function() { return model; },
      getPosition: function() { return { lineNumber: 1, column: 1 }; },
      getSelection: function() { return { startLineNumber:1, startColumn:1, endLineNumber:1, endColumn:1 }; },
      // Append text from edits and notify listeners so contentChange callbacks fire.
      executeEdits: function(src, edits) {
        var self = this;
        if (edits && edits.length && typeof edits[0].text === 'string') {
          self._val = self._val + edits[0].text;
        }
        listeners.forEach(function(fn) { fn({}); });
      },
      getContribution: function() { return null; },
      focus: function() {},
      onDidChangeModelContent: function(fn) {
        listeners.push(fn);
        return { dispose: function() { listeners = listeners.filter(function(f) { return f !== fn; }); } };
      },
      layout: function() {},
      dispose: function() {},
    };
    return editor;
  }
  // Expose created editors by language so tests can inspect/patch _val.
  window.__monacoEditors = {};
  // Capture setModelMarkers calls so tests can verify squiggle wiring without
  // needing real Monaco's hover renderer. Indexed by owner string.
  window.__monacoMarkers = {};
  window.monaco = {
    editor: {
      create: function(el, opts) {
        var ed = makeEditor(opts);
        var lang = (opts && opts.language) || 'text';
        window.__monacoEditors[lang] = ed;
        return ed;
      },
      defineTheme: function() {},
      setTheme: function() {},
      setModelMarkers: function(model, owner, markers) {
        window.__monacoMarkers[owner] = markers.slice();
      },
      getModelMarkers: function(filter) {
        var owner = (filter && filter.owner) || null;
        if (owner) return (window.__monacoMarkers[owner] || []).slice();
        var all = [];
        Object.keys(window.__monacoMarkers).forEach(function(k) {
          all = all.concat(window.__monacoMarkers[k]);
        });
        return all;
      },
    },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    languages: {
      register: function() {},
      setMonarchTokensProvider: function() {},
      registerCompletionItemProvider: function() {},
      registerHoverProvider: function() {},
      CompletionItemKind: { Function: 2, Keyword: 17, Snippet: 27 },
    },
  };
  // Pre-resolve the harness's internal promise so preloadMonaco() never fires.
  window.__harnessMonacoPromise = Promise.resolve(window.monaco);
})();
`;

// ---------------------------------------------------------------------------
// Common test setup: inject Monaco stub, mock API calls, navigate.
// ---------------------------------------------------------------------------
// Sets up Monaco mocking for a page: injects the window.monaco stub before
// page scripts run, and intercepts jinjaMonaco.service.js so ensure() resolves
// immediately without touching the (unavailable) SOAR proxy AMD loader.
async function setupMonaco(page) {
  await page.addInitScript(MONACO_STUB);
  await page.route("**/jinjaMonaco.service.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `(function() {
  var ns = window.JinjaEditorWidget = window.JinjaEditorWidget || {};
  ns.monaco = {
    ensure: function() { return Promise.resolve(window.monaco); },
    enhanceEditor: function() {},
    setInputContext: function() {},
  };
})();`,
    })
  );
}

async function setupPage(page, { jinaResult = "Hello Ada" } = {}) {
  await setupMonaco(page);

  // Mock the Jinja evaluation endpoint.
  await page.route("**/api/wf/api/jinja-editor/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: jinaResult }),
    })
  );

  // Mock record fetches.
  await page.route(/\/api\/3\/(?!solutionpacks)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "123", name: "Test Alert", severity: "High" }),
    })
  );

  // Mock the stylesheet endpoint (hits SOAR).
  await page.route("**/_fsr/stylesheets", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ stylesheets: [] }),
    })
  );

  await page.goto("/");
}

async function selectWidget(page) {
  const select = page.locator("#widget-select");
  // Wait for options to be populated by the harness bootstrap JS.
  await expect(select.locator("option[value]")).not.toHaveCount(0, { timeout: 10000 });
  // Find the jinjaEditorWidget option value via the API.
  const resp = await page.request.get("/_fsr/widgets");
  const { widgets } = await resp.json();
  const jinja = widgets.find((w) => w.name === "jinjaEditorWidget");
  if (!jinja) throw new Error("jinjaEditorWidget not found in /_fsr/widgets");
  await select.selectOption({ value: jinja.id });
}

// The controller sets monacoReady=true after monaco.ensure() resolves, which
// enables the Render button. Wait for it to be enabled as the "widget is ready" signal.
async function waitForWidgetReady(page) {
  await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".render-btn:not([disabled])")).toBeVisible({ timeout: 15000 });
}

// Sets a non-empty template on the Angular scope so submit() won't bail early.
// ng-include creates a child scope, so we walk up to find the controller scope
// that owns templateText.
async function setTemplate(page, text = "Hello World") {
  await page.evaluate((t) => {
    const ctrlEl = document.querySelector("[ng-controller]");
    if (!ctrlEl) return;
    const scope = angular.element(ctrlEl).scope();
    scope.$apply(function () { scope.templateText = t; });
    // Submit() reads from templateEditor.getValue() first; ensure the editor
    // stub's _val matches the scope so submit doesn't bail with "Template is required".
    const ed = window.__monacoEditors && window.__monacoEditors["jinja"];
    if (ed) ed._val = t;
  }, text);
}

// ---------------------------------------------------------------------------
// Harness page — basic load
// ---------------------------------------------------------------------------
test.describe("harness page", () => {
  test("loads and shows the widget selector", async ({ page }) => {
    await setupPage(page);
    await expect(page.locator("#widget-select")).toBeVisible({ timeout: 10000 });
  });

  test("lists jinjaEditorWidget in the widget dropdown", async ({ page }) => {
    await setupPage(page);
    const select = page.locator("#widget-select");
    await expect(select.locator("option[value]")).not.toHaveCount(0, { timeout: 10000 });
    const options = await select.locator("option").allTextContents();
    expect(options.some((o) => o.includes("jinjaEditorWidget"))).toBe(true);
  });

  test("/_fsr/widgets returns widget list", async ({ page }) => {
    const resp = await page.request.get("/_fsr/widgets");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body.widgets)).toBe(true);
    const names = body.widgets.map((w) => w.name);
    expect(names).toContain("jinjaEditorWidget");
  });
});

// ---------------------------------------------------------------------------
// Widget loads in the harness
// ---------------------------------------------------------------------------
test.describe("widget load", () => {
  test("widget container and Render button become visible", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".render-btn")).toBeVisible({ timeout: 15000 });
  });

  test("widget renders the title from config", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
    // The harness sets config.title = "(harness)" so that's what we expect in the h5.
    await expect(page.locator(".jinja-editor-widget h5")).toBeVisible();
  });

  test("Render button is enabled after monacoReady", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    await expect(page.locator(".render-btn:not([disabled])")).toBeVisible();
  });

  test("Copy template button is visible", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: /copy template/i })).toBeVisible();
  });

  test("Load current record button is hidden on dashboard context", async ({ page }) => {
    await setupPage(page);
    // Default context is dashboard.
    await selectWidget(page);
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: /load current record/i })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Render — evaluateJinja happy path
// ---------------------------------------------------------------------------
test.describe("render (evaluateJinja)", () => {
  test("clicking Render calls the Jinja eval endpoint", async ({ page }) => {
    let intercepted = false;
    await setupMonaco(page);
    await page.route("**/api/wf/api/jinja-editor/**", (route) => {
      intercepted = true;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: "Hello Ada" }),
      });
    });
    await page.route(/\/api\/3\/(?!solutionpacks)/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) })
    );
    await page.route("**/_fsr/stylesheets", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stylesheets: [] }) })
    );

    await page.goto("/");
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();
    await expect(page.locator(".render-btn:not([disabled])")).toBeVisible({ timeout: 10000 });
    expect(intercepted).toBe(true);
  });

  test("output pane shows the rendered result", async ({ page }) => {
    await setupPage(page, { jinaResult: "Hello Ada" });
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();
    await expect(page.locator("#jinja-widget-output")).toHaveValue(/Hello Ada/, { timeout: 10000 });
  });

  test("shows error output when evaluateJinja returns 500", async ({ page }) => {
    await setupMonaco(page);
    await page.route("**/api/wf/api/jinja-editor/**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Internal Server Error" }),
      })
    );
    await page.route(/\/api\/3\/(?!solutionpacks)/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) })
    );
    await page.route("**/_fsr/stylesheets", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stylesheets: [] }) })
    );

    await page.goto("/");
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();
    // Controller sets isErrorOutput=true. The view renders error text.
    await expect(page.locator("#jinja-widget-output")).toHaveValue(/error/i, { timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Filter palette
// ---------------------------------------------------------------------------
test.describe("filter palette", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
  });

  test("Filters button opens the filter palette", async ({ page }) => {
    await page.getByRole("button", { name: /filter/i }).click();
    await expect(page.locator("#jinja-widget-filter-search")).toBeVisible({ timeout: 5000 });
  });

  test("searching filters narrows results", async ({ page }) => {
    await page.getByRole("button", { name: /filter/i }).click();
    await page.locator("#jinja-widget-filter-search").pressSequentially("upper");
    await expect(page.locator(".jinja-filter-item-name", { hasText: "upper" })).toBeVisible({ timeout: 3000 });
  });

  test("filter search removes non-matching items from the list", async ({ page }) => {
    await page.getByRole("button", { name: /filter/i }).click();
    const searchBox = page.locator("#jinja-widget-filter-search");
    await searchBox.waitFor({ timeout: 5000 });

    // Before searching, both "upper" and "join" should be present.
    await expect(page.locator(".jinja-filter-item-name", { hasText: "upper" })).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".jinja-filter-item-name", { hasText: "join" })).toBeVisible({ timeout: 3000 });

    // Type character by character to trigger Angular's ng-change handler which
    // calls rebuildFilterGroups(). fill() dispatches events in a way that
    // AngularJS doesn't pick up for ng-change.
    await searchBox.pressSequentially("upper");

    // After typing, only upper should remain; join is in a different category
    // and doesn't match "upper" in name, description, or category.
    await expect(page.locator(".jinja-filter-item-name", { hasText: "upper" })).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".jinja-filter-item-name", { hasText: "join" })).not.toBeVisible({ timeout: 3000 });

    // Clearing restores the full list.
    await searchBox.clear();
    await searchBox.press("Backspace"); // ensure ng-change fires on clear
    await expect(page.locator(".jinja-filter-item-name", { hasText: "join" })).toBeVisible({ timeout: 3000 });
  });

  test("Escape key closes the palette", async ({ page }) => {
    await page.getByRole("button", { name: /filter/i }).click();
    await page.locator("#jinja-widget-filter-search").waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#jinja-widget-filter-search")).not.toBeVisible({ timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// View Panel context — Load current record
// ---------------------------------------------------------------------------
test.describe("view panel context", () => {
  test("Load current record button appears in viewpanel context", async ({ page }) => {
    // Pre-set localStorage so harness reads viewpanel context at bootstrap time.
    await page.addInitScript(() => {
      localStorage.setItem("harness.ctx", "viewpanel");
    });
    await setupPage(page);
    await selectWidget(page);
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: /load current record/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Format Input button
// ---------------------------------------------------------------------------
test.describe("format input", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
  });

  test("Format JSON button is visible", async ({ page }) => {
    await expect(page.getByRole("button", { name: /format json/i })).toBeVisible();
  });

  test("Format JSON button prettifies the input JSON", async ({ page }) => {
    // The controller initialises inputJsonText with JSON.stringify(obj, null, 2),
    // which the monacoEditor directive passes as the initial editor value.
    // Clicking Format JSON re-formats whatever the editor holds and writes back
    // to inputJsonText. Verify the result is valid, well-formed JSON.
    await page.getByRole("button", { name: /format json/i }).click();

    const formatted = await page.evaluate(() => {
      const el = document.querySelector("[ng-controller]");
      return angular.element(el).scope().inputJsonText;
    });
    expect(formatted).toContain("\n");
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  test("Format JSON shows a warning toaster for malformed JSON", async ({ page }) => {
    // The editor's _val is a closure var inside the directive link function.
    // We expose editors by language via window.__monacoEditors in the Monaco
    // stub so we can directly patch the json editor's getValue() return value.
    await page.evaluate(() => {
      var ed = window.__monacoEditors && window.__monacoEditors["json"];
      if (ed) ed._val = "{ bad json }";
    });

    await page.getByRole("button", { name: /format json/i }).click();

    await expect(page.locator(".harness-toast-warning")).toBeVisible({ timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Template examples dropdown
// ---------------------------------------------------------------------------
test.describe("template examples", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
  });

  test("example dropdown is visible with placeholder option", async ({ page }) => {
    const picker = page.locator(".jinja-example-picker");
    await expect(picker).toBeVisible();
    const placeholder = await picker.locator("option[value='']").textContent();
    expect(placeholder).toMatch(/insert example/i);
  });

  test("selecting an example sets templateText and inputJsonText on the scope", async ({ page }) => {
    const picker = page.locator(".jinja-example-picker");
    // Select the first non-placeholder option.
    const options = await picker.locator("option[value]:not([value=''])").all();
    expect(options.length).toBeGreaterThan(0);
    const exampleId = await options[0].getAttribute("value");
    await picker.selectOption({ value: exampleId });

    // Angular applies the example via ng-change -> applyExample().
    const { templateText, inputJsonText } = await page.evaluate(() => {
      const scope = angular.element(document.querySelector("[ng-controller]")).scope();
      return { templateText: scope.templateText, inputJsonText: scope.inputJsonText };
    });
    expect(templateText.length).toBeGreaterThan(0);
    expect(inputJsonText.length).toBeGreaterThan(0);
  });

  test("applying an example clears the output pane", async ({ page }) => {
    // Put something in the output first.
    await page.evaluate(() => {
      const scope = angular.element(document.querySelector("[ng-controller]")).scope();
      scope.$apply(function () { scope.output = "stale result"; });
    });

    const picker = page.locator(".jinja-example-picker");
    const options = await picker.locator("option[value]:not([value=''])").all();
    const exampleId = await options[0].getAttribute("value");
    await picker.selectOption({ value: exampleId });

    const output = await page.evaluate(() => {
      return angular.element(document.querySelector("[ng-controller]")).scope().output;
    });
    expect(output == null || output === "").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filter palette — insert filter into template
// ---------------------------------------------------------------------------
test.describe("filter palette insertion", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
  });

  test("clicking a filter item closes the palette", async ({ page }) => {
    await setTemplate(page, "Hello");
    await page.getByRole("button", { name: /filter/i }).click();
    await page.locator("#jinja-widget-filter-search").waitFor({ timeout: 5000 });

    await page.locator(".jinja-filter-item", { hasText: "upper" }).first().click();

    await expect(page.locator("#jinja-widget-filter-search")).not.toBeVisible({ timeout: 3000 });
  });

  test("clicking a filter item updates the template text", async ({ page }) => {
    await page.getByRole("button", { name: /filter/i }).click();
    await page.locator("#jinja-widget-filter-search").waitFor({ timeout: 5000 });

    // ng-repeat re-renders during palette open; wait for the count to settle
    // before clicking so the element doesn't detach mid-action.
    const item = page.locator(".jinja-filter-item", { hasText: "upper" }).first();
    await item.waitFor({ state: "visible", timeout: 5000 });
    await page.waitForTimeout(100);
    await item.click();

    // insertFilter calls templateEditor.executeEdits() which in the stub appends
    // the snippet text to _val. Check the jinja editor's _val directly — this
    // avoids the ng-include scope chain issue where two-way binding writes to the
    // child scope, not the controller scope that templateText reads from.
    const editorVal = await page.evaluate(() => {
      var ed = window.__monacoEditors && window.__monacoEditors["jinja"];
      return ed ? ed._val : null;
    });
    expect(editorVal).toContain("upper");
  });
});

// ---------------------------------------------------------------------------
// Output pane — object result rendered as JSON
// ---------------------------------------------------------------------------
test.describe("output pane", () => {
  test("output displays in the JSON Monaco pane when result is an object", async ({ page }) => {
    await setupPage(page, { jinaResult: { key: "value" } });
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();

    // Object output -> JSON tab is auto-selected; raw textarea is hidden.
    await expect(page.locator("#jinja-widget-output-json")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#jinja-widget-output")).not.toBeVisible();
  });

  test("HTML output auto-selects the HTML tab and renders into a sandboxed iframe", async ({ page }) => {
    await setupPage(page, { jinaResult: "<table><tr><td>Ada</td></tr></table>" });
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();

    // Wait for the controller's output-kind detection to actually flip to
    // 'html' before asserting on the iframe — under serial runs the eval
    // request takes longer to settle and a fixed wait races the digest.
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-ng-controller*='jinjaEditorWidget']") ||
                 document.querySelector("[ng-controller*='jinjaEditorWidget']");
      const s = el && angular.element(el).scope();
      return s && s.resolveOutputTab && s.resolveOutputTab() === "html";
    }, null, { timeout: 20000 });
    const frame = page.locator(".jinja-html-preview-frame");
    await expect(frame).toBeVisible({ timeout: 15000 });
    // Empty sandbox attribute = no scripts, no same-origin, no form, no popups.
    await expect(frame).toHaveAttribute("sandbox", "");
    // contentDocument is unreadable from the parent (sandbox isolation), so
    // verify the rendered HTML through the srcdoc attribute the directive set.
    const srcdoc = await frame.getAttribute("srcdoc");
    expect(srcdoc).toContain("<table>");
    expect(srcdoc).toContain("Ada");
    // Parent page stylesheets are mirrored into the preview <head>.
    expect(srcdoc).toContain('<link rel="stylesheet"');
  });

  test("output textarea gets error-border class when render fails", async ({ page }) => {
    await setupPage(page);
    // Override the Jinja route to return a 500.
    await page.route("**/api/wf/api/jinja-editor/**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) })
    );
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();

    await expect(page.locator("#jinja-widget-output.has-error-border")).toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Context switching — View Panel, Drawer, record fetch, edit modal
// ---------------------------------------------------------------------------
test.describe("context contexts", () => {
  test("dashboard is the default context (no record header)", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    const frame = page.locator("#harness-frame");
    await expect(frame).toHaveClass(/ctx-dashboard/);
    await expect(page.locator("#record-header")).toBeHidden();
  });

  test("View Panel: switching context applies wrapper class and surfaces module/id inputs", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#ctx").selectOption("viewpanel");
    await expect(page.locator("#harness-frame")).toHaveClass(/ctx-viewpanel/);
    await expect(page.locator("#vp-fields")).toBeVisible();
  });

  test("View Panel: filling module/id triggers a record fetch with the right URL", async ({ page }) => {
    await setupPage(page);
    // Re-route AFTER setupPage so this handler wins (Playwright route registration is LIFO).
    let lastUrl = null;
    await page.route(/\/api\/3\/(?!solutionpacks)/, (route) => {
      const url = route.request().url();
      // Only capture the per-record fetch — other /api/3/* requests
      // (model_metadatas, picklists) fire concurrently and would otherwise
      // overwrite this assertion target.
      if (/\/api\/3\/alerts\//.test(url)) lastUrl = url;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "abc-123", name: "Suspicious login" }),
      });
    });
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#ctx").selectOption("viewpanel");
    await page.locator("#vp-module").fill("alerts");
    await page.locator("#vp-id").fill("abc-123");
    await page.locator("#vp-id").press("Tab");

    await expect(page.locator("#record-header")).toContainText("Suspicious login", { timeout: 10000 });
    expect(lastUrl).toMatch(/\/api\/3\/alerts\/abc-123\?\$relationships=true$/);
  });

  test("View Panel: empty module/id surfaces a 'no record loaded' message", async ({ page }) => {
    await setupPage(page);
    // Force empty id via localStorage + reload so prior test runs don't leak in.
    await page.evaluate(() => {
      localStorage.setItem("harness.id", "");
      localStorage.setItem("harness.module", "alerts");
    });
    await page.reload();
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#ctx").selectOption("viewpanel");
    await expect(page.locator("#record-header .err")).toContainText("no record loaded", { timeout: 5000 });
  });

  test("Drawer: applies ctx-drawer wrapper", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#ctx").selectOption("drawer");
    await expect(page.locator("#harness-frame")).toHaveClass(/ctx-drawer/);
  });
});

// ---------------------------------------------------------------------------
// Edit-config modal
// ---------------------------------------------------------------------------
test.describe("edit modal", () => {
  test("Edit config button opens the modal and loads the edit form", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#edit-config").click();
    await expect(page.locator("#edit-modal-backdrop.open")).toBeVisible({ timeout: 5000 });
    // ng-include resolves async; wait for the title input the edit.html declares.
    await expect(page.locator("#edit-modal-body #jinja-widget-title")).toBeVisible({ timeout: 10000 });
  });

  test("Cancel closes the modal without persisting config", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#edit-config").click();
    await expect(page.locator("#edit-modal-backdrop.open")).toBeVisible({ timeout: 5000 });
    await page.locator("#edit-modal-cancel").click();
    await expect(page.locator("#edit-modal-backdrop.open")).toBeHidden();
    // No config key written.
    const stored = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("harness:config:"));
      return keys.length;
    });
    expect(stored).toBe(0);
  });

  test("Save persists $scope.config to localStorage and re-mounts the widget", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);
    await page.locator("#edit-config").click();
    await expect(page.locator("#edit-modal-backdrop.open")).toBeVisible({ timeout: 5000 });
    // Inner edit.html template loads async after the backdrop appears; wait
    // for the controller wrap to mount before reaching into its scope.
    await page.locator("#edit-modal-body > [ng-controller]").waitFor({ state: "attached", timeout: 5000 });

    // Force a known shape onto the edit scope so the save path has something
    // to snapshot — independent of whatever the real edit controller does.
    await page.evaluate(() => {
      const wrap = document.querySelector("#edit-modal-body > [ng-controller]");
      if (!wrap) throw new Error("edit wrap not present");
      const scope = angular.element(wrap.firstChild || wrap).scope() || angular.element(wrap).scope();
      scope.$apply(() => { scope.config = { title: "from-test", probe: 42 }; });
    });

    await page.locator("#edit-modal-save").click();
    await expect(page.locator("#edit-modal-backdrop.open")).toBeHidden({ timeout: 5000 });

    const saved = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith("harness:config:"));
      return k ? JSON.parse(localStorage.getItem(k)) : null;
    });
    expect(saved).toMatchObject({ title: "from-test", probe: 42 });

    // Widget remounts: container should still be there post-save.
    await expect(page.locator(".jinja-editor-widget")).toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Live squiggles — verify markers are set with messages and narrowed range
// ---------------------------------------------------------------------------
test.describe("live squiggles", () => {
  test("typing an unclosed expression sets a marker with hover message and narrowed range", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);

    // Type a broken template directly into the jinja editor and fire the
    // change handler the controller subscribed via onDidChangeModelContent.
    await page.evaluate(() => {
      const ed = window.__monacoEditors && window.__monacoEditors["jinja"];
      if (!ed) throw new Error("jinja editor not present");
      ed._typeValue("Name:    {{ vars.input.records[0].name");
    });

    // Live scan is debounced 600ms inside the controller.
    await page.waitForFunction(
      () => {
        const m = window.__monacoMarkers && window.__monacoMarkers["jinja-render"];
        return m && m.length > 0;
      },
      null,
      { timeout: 5000 }
    );

    const markers = await page.evaluate(() => window.__monacoMarkers["jinja-render"]);
    const unclosed = markers.find((m) => /unclosed expression/i.test(m.message));
    expect(unclosed).toBeDefined();
    // Message is the hover text Monaco renders on the squiggle.
    expect(unclosed.message).toMatch(/unclosed expression/i);
    // Range narrowed to the {{ … span (col 10 = position of `{{`), not the
    // whole "Name:    {{ …" line.
    expect(unclosed.startColumn).toBe(10);
    expect(unclosed.endColumn).toBe("Name:    {{ vars.input.records[0].name".length + 1);
  });

  test("fixing the template clears the markers", async ({ page }) => {
    await setupPage(page);
    await selectWidget(page);
    await waitForWidgetReady(page);

    await page.evaluate(() => {
      window.__monacoEditors["jinja"]._typeValue("{{ vars.x");
    });
    await page.waitForFunction(
      () => (window.__monacoMarkers["jinja-render"] || []).length > 0,
      null,
      { timeout: 5000 }
    );

    await page.evaluate(() => {
      // Provide an input so path-existence check also resolves.
      const scope = angular.element(document.querySelector("[ng-controller]")).scope();
      scope.$apply(() => { scope.inputJsonText = '{"vars":{"x":1}}'; });
      window.__monacoEditors["jinja"]._typeValue("{{ vars.x }}");
    });

    await page.waitForFunction(
      () => (window.__monacoMarkers["jinja-render"] || []).length === 0,
      null,
      { timeout: 5000 }
    );
    const markers = await page.evaluate(() => window.__monacoMarkers["jinja-render"]);
    expect(markers).toEqual([]);
  });
});
