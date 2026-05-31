'use strict';
// Ad-hoc diagnostic (NOT the playwright test runner): load the harness page,
// report console errors + whether external CDN scripts are reachable from the
// browser, then exit. Run: node tests/_diag_boot.js
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrs = [];
  const failed = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page.on('requestfailed', r => failed.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));

  // Direct fetch test from inside the browser context.
  await page.goto('http://localhost:14401/?widget=fsrPlaybookBuilder-1.0.30&context=Dashboard&mock=happy_path',
    { waitUntil: 'domcontentloaded' });

  const cdnProbe = await page.evaluate(async () => {
    const url = 'https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js';
    try {
      const r = await fetch(url, { method: 'GET' });
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  // Give boot a moment.
  await page.waitForTimeout(4000);
  const probeState = await page.evaluate(() =>
    (window.__fsrPlaybookBuilder__ && window.__fsrPlaybookBuilder__.state) || null);
  const bootBanner = await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e =>
      e.children.length === 0 && /harness boot failed/i.test(e.textContent || ''));
    return el ? el.textContent.trim() : null;
  });

  console.log(JSON.stringify({
    probeState,
    bootBanner,
    cdnFetchFromBrowser: cdnProbe,
    consoleErrs: consoleErrs.slice(0, 10),
    requestFailed: failed.filter(u => /cdnjs|cloudflare|jsdelivr|lodash/i.test(u)).slice(0, 10),
  }, null, 2));

  await browser.close();
})().catch(e => { console.error('DIAG ERROR', e); process.exit(1); });
