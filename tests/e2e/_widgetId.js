'use strict';
// Resolve the installed fsrSocAssistant widget id from the running harness,
// so e2e specs survive version bumps instead of hard-coding e.g. -1.0.0.
// Usage in a spec:
//   const { resolveWidgetId, DEFAULT_ID } = require('./_widgetId');
//   let WIDGET_ID = DEFAULT_ID;
//   test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const HARNESS = 'http://localhost:14401';
const DEFAULT_ID = 'fsrSocAssistant-1.0.29';

async function resolveWidgetId(request, name) {
  name = name || 'fsrSocAssistant';
  try {
    const resp = await request.get(`${HARNESS}/_fsr/widgets`);
    const data = await resp.json();
    const list = data.widgets || data;
    const w = (list || []).find(x => x.name === name);
    if (w && w.id) return w.id;
  } catch (e) { /* harness unreachable — fall back to the default */ }
  return DEFAULT_ID;
}

module.exports = { resolveWidgetId, DEFAULT_ID, HARNESS };
