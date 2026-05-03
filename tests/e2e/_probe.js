"use strict";
// Reusable widget probe: drive a widget through a named scenario, then dump
// every console.error / unhandled rejection / Angular exception the harness
// captured (with creation-site stacks for $q rejections, thanks to the
// harness's $q decorator). Companion to _fixtures.js — use this when you
// want a single self-contained "open widget X, do thing Y, tell me what
// went wrong" run instead of writing a full spec.
//
// Usage:
//   const { probeWidget } = require("./_probe");
//   const report = await probeWidget(page, "c3Charts", async (page) => {
//     await page.locator("#edit-config").click();
//     await page.waitForSelector("#edit-modal-body");
//   });
//   expect(report.errors).toEqual([]);
//
// `report` is the snapshot from window.__harness.dump() merged with the
// Playwright-side console capture, so it covers both: drawer-buffer state
// (Angular exceptions, network) AND raw Playwright console events (which
// catch errors fired before the harness drawer mounts).

const fs = require("fs");
const path = require("path");

async function selectWidget(page, widgetName) {
  const select = page.locator("#widget-select");
  await select.waitFor({ state: "visible", timeout: 10000 });
  const resp = await page.request.get("/_fsr/widgets");
  const { widgets } = await resp.json();
  const w = widgets.find((x) => x.name === widgetName);
  if (!w) throw new Error("probeWidget: widget not found: " + widgetName);
  await select.selectOption({ value: w.id });
}

async function probeWidget(page, widgetName, scenario, opts) {
  opts = opts || {};
  const playwrightConsole = [];
  const playwrightErrors = [];
  page.on("console", (msg) => {
    playwrightConsole.push({ type: msg.type(), text: msg.text(), loc: msg.location() });
  });
  page.on("pageerror", (e) => {
    playwrightErrors.push({ message: e.message, stack: e.stack });
  });

  await page.goto(opts.path || "/", { waitUntil: "domcontentloaded" });
  await selectWidget(page, widgetName);
  // Selecting a widget re-bootstraps Angular which destroys the JS execution
  // context. Wait for the widget container to settle, then poll until
  // window.__harness is available again before clearing buffers.
  await page.locator("#widget-container [data-ng-controller], #widget-container [ng-controller]")
    .first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !!window.__harness, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { try { window.__harness && window.__harness.clear(); } catch (_) {} });

  let scenarioError = null;
  try { await scenario(page); }
  catch (e) { scenarioError = { message: e.message, stack: e.stack }; }

  // Let any trailing $digest / unhandledrejection settle.
  await page.waitForTimeout(opts.settleMs != null ? opts.settleMs : 1500);

  const dump = await page.evaluate(() => {
    if (!window.__harness) return null;
    return window.__harness.dump();
  });

  const report = {
    widget: widgetName,
    ts: Date.now(),
    scenarioError: scenarioError,
    drawer: dump,
    playwrightConsoleErrors: playwrightConsole.filter((m) => m.type === "error"),
    playwrightPageErrors: playwrightErrors,
  };

  if (opts.outFile) {
    fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
    fs.writeFileSync(opts.outFile, JSON.stringify(report, null, 2));
  }
  if (opts.screenshotPath) {
    await page.screenshot({ path: opts.screenshotPath, fullPage: true }).catch(() => {});
  }
  return report;
}

// Convenience: filter benign known-noisy errors out of a report so callers
// can `expect(meaningfulErrors(report)).toEqual([])`.
const BENIGN_PATTERNS = [
  /Refused to (load|connect|execute).*Content Security Policy/i,
  /importScripts/i,
  /Cannot read properties of undefined \(reading 'forEach'\).*app\.unmin\.js/s,
];
function meaningfulErrors(report) {
  const all = [];
  (report.drawer && report.drawer.errors || []).forEach((e) => all.push({ from: "drawer", ...e }));
  (report.playwrightConsoleErrors || []).forEach((e) => all.push({ from: "playwright-console", text: e.text }));
  (report.playwrightPageErrors || []).forEach((e) => all.push({ from: "playwright-pageerror", message: e.message, stack: e.stack }));
  return all.filter((e) => {
    const text = e.message || e.text || "";
    return !BENIGN_PATTERNS.some((re) => re.test(text));
  });
}

module.exports = { probeWidget, meaningfulErrors };
