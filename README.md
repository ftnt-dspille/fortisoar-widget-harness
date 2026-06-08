# FortiSOAR Widget Dev Harness

Local dev loop for AngularJS widgets that target FortiSOAR 7.x. Renders a widget
in isolation in your browser, proxies `/api/*` to a real SOAR instance, and
packages + installs the widget back to that instance — from the browser **or**
the `widget` CLI.

---

## Quick start (5 minutes)

You need **Node 18+** and network access to a **trusted lab** FortiSOAR box.

```bash
cd fortisoar-widget-harness
npm install
cp .env.example .env          # then edit: FSR_BASE_URL / FSR_USERNAME / FSR_PASSWORD
npm run dev                   # starts the harness; open the URL it prints (default http://localhost:4401)
```

In a second terminal, confirm the CLI can see both sides:

```bash
npm run list                  # local widgets the harness discovered
npm run remote-list           # widgets installed on your SOAR box (proves auth works)
```

If `remote-list` prints a table, your `.env` is correct and you're ready. If it
errors, check `FSR_BASE_URL` / credentials and that `npm run dev` is running.

A fresh clone ships one **example widget** (`examples/helloCounter/`) so the
harness has something to render out of the box. Open the harness URL and pick
**Hello Counter** in the widget switcher, then run its tests:

```bash
WIDGET=helloCounter npm test          # jest unit test (controller logic)
npm run test:e2e                      # playwright DOM test (boots its own harness)
```

Scaffold your own widget with one command (fills in controller names, testids,
and the e2e spec correctly — see `widget-template/`):

```bash
scripts/new-widget.sh incidentSummary "Incident Summary"   # or: npm run new-widget …
```

To rename an existing widget instead, use `node scripts/widget.js rename`.

### SOAR app shell (required for e2e)

The harness renders widgets inside the real FortiSOAR app bundle, served from
`fsr_src/`. Those are Fortinet platform assets we don't redistribute — fetch
them once from your own licensed box:

```bash
npm run assets        # downloads app.unmin.js + templates from FSR_BASE_URL into fsr_src/
```

Unit tests don't need this; e2e does (without it, widgets won't render and e2e
fails with a `/_fsr/templates.min.js` 500).

> **Safety:** the proxy disables TLS verification and strips upstream CSP so
> local dev works. Point `.env` at a **lab** box only — never production.

### Credentials without plaintext (optional)

To keep the FortiSOAR password out of `.env`, store it in your OS keychain
(macOS Keychain / Windows Credential Manager / Linux Secret Service):

```bash
node scripts/widget.js login        # prompts for password, stores it in the keychain
# then delete the FSR_PASSWORD line from .env
node scripts/widget.js creds        # shows what would authenticate (no secret printed)
node scripts/widget.js logout       # removes the stored password
```

Resolution precedence is **env var → OS keychain → `.env`**, so:
- **interactive machines** use the keychain (nothing on disk),
- **CI / Docker** export `FSR_PASSWORD` as a real env var (wins over everything),
- **a plain `.env`** still works for anyone who skips the keychain.

The keychain integration uses the **optional** `@napi-rs/keyring` dependency. If
it isn't installed (or you're headless), resolution simply falls through to the
env var / `.env`, and `login`/`logout` print an actionable message.

---

## The `widget` CLI

One command for every common task. Run via `node scripts/widget.js <cmd>` or the
npm aliases. The CLI talks to the running harness (`npm run dev` must be up) and
reads SOAR creds from the same `.env`, so its `HARNESS_URL` always matches `PORT`.

```
widget <cmd> [<widget-folder>] [flags]
```

| Command | What it does |
| --- | --- |
| `list` | Local widgets under `widgets-src/` with version + lint status (`--json` for raw) |
| `remote-list` | Widgets installed on the SOAR box (`--all` includes inbuilt; `--json` for raw) |
| `info <id>` | Print a local widget's name + version |
| `lint <id>` | Run the harness lint for one widget |
| `bump <id> [--bump patch\|minor\|major]` | Bump `info.json` version + sync controller/asset refs |
| `pack <id>` | Build the SOAR-shaped `.tgz` only (no upload) |
| `push <id> [--bump <p>]` | Pack + upload + publish to SOAR (the deploy) |
| `ship <id> [--bump <p>] [--alert IRI]` | `push` then Playwright smoke-test on the box |
| `verify-remote <id> [--alert IRI]` | Open SOAR + drawer with Playwright, smoke-test |
| `pull <uuid\|name\|title> [--folder <slug>]` | **Download** a widget from SOAR into `widgets-src/` |
| `rename <id> --title "New Title" [--name <override>]` | Rename a widget on disk; `name` auto-derived from title |

