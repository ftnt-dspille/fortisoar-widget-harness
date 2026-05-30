// Generic remote-verification driver. Logs into a live SOAR, opens an alert
// view-panel, opens the right-drawer, asserts the widget root renders, then
// runs the widget's own remote.spec.js (if it has one).
//
// Each widget can ship a probe at:
//     widgets-src/<id>/widget/remote.probe.js
// which exports `async function probe({ page, expect, helpers })`. If the
// file is absent, only the generic open-and-render check is done.

"use strict";

const path = require("path");
const fs = require("fs");
const { chromium } = require("@playwright/test");

// Resolve the most-recent alert's UUID via the SOAR REST API. Authenticates
// with the same loginid/password used for the UI, then pulls one alert ordered
// by newest. Returns the bare UUID, or null if none/auth failed.
async function pickRecentAlertId(ctx, host, user, pass, log) {
  try {
    const authResp = await ctx.request.post(`${host}/auth/authenticate`, {
      headers: { "Content-Type": "application/json" },
      data: { credentials: { loginid: user, password: pass } },
      timeout: 20000,
    });
    if (!authResp.ok()) { log(`  auth ${authResp.status()} — cannot query alerts`); return null; }
    const token = (await authResp.json()).token;
    if (!token) { log("  auth returned no token"); return null; }

    const listResp = await ctx.request.get(
      `${host}/api/3/alerts?$limit=1&$orderby=-createDate`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
    );
    if (!listResp.ok()) { log(`  alerts query ${listResp.status()}`); return null; }
    const body = await listResp.json();
    const members = body["hydra:member"] || body.member || [];
    const iri = members[0] && members[0]["@id"];
    if (!iri) return null;
    const m = iri.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (m) log(`  picked alert ${iri}`);
    return m ? m[1] : null;
  } catch (e) {
    log(`  alert lookup failed: ${e.message}`);
    return null;
  }
}

