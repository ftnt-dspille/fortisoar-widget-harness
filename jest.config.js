"use strict";

const fs = require("fs");
const path = require("path");

// Discovery roots — merge the user's widget root with the harness's bundled
// examples/ so the example's tests run in the monorepo AND a clone, and even
// when WIDGETS_SRC is pinned (via .env or the Makefile). Mirrors server.js.
function widgetRoots() {
  const roots = [];
  if (process.env.WIDGETS_SRC) roots.push(path.resolve(process.env.WIDGETS_SRC));
  else roots.push(path.resolve(__dirname, "widgets-src")); // false-existsSync for a dangling symlink
  roots.push(path.resolve(__dirname, "examples"));
  return [...new Set(roots)].filter((p) => fs.existsSync(p));
}
const WIDGET_ROOTS = widgetRoots();

// All widget dirs (across every root) that carry a tests/ folder, as
// { name, dir } — the candidate set for the WIDGET filter.
function testableWidgets() {
  const out = [];
  for (const root of WIDGET_ROOTS) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (fs.existsSync(path.join(dir, "tests"))) out.push({ name: e.name, dir });
    }
  }
  return out;
}

// Each widget repo under WIDGETS_SRC can contribute its own Jest project so the
// harness owns the test runtime (jest, jsdom, angular, angular-mocks). Widget
// repos can stay lean -- no devDependencies required for their unit tests.
//
// Widget projects are OPT-IN, never an implicit cross-widget sweep:
//   WIDGET unset                 -> harness only (the default)
//   WIDGET=fsrPlaybookBuilder    -> harness + that widget
//   WIDGET=c3charts,funnelchart  -> harness + those widgets (comma list)
//   WIDGET=all                   -> harness + every widget with a tests/ dir
// The Makefile forwards `make test-unit WIDGET=...` into this env var.
const WIDGET_FILTER = (process.env.WIDGET || "").trim();

function discoverWidgetProjects() {
  if (!WIDGET_FILTER) return []; // default: don't fan out across siblings

  const wantAll = WIDGET_FILTER === "all";
  const wanted = new Set(
    WIDGET_FILTER.split(",").map((s) => s.trim()).filter(Boolean)
  );

  return testableWidgets()
    .filter(({ name }) => wantAll || wanted.has(name))
    .map(({ dir }) => {
      // Prefer the widget's own jest.config.js so it controls testEnvironment
      // / testMatch; fall back to a sane jsdom default. testEnvironmentOptions
      // defaults to {} because jest-environment-jsdom@29 reads `.html` off it
      // at construction -- a bare `undefined` crashes the environment.
      const cfgPath = path.join(dir, "jest.config.js");
      const widgetCfg = fs.existsSync(cfgPath) ? require(cfgPath) : {};
      return {
        displayName: path.basename(dir),
        rootDir: dir,
        testEnvironment: widgetCfg.testEnvironment || "jsdom",
        testEnvironmentOptions: widgetCfg.testEnvironmentOptions || {},
        testMatch: widgetCfg.testMatch || ["<rootDir>/tests/**/*.test.js"],
        // Let widget tests resolve angular / angular-mocks from the harness's
        // node_modules so the widget repo doesn't need its own copy.
        moduleDirectories: [
          "node_modules",
          path.resolve(__dirname, "node_modules"),
        ],
      };
    });
}

// Fail loudly on a typo'd WIDGET name rather than silently running harness only.
if (WIDGET_FILTER && WIDGET_FILTER !== "all") {
  const have = new Set(testableWidgets().map((w) => w.name));
  const missing = WIDGET_FILTER.split(",")
    .map((s) => s.trim())
    .filter((s) => s && !have.has(s));
  if (missing.length) {
    throw new Error(
      `WIDGET=${WIDGET_FILTER}: no test project for [${missing.join(", ")}]. ` +
        `Widgets with a tests/ dir: ${[...have].sort().join(", ") || "(none)"}.`
    );
  }
}

module.exports = {
  projects: [
    {
      displayName: "harness",
      rootDir: __dirname,
      testEnvironment: "node",
      testMatch: ["<rootDir>/tests/**/*.test.js"],
      testPathIgnorePatterns: ["<rootDir>/tests/e2e/"],
    },
    ...discoverWidgetProjects(),
  ],
};
