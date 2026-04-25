# FortiSOAR Widget Dev Harness

Local dev loop for AngularJS widgets that target FortiSOAR 7.x. Renders a widget
in isolation in your browser, proxies `/api/*` to a real SOAR instance, and
packages + installs the widget back to that instance with one click.

## What it does

- **Discovers widgets** under `../widgets-src/<repo>/widget/` (each must contain
  `info.json` with `name` and `version`).
- **Serves a harness page** at `/` that hosts a stub `cybersponse` AngularJS
  module with stand-ins for the platform services widgets typically inject
  (`config`, `$state`, `toaster`, `CommonUtils`, `Modules`, `dynamicValueService`,
  `csJsonEditor`, `csSpinner`, `monacoEditor`).
- **Authenticates to FortiSOAR** via `POST /auth/authenticate`, caches the JWT,
  re-auths on 401, refreshes before expiry.
- **Proxies everything else** to `FORTISOAR_HOST` (assets + APIs). Strips
  `Content-Security-Policy` headers from upstream responses so Monaco / inline
  scripts work locally.
- **Hot-reloads** widgets when their `info.json` version changes — no server
  restart.
- **Packages** widgets into a `.tgz` shaped like a SOAR solutionpack.
- **Installs** them via the two-step SOAR flow: `POST /api/3/solutionpacks/install`
  then `PUT /api/3/widgets/<uuid>` with retry while SOAR finishes processing.

## Layout

```
dev/
  server.js          # Express server: discovery, auth, proxy, package/install endpoints
  harness.module.js  # Stub `cybersponse` AngularJS module + service/directive stand-ins
  packager.js        # tgz builder, version bump, source <-> info.json sync
  public/index.html  # Harness shell: loads Angular + Monaco from CDN, picks a widget
  package.json
  .env.example
```

## Setup

```bash
cd dev
pnpm install              # or npm install
cp .env.example .env
# fill in FORTISOAR_HOST / FORTISOAR_USERNAME / FORTISOAR_PASSWORD
pnpm start                # http://localhost:4400
```

Drop a widget folder into `../widgets-src/<repo>/widget/` (with a valid
`info.json`) and it shows up in the harness picker.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /` | Harness shell |
| `GET /<widget-id>/...` | Static widget assets (id is `name-version`) |
| `GET /_fsr/widgets` | Discovered widget list (JSON) |
| `GET /_fsr/stylesheets` | Scrapes `<link rel=stylesheet>` from upstream `/` so the harness can mirror SOAR theme CSS |
| `GET /_fsr/package/:id/info` | Current name + version |
| `POST /_fsr/package/:id` | Build `.tgz`, optional `{bump}` or `{version}` |
| `POST /_fsr/install/:id` | Package, upload, publish to SOAR |
| `* /api/*` | Proxied to SOAR with cached bearer token |
| `*` (other) | Proxied to SOAR (assets, etc.) |

## Tests

`tests/` (at repo root) cover server, packager, controllers, and a Playwright
e2e — ~2k lines. From the repo root:

```bash
pnpm test            # jest unit/integration
pnpm test:e2e        # playwright (requires a reachable FORTISOAR_HOST)
```

## Caveats

- Targets a **trusted lab SOAR instance** — `rejectUnauthorized: false` for
  upstream HTTPS. Don't point this at production.
- The harness re-implements only the platform services its widgets need. Adding
  a widget that injects a new service means adding a stub in `harness.module.js`.
- The proxy strips upstream CSP, so behavior in the harness can be looser than
  in real SOAR. Always verify in SOAR before shipping.
- `.env` holds SOAR credentials in plaintext; it is `.gitignore`d. Don't commit.
