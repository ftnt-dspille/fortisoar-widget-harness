# Widget template

Scaffold for a new FortiSOAR 7.x widget. The files use the placeholder name
`myWidget` throughout. Don't edit this folder directly — copy it with the
scaffold script, which fills in every placeholder.

## Start a new widget

One command — copies this template into `widgets-src/<name>` and fills in every
placeholder (camelCase name, kebab-case testids/classes, display title) across
the widget AND its test, so it builds, mounts, and tests pass right away:

```bash
scripts/new-widget.sh incidentSummary "Incident Summary"

npm test                 # jest unit (passes immediately)
npm run dev              # pick "Incident Summary" at http://localhost:14400
npm run assets           # once: fetch the SOAR app shell needed for e2e
npm run test:e2e         # Playwright
```

> To rename an **existing** widget, use `node scripts/widget.js rename <id>
> --title "…"` instead (it also reconciles the deployed widget on the box, but
> deliberately leaves sibling `tests/` for you to migrate).

## Anatomy

| File | Purpose |
|------|---------|
| `widget/info.json` | Widget manifest — name, version, pages, size. Drives packaging. |
| `widget/view.controller.js` | VIEW controller. Name resolves to `<name><numericVersion>DevCtrl`. Never hand-edit the digits. |
| `widget/view.html` | The rendered template. |
| `widget/edit.controller.js` / `edit.html` | Config editor. Controller name is `edit<PascalName><numericVersion>DevCtrl` — the harness lint blocks mounting if it's wrong. |
| `tests/view.controller.test.js` | jest unit test (stays with the widget). |
| `tests/e2e/myWidget.spec.js` | Playwright e2e seed — `new-widget.sh` relocates it to `tests/e2e/<name>.spec.js` (the harness is Playwright's testDir). |

Read `../docs/KNOWLEDGEBASE.md` before anything non-trivial, and `../TESTING.md`
for the test conventions. Every change ships with a test.