`<id>` is the widget folder name (e.g. `incidentSummary`) — a trailing
`-x.y.z` version is accepted and stripped.

### Typical loops

```bash
# Iterate + deploy a change
npm run dev                                   # leave running
node scripts/widget.js lint  incidentSummary
node scripts/widget.js push  incidentSummary --bump patch

# Bring an existing SOAR widget down to hack on it
node scripts/widget.js remote-list
node scripts/widget.js pull "Card View"       # or pull <uuid>

# Rename a widget (source only; see note below before touching the box)
node scripts/widget.js rename incidentSummary --title "Incident Summary Pro"
```

**Renaming + the box:** SOAR keys an installed widget by its `name`, so a
renamed widget `push`es as a *new* widget (new uuid) and leaves the old one
installed (the old `name` stays registered). `rename` only changes source; reconciling the box (delete the old
one, or migrate) is a deliberate follow-up step.

---

## Features

- **Auto-discovers widgets** under `WIDGETS_SRC/<repo>/widget/` (any directory
  with an `info.json` carrying `name` + `version`). One harness, many widgets.
- **Stub `cybersponse` module** stands in for the platform services widgets
  inject (`config`, `$state`, `toaster`, `CommonUtils`, `Modules`,
  `dynamicValueService`, `csJsonEditor`, `csSpinner`, `monacoEditor`).
- **Real SOAR proxy** for `/api/*` and assets. Authenticates via
  `POST /auth/authenticate`, caches the JWT, re-auths on 401, refreshes before
  expiry. Strips upstream CSP so Monaco / inline scripts work locally.
- **Hot-reload on version bump** — change `info.json`'s `version` and the
  harness mounts the new id without a restart.
- **Context switcher** — render as Dashboard, View Panel, or Drawer, with the
  harness providing the correct `$state` shape and seeding
  `vars.input.records[0]` from a real SOAR record when you supply `module` + `id`.
- **Edit-config modal** — opens the widget's `edit.html` against the same
  `cybersponse` injector, persists `$scope.config` to `localStorage`.
- **Version-drift detection + auto-fix** — surfaces stale controller ids /
  versioned hrefs after a bump and offers a one-click fix (`fix-controllers`).
- **One-click / one-command package + install** — builds a SOAR `.tgz`, uploads
  via `POST /api/3/solutionpacks/install`, publishes via `PUT /api/3/widgets/<uuid>`.
- **Download from SOAR** — `pull` (or the Import dialog) exports an installed
  widget back into `widgets-src/` to edit locally.
- **Owns the test runtime** — `jest`, `jsdom`, `angular`, `angular-mocks` live
  here; `jest.config.js` auto-discovers each widget's `tests/` as a project.

---

## Layout

```
server.js          # Express: discovery, auth, proxy, package/install/import endpoints
harness.module.js  # Stub `cybersponse` module + service/directive stand-ins
packager.js        # tgz builder, version bump, source<->info.json sync, rename
scripts/widget.js  # the `widget` CLI (list/remote-list/pull/bump/push/ship/rename/...)
lib/soarEnv.js     # single source of truth for SOAR connection (.env)
public/index.html  # Harness shell: Angular + Monaco loader, widget picker, Package/Import UI
tests/             # jest + playwright suites (also runs each widget's tests)
widgets-src/       # default discovery root if WIDGETS_SRC isn't set
```

---

## Endpoints (the CLI and UI are thin clients over these)

| Path | Purpose |
| --- | --- |
| `GET /` | Harness shell |
| `GET /<widget-id>/...` | Static widget assets (id is `name-version`) |
| `GET /_fsr/widgets` | Discovered local widgets incl. controller names + lint + stale refs |
| `GET /_fsr/lint/:id` | Lint one widget |
| `GET /_fsr/package/:id/info` | Current name + version |
| `POST /_fsr/package/:id` | Build `.tgz`, optional `{bump}` / `{version}` |
| `POST /_fsr/install/:id` | Package, upload, publish to SOAR |
| `POST /_fsr/fix-controllers/:id` | Auto-rewrite stale controller names + versioned refs |
| `GET /_fsr/remote-widgets` | List widgets installed on the SOAR box |
| `POST /_fsr/import/:uuid` | Export a widget from SOAR into `widgets-src/<folder>` |
| `POST /_fsr/upload-tgz` | Same, from an uploaded `.tgz` (raw body, `?folder=`) |
| `GET /_fsr/stylesheets` | Mirror upstream theme CSS into the harness |
| `* /api/*`, `*` | Proxied to SOAR with cached bearer token |