async function run(opts) {
  const {
    host, user, pass, alert, widgetDir, widgetName, widgetId, outDir,
  } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const logLines = [];
  const log = (m) => { console.log("  " + m); logLines.push(m); };

  const browser = await chromium.launch({ headless: true });
  // Same TLS allowance as the existing harness probe — SOAR dev appliances
  // ship self-signed certs. CI against a properly-signed instance can drop
  // this by trusting the cert at the OS level.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  // Noisy console messages SOAR's chrome emits on every page load — they
  // aren't from our widget and just bury the real signal.
  const CONSOLE_IGNORE = [
    /Failed to set referrer policy/i,
  ];
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = msg.text();
    if (CONSOLE_IGNORE.some((re) => re.test(text))) return;
    log(`CONSOLE[${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => log(`PAGEERROR ${err.message}`));
  page.on("response", (resp) => {
    const u = resp.url();
    if (resp.status() >= 400 && (u.includes("/api/") || u.includes(widgetName))) {
      log(`HTTP ${resp.status()} ${resp.request().method()} ${u}`);
    }
  });

  let checksRun = 0;
  let result = { ok: true, error: null, outDir };

  try {
    // ─── login ───────────────────────────────────────────────────────────
    log(`→ login ${host}`);
    await page.goto(`${host}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 15000 });
    await page.fill('input[name="username"], input[type="text"]', user);
    await page.fill('input[name="password"], input[type="password"]', pass);
    await page.click('button[type="submit"], button:has-text("Log In"), button:has-text("Login")');
    // SOAR's networkidle never settles (it polls), so wait on a concrete
    // signal instead: URL leaves /login. Generous timeout because the post-
    // login redirect dashboard takes a moment to render.
    await page.waitForFunction(() => !/\/login(?:[?#]|$)/.test(window.location.pathname), { timeout: 30000 });
    await page.waitForTimeout(2000);
    checksRun++;

    // ─── open alert ──────────────────────────────────────────────────────
    let alertUrl;
    if (alert) {
      // Accept any of: full URL, "/api/3/alerts/<uuid>", "alerts/<uuid>",
      // or bare "<uuid>". The view-panel route only wants the UUID.
      let alertId = alert;
      if (alertId.startsWith("http")) {
        alertUrl = alertId;
      } else {
        const m = alertId.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (m) alertId = m[1];
        alertUrl = `${host}/modules/view-panel/alerts/${alertId}`;
      }
      // Append the mock query param if the caller (or a widget probe) opted
      // in. Widgets that read `?mock=` from window.location.search will
      // bypass the live backend and use fixtures — necessary to exercise
      // card layouts that only render after a chat turn.
      const mockScenario = opts.mock || process.env.FORTISOAR_PROBE_MOCK;
      if (mockScenario) {
        const sep = alertUrl.includes("?") ? "&" : "?";
        alertUrl += sep + "mock=" + encodeURIComponent(mockScenario);
      }
    } else {
      // No --alert given: ask the API for the most recent alert. This is far
      // more reliable than scraping the list DOM (which depends on the grid
      // having rendered and a stable anchor selector). Uses the same creds as
      // the UI login; ctx.request inherits the context's ignoreHTTPSErrors.
      log("→ no --alert given; querying API for the most recent alert");
      const alertId = await pickRecentAlertId(ctx, host, user, pass, log);
      if (!alertId) throw new Error("API returned no alerts to verify against");
      alertUrl = `${host}/modules/view-panel/alerts/${alertId}`;
    }
    log(`→ alert ${alertUrl}`);
    await page.goto(alertUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Wait for SOAR's "Loading…" splash to clear AND for at least one
    // right-edge drawer button to be in the DOM. Without the second check
    // the splash hides before the drawer trigger mounts, and we click into
    // dead space.
    await page
      .waitForFunction(() => {
        const splash = document.body.innerText.includes("Loading...");
        if (splash) return false;
        const buttons = document.querySelectorAll("button, a, [role=button]");
        const vw = window.innerWidth;
        for (const b of buttons) {
          const r = b.getBoundingClientRect();
          if (r.x > vw - 80 && r.width < 80 && r.height < 80 && r.width > 0) return true;
        }
        return false;
      }, { timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(outDir, "01-alert.png") });
    checksRun++;

    // ─── open the widget's drawer ────────────────────────────────────────
    // SOAR renders each drawer widget as a `.sub-block` with
    // `data-ng-click="launchWidget(...)"` and a child <img> whose title
    // attribute is the widget's info.json `title`. Match on either the
    // widget's name or its display title — caller passes both.
    const rootSelector = widgetRootSelectorFor(widgetName);
    const titleAttr = opts.widgetTitle || widgetName;
    const triggerSelectors = [
      `.sub-block[data-ng-click*="launchWidget"]:has(img[title="${titleAttr}"])`,
      `.sub-block[data-ng-click*="launchWidget"]:has(img[alt="${titleAttr}"])`,
      `.sub-block[data-ng-click*="launchWidget"]:has(img[title*="${widgetName}" i])`,
    ];
    log(`→ opening drawer (looking for ${rootSelector})`);
    let drawerOpened = false;
    if (await page.$(rootSelector)) {
      drawerOpened = true; // already rendered
    } else {
      for (const sel of triggerSelectors) {
        const trigger = await page.$(sel).catch(() => null);
        if (!trigger) continue;
        log(`   clicking ${sel}`);
        await trigger.click({ force: true }).catch(() => {});
        await page.waitForSelector(rootSelector, { timeout: 8000 }).catch(() => {});
        if (await page.$(rootSelector)) { drawerOpened = true; break; }
      }
    }
    if (!drawerOpened) throw new Error(`widget root ${rootSelector} did not render after clicking any drawer trigger (tried: ${triggerSelectors.join(" | ")})`);
    await page.screenshot({ path: path.join(outDir, "02-drawer.png") });
    log("→ widget root visible");
    checksRun++;

    // ─── widget-specific probe ───────────────────────────────────────────
    const probePath = path.join(widgetDir, "remote.probe.js");
    if (fs.existsSync(probePath)) {
      log(`→ running widget-specific probe (${path.relative(process.cwd(), probePath)})`);
      const probe = require(probePath);
      const helpers = {
        screenshot: (name) => page.screenshot({ path: path.join(outDir, name) }),
        log,
      };
      await probe({ page, helpers, widgetId });
      checksRun++;
    } else {
      log("→ no remote.probe.js; skipping widget-specific assertions");
    }

  } catch (e) {
    result.ok = false;
    result.error = e.message || String(e);
    await page.screenshot({ path: path.join(outDir, "99-error.png") }).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(outDir, "log.txt"), logLines.join("\n"));
    await browser.close();
  }

  result.checksRun = checksRun;
  return result;
}

// Per-widget root testid map. Add an entry when you add a widget.
function widgetRootSelectorFor(widgetName) {
  const map = {
    fsrPlaybookBuilder: '[data-testid="fsr-pb-root"]',
  };
  return map[widgetName] || `[data-testid="${widgetName}-root"]`;
}

module.exports = { run };
