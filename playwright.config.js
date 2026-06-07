"use strict";
// Load .env at config-time so FSR_BASE_URL/FSR_USERNAME/FSR_PASSWORD/WIDGETS_SRC
// can come from the same .env file the dev server uses. Tests that mock
// /api/3 routes still pass with stub creds; tests that hit real SOAR will
// use the credentials from .env if present.
require("dotenv").config();
const { defineConfig, devices } = require("@playwright/test");

// Discover specs both in the harness's own tests/e2e/ AND in each widget's
// tests/e2e/ folder, so per-widget regression tests live alongside the
// widget source they exercise.
module.exports = defineConfig({
  // testDir is the harness itself (not the monorepo parent) so a standalone
  // GitHub clone discovers specs too. widgets-src is the monorepo's symlink
  // when present; examples/ ships the bundled example spec for a fresh clone.
  testDir: __dirname,
  testMatch: [
    "tests/e2e/**/*.spec.js",
    "widgets-src/*/tests/e2e/**/*.spec.js",
    "examples/*/tests/e2e/**/*.spec.js",
  ],
  // By default the e2e suite runs FULLY LOCALLY against the mocked SOAR proxy —
  // no FortiSOAR login required. Specs whose filename contains "Live"/"live"
  // drive a real box and are excluded unless E2E_LIVE=1 (see `test:e2e:live`).
  testIgnore: process.env.E2E_LIVE ? [] : ["**/*[Ll]ive*.spec.js"],
  timeout: 45000,
  expect: { timeout: 10000 },
  // Two workers share one dev server and the widget boot (~15s wait) can starve
  // under contention, so a transient boot-timeout must retry rather than hard-
  // fail. `trace: "on-first-retry"` below captures the retried run.
  retries: process.env.CI ? 2 : 1,
  // 2 workers is the sweet spot: a single shared dev server serializes the heavy
  // per-test app-shell boot, so >2 workers over-saturate it and cause mass boot
  // timeouts (measured: 4 workers → 12 failed/14 flaky vs 2 workers → green).
  // Live runs go serial to avoid hammering the real box.
  workers: process.env.E2E_LIVE ? 1 : 2,
  fullyParallel: true,
  reporter: "list",
  // Tests run against a dedicated harness on port 14401 so they never collide
  // with a developer's `pnpm start` on 14400. Each test invocation boots its
  // own server; reuseExistingServer:true skips the boot only if 14401 is
  // already serving (e.g. a previous test run left it running, or you have
  // another playwright watch running).
  use: {
    baseURL: "http://localhost:14401",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node server.js",
    url: "http://localhost:14401",
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      FSR_BASE_URL: process.env.FSR_BASE_URL || process.env.FORTISOAR_HOST || "https://soar.test.invalid",
      FSR_USERNAME: process.env.FSR_USERNAME || process.env.FORTISOAR_USERNAME || "admin",
      FSR_PASSWORD: process.env.FSR_PASSWORD || process.env.FORTISOAR_PASSWORD || "test",
      WIDGETS_SRC: process.env.WIDGETS_SRC || "",
      PORT: "14401",
    },
  },
});
