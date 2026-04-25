"use strict";
// Load .env at config-time so FORTISOAR_HOST/USERNAME/PASSWORD/WIDGETS_SRC
// can come from the same .env file the dev server uses. Tests that mock
// /api/3 routes still pass with stub creds; tests that hit real SOAR will
// use the credentials from .env if present.
require("dotenv").config();
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4400",
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
    url: "http://localhost:4400",
    reuseExistingServer: !process.env.CI,
    env: {
      FORTISOAR_HOST: process.env.FORTISOAR_HOST || "https://soar.test.invalid",
      FORTISOAR_USERNAME: process.env.FORTISOAR_USERNAME || "admin",
      FORTISOAR_PASSWORD: process.env.FORTISOAR_PASSWORD || "test",
      WIDGETS_SRC: process.env.WIDGETS_SRC || "",
      PORT: "4400",
    },
  },
});
