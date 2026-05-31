// Live connector-integration test config. Standalone (NOT part of the default
// `npm test` projects) so the offline suite stays fast and free.
//
//   FSRPB_LIVE=1 npm run test:live
//
// Requires FSR_BASE_URL / FSR_USERNAME / FSR_PASSWORD in .env (the live demo SOAR).
// CI-shaped: long timeout for real exec/LLM calls, JUnit output when the
// jest-junit reporter is available (optional dep; falls back to default).
"use strict";

let reporters = ["default"];
try {
  require.resolve("jest-junit");
  reporters = ["default", ["jest-junit", { outputDirectory: "test-results/live", outputName: "junit.xml" }]];
} catch (_) { /* jest-junit not installed; default reporter only */ }

module.exports = {
  rootDir: ".",
  testMatch: ["<rootDir>/tests/live/**/*.live.test.js"],
  testEnvironment: "node",
  testTimeout: 180000,
  maxWorkers: 1, // serialize: shared live SOAR, avoid cross-talk + rate limits
  reporters,
  setupFiles: ["<rootDir>/tests/live/setup.js"],
};