---

## Tests

**All testing runs locally — no FortiSOAR login required.** Unit tests run under
jsdom against stubbed platform services; e2e tests mock the `/api` data proxy
per spec. Unit tests need nothing extra. **e2e additionally needs the SOAR app
shell** (`fsr_src/`) to render widgets in a browser — run `npm run assets` once
to fetch it from your own licensed box (see "SOAR app shell" below).

```bash
npm test                          # jest: harness suites only (fast default)
WIDGET=helloCounter npm test      # + the example widget's unit tests
WIDGET=all npm test               # + every discovered widget with a tests/ dir

npm run assets                    # once: fetch the SOAR app shell for e2e
npm run test:e2e                  # playwright (data /api is mocked per spec)
npm run test:e2e:live             # opt-in: drives a real box (needs .env creds)

npm run lint                      # oxlint + eslint + test-id + angular lints
```

- **Unit** (`jest`) — `projects:` fan-out: the harness's suites run under Node;
  each widget's `tests/` run under jsdom with its own `jest.config.js`. Widget
  tests are opt-in via `WIDGET=<name|all>` so a default run stays fast.
- **e2e** (`playwright`) — boots its own harness on `:14401` and mocks `/api`
  data per spec, so no login is needed; but the widget renders inside the real
  SOAR app shell, so `npm run assets` must have populated `fsr_src/` first.
  Specs whose filename contains `Live`/`live` drive a real FortiSOAR and are
  excluded unless `E2E_LIVE=1`.
- The bundled `examples/helloCounter` widget is always discoverable for both
  unit and e2e, even when `WIDGETS_SRC` is pinned — so a clone can self-test.

---

## Configuration reference

All config is environment (via `.env`, loaded by `dotenv`). See `.env.example`.

| Var | Purpose |
| --- | --- |
| `FSR_BASE_URL` | SOAR host; scheme optional, trailing slash stripped |
| `FSR_PORT` | Optional non-standard port (overrides any in the URL) |
| `FSR_USERNAME` / `FSR_PASSWORD` | Login, exchanged for a JWT |
| `FSR_API_KEY` | Optional API key (preferred where supported) |
| `PORT` | Local harness port (default `14400`; `.env.example` uses `4401`). The CLI's `HARNESS_URL` defaults to this. |
| `WIDGETS_SRC` | Abs path to the folder of widget repos (default: sibling `widgets-src/`) |
| `HARNESS_URL` | Override the CLI's harness target (default `http://localhost:$PORT`) |

---

## Caveats

- Targets a **trusted lab SOAR instance** — `rejectUnauthorized: false` for
  upstream HTTPS, and upstream CSP is stripped. Behavior in the harness can be
  looser than real SOAR: always `verify-remote` before declaring done.
- The harness re-implements only the platform services its widgets need. A
  widget that injects a new service needs a stub added in `harness.module.js`.
- `.env` holds SOAR credentials in plaintext; it is `.gitignore`d. Don't commit.

---

## For agents

This repo is driven by AI agents. Durable references, in order:

1. **`docs/KNOWLEDGEBASE.md`** — how to build FortiSOAR 7.x widgets (lifecycle,
   drawer mechanics, platform services, packaging, 60-widget gotcha catalog).
   Consult before changing any widget; add new platform gotchas back into it.
2. **Fortinet's official widget development guide** — reference; the KNOWLEDGEBASE
   distills + extends it. Not redistributed (Fortinet copyrighted); see
   `docs/FortiSOAR-Widget-Development-Guide.md` for how to obtain it.
3. **`examples/helloCounter/`** — a minimal, working widget (view + edit
   controllers, jest + e2e tests) to read or copy as a starting point.
4. **This README + `widget --help`** — the harness operations surface.

Run tests only through the documented npm targets (`npm test`, `npm run test:e2e`).
Start the server with `npm run dev` — never hand-run a second `node server.js`
on top of a running one.
