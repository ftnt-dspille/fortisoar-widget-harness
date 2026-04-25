"use strict";
// E2E tests for the dev harness UI.
// The harness server is started automatically by Playwright (see playwright.config.js).
// API calls to /api/** and Monaco assets are intercepted so no real SOAR is needed.

const { test, expect } = require("@playwright/test");

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
    var editor = {
      _val: val,
      getValue: function() { return this._val; },
      setValue: function(v) { this._val = v; },
      getModel: function() { return { getLanguageId: function() { return (opts && opts.language) || 'text'; } }; },
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
    },
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

    await page.locator(".jinja-filter-item", { hasText: "upper" }).first().click();

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
  test("output displays as formatted JSON when result is an object", async ({ page }) => {
    await setupPage(page, { jinaResult: { key: "value" } });
    await selectWidget(page);
    await waitForWidgetReady(page);
    await setTemplate(page);
    await page.locator(".render-btn").click();

    // When output is an object, the view uses a <pre> with the json filter,
    // not the textarea.
    await expect(page.locator(".output-area pre")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#jinja-widget-output")).not.toBeVisible();
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
