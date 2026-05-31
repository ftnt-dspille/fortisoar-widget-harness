"use strict";

const fs = require("fs");
const path = require("path");

const WIDGETS_SRC = process.env.WIDGETS_SRC
  ? path.resolve(process.env.WIDGETS_SRC)
  : path.resolve(__dirname, "widgets-src");

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
  if (!fs.existsSync(WIDGETS_SRC)) return [];

  const wantAll = WIDGET_FILTER === "all";
  const wanted = new Set(
    WIDGET_FILTER.split(",").map((s) => s.trim()).filter(Boolean)
  );

  return fs
    .readdirSync(WIDGETS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(WIDGETS_SRC, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "tests")))
    .filter((dir) => wantAll || wanted.has(path.basename(dir)))
    .map((dir) => {
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
if (WIDGET_FILTER && WIDGET_FILTER !== "all" && fs.existsSync(WIDGETS_SRC)) {
  const have = new Set(
    fs
      .readdirSync(WIDGETS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(WIDGETS_SRC, e.name, "tests")))
      .map((e) => e.name)
  );
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
