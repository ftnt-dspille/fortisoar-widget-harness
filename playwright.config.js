"use strict";
// Load .env at config-time so FORTISOAR_HOST/USERNAME/PASSWORD/WIDGETS_SRC
// can come from the same .env file the dev server uses. Tests that mock
// /api/3 routes still pass with stub creds; tests that hit real SOAR will
// use the credentials from .env if present.
require("dotenv").config();
const { defineConfig, devices } = require("@playwright/test");

// Discover specs both in the harness's own tests/e2e/ AND in each widget's
// tests/e2e/ folder, so per-widget regression tests live alongside the
// widget source they exercise.
module.exports = defineConfig({
  testDir: "..",
  testMatch: [
    "fortisoar-widget-harness/tests/e2e/**/*.spec.js",
    "widgets-src/*/tests/e2e/**/*.spec.js",
  ],
  timeout: 60000,
  // One retry covers genuine timing-flake (ng-repeat re-renders mid-click,
  // digest-queue pileups under serial load) without masking real failures
  // — a real bug fails twice. trace:'on-first-retry' below means the retry
  // produces a full trace artifact for diagnosis when something does flake
  // repeatedly.
  retries: 1,
  reporter: "list",
  // Tests run against a dedicated harness on port 4401 so they never collide
  // with a developer's `pnpm start` on 4400. Each test invocation boots its
  // own server; reuseExistingServer:true skips the boot only if 4401 is
  // already serving (e.g. a previous test run left it running, or you have
  // another playwright watch running).
  use: {
    baseURL: "http://localhost:4401",
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
    url: "http://localhost:4401",
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      FORTISOAR_HOST: process.env.FORTISOAR_HOST || "https://soar.test.invalid",
      FORTISOAR_USERNAME: process.env.FORTISOAR_USERNAME || "admin",
      FORTISOAR_PASSWORD: process.env.FORTISOAR_PASSWORD || "test",
      WIDGETS_SRC: process.env.WIDGETS_SRC || "",
      PORT: "4401",
    },
  },
});
