'use strict';
// End-to-end test — boots the widget in the harness (headless Chromium) and
// exercises the real DOM. The complement to the jest unit test. Run with:
//
//   make test-e2e-widget WIDGET=myWidget   # from the dev-kit root

const { test, expect } = require('@playwright/test');

const HARNESS = 'http://localhost:14401';

// Resolve the mounted widget id (name-version) so the spec survives version
// bumps instead of hard-coding myWidget-1.0.0.
async function resolveId(request) {
  const resp = await request.get(`${HARNESS}/_fsr/widgets`);
  const data = await resp.json();
  const w = (data.widgets || []).find((x) => x.name === 'myWidget');
  if (!w) throw new Error('myWidget not discovered by the harness');
  return w.id;
}

test.describe('myWidget', () => {
  let id;
  test.beforeAll(async ({ request }) => { id = await resolveId(request); });

  test('renders the configured greeting', async ({ page }) => {
    await page.addInitScript((widgetId) => {
      localStorage.setItem('harness.widget', widgetId);
      localStorage.setItem('harness.ctx', 'dashboard');
      localStorage.setItem('harness:config:' + widgetId, JSON.stringify({ title: 'Alice' }));
    }, id);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('my-widget-greeting')).toHaveText('Hello, Alice');
  });
});
