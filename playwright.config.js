"use strict";
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
      PORT: "4400",
    },
  },
});
