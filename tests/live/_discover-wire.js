// L0 spike: drive the installed widget in ?mode=live and capture the exact
// connector-execute REST request it sends (URL + method + body). This grounds
// the live-integration test layer in the real wire instead of guessed shapes.
// Run from the harness dir:  node tests/live/_discover-wire.js
require("dotenv").config();
const { chromium } = require("@playwright/test");
const { resolveSoarEnv } = require("../../lib/soarEnv");
const { host: HOST, user: USER, pass: PASS } = resolveSoarEnv();
const ALERT = process.env.FSR_PROBE_ALERT_IRI || process.env.FORTISOAR_PROBE_ALERT_IRI || "db7afbf7-56c8-4706-87b9-9a8ce2332d05";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  const captured = [];
  const allPosts = [];
  page.on("request", (req) => {
    const u = req.url();
    const body = req.postData() || "";
    if (req.method() === "POST" && /\/api\//.test(u)) allPosts.push(u.replace(HOST, ""));
    if (/\/api\/integration\//i.test(u) || /chat_turn|operation|connector/i.test(body)) {
      captured.push({ method: req.method(), url: u, body: body });
    }
  });
  // SOAR chrome emits a bogus "Failed to set referrer policy" on every load —
  // pure noise, never from our widget. Filter it out.
  const CONSOLE_IGNORE = [/Failed to set referrer policy/i];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (CONSOLE_IGNORE.some((re) => re.test(t))) return;
    console.log("CONSOLE-ERR:", t.slice(0, 200));
  });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));

  // login
  await page.goto(`${HOST}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="text"]', USER);
  await page.fill('input[name="password"], input[type="password"]', PASS);
  await page.click('button[type="submit"], button:has-text("Log In"), button:has-text("Login")');
  await page.waitForFunction(() => !/\/login(?:[?#]|$)/.test(window.location.pathname), { timeout: 30000 });
  await page.waitForTimeout(1500);

  // alert in LIVE mode
  const url = `${HOST}/modules/view-panel/alerts/${ALERT}?mode=live`;
  console.log("→ opening (live):", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Wait for SOAR splash to clear + a right-edge drawer button to mount
  // (same gate verify-remote uses).
  await page
    .waitForFunction(() => {
      if (document.body.innerText.includes("Loading...")) return false;
      const vw = window.innerWidth;
      for (const b of document.querySelectorAll("button, a, [role=button]")) {
        const r = b.getBoundingClientRect();
        if (r.x > vw - 80 && r.width < 80 && r.height < 80 && r.width > 0) return true;
      }
      return false;
    }, { timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(2000);

  // open the widget drawer (try the same selectors verify-remote uses)
  const rootSel = '[data-testid="fsr-pb-root"]';
  const triggers = [
    '.sub-block[data-ng-click*="launchWidget"]:has(img[title="FSR Playbook Builder"])',
    '.sub-block[data-ng-click*="launchWidget"]:has(img[alt="FSR Playbook Builder"])',
    '.sub-block[data-ng-click*="launchWidget"]:has(img[title*="Playbook" i])',
  ];
  if (!(await page.$(rootSel))) {
    for (const sel of triggers) {
      const trigger = await page.$(sel).catch(() => null);
      if (!trigger) continue;
      await trigger.click({ force: true }).catch(() => {});
      await page.waitForSelector(rootSel, { timeout: 8000 }).catch(() => {});
      if (await page.$(rootSel)) break;
    }
  }
  console.log("widget root present:", !!(await page.$(rootSel)));

  // send a message → triggers chat_turn against the LIVE connector
  const input = await page.$('[data-testid="chat-input"]');
  if (input && !(await input.evaluate(el => el.hasAttribute("disabled")))) {
    await input.fill("hello");
    await page.click('[data-testid="chat-send"]');
    console.log("→ sent message; waiting for connector-execute request…");
    await page.waitForTimeout(10000);
  } else {
    console.log("chat-input missing/disabled — mode=live may not have engaged");
  }

  // post-send widget state
  const state = await page.$eval(rootSel, el => el.getAttribute("data-state")).catch(() => "?");
  const err = await page.$eval('[data-testid="error-banner"]', el => el.textContent.trim()).catch(() => null);
  const resolvedMode = await page.evaluate(() => window.__fsrPbMode__ || null).catch(() => null);
  console.log(`\nwidget state=${state} errorBanner=${err || "(none)"} resolvedMode=${resolvedMode || "(unknown)"}`);
  console.log("ALL /api POSTs during run:", JSON.stringify([...new Set(allPosts)], null, 2));

  console.log("\n=== CAPTURED CONNECTOR-EXECUTE REQUESTS (" + captured.length + ") ===");
  for (const c of captured) {
    console.log(c.method, c.url);
    if (c.body) console.log("BODY:", c.body.slice(0, 1500));
    console.log("---");
  }
  await browser.close();
})();
