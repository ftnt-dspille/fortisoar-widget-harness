"use strict";

const fs = require("fs");
const path = require("path");

const WIDGETS_SRC = process.env.WIDGETS_SRC
  ? path.resolve(process.env.WIDGETS_SRC)
  : path.resolve(__dirname, "widgets-src");

// Each widget repo under WIDGETS_SRC contributes its own Jest project so the
// harness owns the test runtime (jest, jsdom, angular, angular-mocks). Widget
// repos can stay lean -- no devDependencies required for their unit tests.
function discoverWidgetProjects() {
  if (!fs.existsSync(WIDGETS_SRC)) return [];
  return fs
    .readdirSync(WIDGETS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(WIDGETS_SRC, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "tests")))
    .map((dir) => {
      // Prefer the widget's own jest.config.js so it controls testEnvironment
      // / testMatch; fall back to a sane jsdom default.
      const cfgPath = path.join(dir, "jest.config.js");
      const widgetCfg = fs.existsSync(cfgPath) ? require(cfgPath) : {};
      return {
        displayName: path.basename(dir),
        rootDir: dir,
        testEnvironment: widgetCfg.testEnvironment || "jsdom",
        testEnvironmentOptions: widgetCfg.testEnvironmentOptions,
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
