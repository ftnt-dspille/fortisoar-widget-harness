'use strict';
// Example end-to-end test. Boots the widget in the harness (a headless Chromium
// driven by Playwright) and exercises the real DOM — the complement to the jest
// unit test, which only covers controller logic. Run with:
//
//   npm run test:e2e                      # boots its own harness on :14401
//
// The harness serves this widget from examples/ automatically when widgets-src/
// is absent (a fresh clone), or alongside your widgets in the monorepo.

const { test, expect } = require('@playwright/test');

const HARNESS = 'http://localhost:14401';

// Resolve the mounted widget id (name-version) so the spec survives version
// bumps instead of hard-coding helloCounter-1.0.0.
async function resolveId(request) {
  const resp = await request.get(`${HARNESS}/_fsr/widgets`);
  const data = await resp.json();
  const w = (data.widgets || []).find((x) => x.name === 'helloCounter');
  if (!w) throw new Error('helloCounter not discovered by the harness');
  return w.id;
}

test.describe('helloCounter', () => {
  let id;
  test.beforeAll(async ({ request }) => { id = await resolveId(request); });

  test('increments, decrements, and resets', async ({ page }) => {
    // The harness selects which widget to mount from localStorage, so seed it
    // before the page scripts run (matches the other e2e specs).
    await page.addInitScript((widgetId) => {
      localStorage.setItem('harness.widget', widgetId);
      localStorage.setItem('harness.ctx', 'dashboard');
      // The harness only mounts a configurable widget once a config is saved.
      // Seed an empty one so the controller runs with its built-in defaults.
      localStorage.setItem('harness:config:' + widgetId, JSON.stringify({}));
    }, id);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const count = page.getByTestId('hc-count');
    await expect(count).toHaveText('0');

    await page.getByTestId('hc-inc').click();
    await page.getByTestId('hc-inc').click();
    await expect(count).toHaveText('2');

    await page.getByTestId('hc-dec').click();
    await expect(count).toHaveText('1');

    await page.getByTestId('hc-reset').click();
    await expect(count).toHaveText('0');
  });
});
