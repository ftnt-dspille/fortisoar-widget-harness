# FortiSOAR Widget Dev Harness

Local dev loop for AngularJS widgets that target FortiSOAR 7.x. Renders a widget
in isolation in your browser, proxies `/api/*` to a real SOAR instance, and
packages + installs the widget back to that instance with one click.

## Features

- **Auto-discovers widgets** under `WIDGETS_SRC/<repo>/widget/` (any directory
  containing `info.json` with `name` and `version`). One harness, many widgets.
- **Stub `cybersponse` module** stands in for the platform services widgets
  inject (`config`, `$state`, `toaster`, `CommonUtils`, `Modules`,
  `dynamicValueService`, `csJsonEditor`, `csSpinner`, `monacoEditor`).
- **Real SOAR proxy** for `/api/*` and assets. Authenticates via
  `POST /auth/authenticate`, caches the JWT, re-auths on 401, refreshes before
  expiry. Strips upstream `Content-Security-Policy` so Monaco / inline scripts
  work locally.
- **Hot-reload on version bump** — change `info.json`'s `version` and the
  harness mounts the new id without a restart.
- **Context switcher** — render the widget as Dashboard, View Panel, or Drawer,
  with the harness providing the correct `$state` shape and seeding
  `vars.input.records[0]` from a real SOAR record when you supply
  `module` + `id`.
- **Edit-config modal** — opens the widget's `edit.html` against the same
  `cybersponse` injector, persists `$scope.config` to `localStorage`, and
  re-mounts the view with the new config.
- **Version-drift detection + auto-fix** — when `info.json` is bumped without
  renaming the controller identifiers (`<name><digits>DevCtrl`) or the
  versioned `<link>`/`<script>` hrefs in `view.html`/`edit.html`, the harness
  surfaces a clear error block listing every drift and offers a one-click
  `Try auto-fix` button that rewrites all stale references in place.
- **One-click package + install** — builds a SOAR-shaped `.tgz`, uploads via
  `POST /api/3/solutionpacks/install`, and publishes via
  `PUT /api/3/widgets/<uuid>` with retry while SOAR finishes processing.
- **Owns the test runtime** — `jest`, `jsdom`, `angular`, and `angular-mocks`
  live here. The harness's `jest.config.js` auto-discovers each widget's
  `tests/` folder and runs them as Jest projects, so widget repos can stay
  lean (no test devDependencies of their own).

## Layout

```
server.js          # Express: discovery, auth, proxy, package/install endpoints
harness.module.js  # Stub `cybersponse` module + service/directive stand-ins
packager.js        # tgz builder, version bump, source <-> info.json sync
lib/harnessUtils.js
public/index.html  # Harness shell: Angular + Monaco loader, widget picker
tests/             # jest + playwright suites (also runs widget projects)
widgets-src/       # default discovery root if WIDGETS_SRC isn't set
```

## Setup

```bash
pnpm install              # or npm install
cp .env.example .env
# fill in FSR_BASE_URL / FSR_USERNAME / FSR_PASSWORD
# optionally: WIDGETS_SRC=/abs/path/containing/widget-repos
pnpm start                # http://localhost:4400
```

Any subdirectory of `WIDGETS_SRC` containing `widget/info.json` shows up in the
harness picker; everything else is silently skipped, so pointing at a folder
of unrelated repos is safe.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /` | Harness shell |
| `GET /<widget-id>/...` | Static widget assets (id is `name-version`) |
| `GET /_fsr/widgets` | Discovered widget list incl. registered controller names + stale-version refs |
| `GET /_fsr/stylesheets` | Scrapes `<link rel=stylesheet>` from upstream `/` so the harness can mirror SOAR theme CSS |
| `GET /_fsr/package/:id/info` | Current name + version |
| `POST /_fsr/package/:id` | Build `.tgz`, optional `{bump}` or `{version}` |
| `POST /_fsr/install/:id` | Package, upload, publish to SOAR |
| `POST /_fsr/fix-controllers/:id` | Auto-rewrite stale controller names + versioned `<name>-X.Y.Z` references |
| `* /api/*` | Proxied to SOAR with cached bearer token |
| `*` (other) | Proxied to SOAR (assets, etc.) |

## Tests

```bash
pnpm test            # jest: harness + every discovered widget's tests
pnpm test:e2e        # playwright (requires a reachable FSR_BASE_URL)
```

The Jest config uses `projects:` to fan out — the harness's own suites run
under Node, each widget's tests run under jsdom with the widget's own
`jest.config.js` controlling `testEnvironment` / `testMatch`. Widget tests
resolve `angular`/`angular-mocks` from the harness's `node_modules` via
`moduleDirectories`.

## Caveats

- Targets a **trusted lab SOAR instance** — `rejectUnauthorized: false` for
  upstream HTTPS. Don't point this at production.
- The harness re-implements only the platform services its widgets need. Adding
  a widget that injects a new service means adding a stub in `harness.module.js`.
- The proxy strips upstream CSP, so behavior in the harness can be looser than
  in real SOAR. Always verify in SOAR before shipping.
- `.env` holds SOAR credentials in plaintext; it is `.gitignore`d. Don't commit.
