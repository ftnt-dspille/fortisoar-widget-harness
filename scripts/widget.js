#!/usr/bin/env node
// Per-widget CLI: bump, pack, push to SOAR, verify on SOAR, ship (all four).
//
//   node scripts/widget.js ship fsrPlaybookBuilder --bump patch --alert <iri>
//   node scripts/widget.js push fsrPlaybookBuilder --bump patch
//   node scripts/widget.js verify-remote fsrPlaybookBuilder --alert <iri>
//
// Talks to the running harness on $HARNESS_URL (default http://localhost:14400)
// for packaging + install — the harness already implements that and owns the
// SOAR credentials. verify-remote drives Playwright against $FSR_BASE_URL
// using the username/password in .env.

"use strict";

require("dotenv").config();
const path = require("path");
const fs = require("fs");

const readline = require("readline");
const { resolveSoarEnv } = require("../lib/soarEnv");
// Default to the same PORT the server reads from .env, so the CLI always points
// at the harness this same .env launches. Override with HARNESS_URL if needed.
const HARNESS_URL =
  process.env.HARNESS_URL || `http://localhost:${process.env.PORT || 14400}`;
const { host: FSR_HOST, user: FSR_USER, pass: FSR_PASS } = resolveSoarEnv();

// ─── arg parsing ──────────────────────────────────────────────────────────
const [, , cmd, idArg, ...rest] = process.argv;
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
}

function usage(code) {
  console.log(`usage: widget <cmd> [<widget-folder>] [flags]

Talks to the running harness on $HARNESS_URL (default ${HARNESS_URL}); start it
with \`npm run dev\` first. SOAR connection comes from .env (FSR_BASE_URL / etc).

credentials (OS keychain — keeps the password out of .env):
  login [<user>]                    store the FortiSOAR password in the OS keychain
  logout [<user>]                   remove the stored keychain password
  creds                             show what would authenticate (no secret printed)

discovery & inspection:
  list                              list local widgets (version + lint) [--json]
  remote-list                       list widgets installed on the SOAR box [--all] [--json]
  info <id>                         print a local widget's name + version
  lint <id>                         run the harness lint for one widget

build & deploy:
  bump <id> [--bump <p>]            bump version in info.json (patch|minor|major, default patch)
  pack <id>                         build .tgz only (no upload)
  push <id> [--bump <p>]            pack + upload + publish to SOAR
  ship <id> [--bump <p>] [--alert IRI]   push + verify-remote
  verify-remote <id> [--alert IRI]  open SOAR + drawer with Playwright, smoke-test the widget

download & rename:
  pull <uuid|name|title> [--folder <slug>]   download a widget from SOAR into widgets-src/
  rename <id> --title "New Title" [--name <override>] [--subtitle <s>] [--description <s>] [--release-notes <s>]
                                    rename on disk; name auto-derived from title; display fields updated when passed
`);
  process.exit(code);
}

if (!cmd || cmd === "-h" || cmd === "--help") usage(0);

const widgetsSrc = path.resolve(__dirname, "..", "widgets-src");

// Local-widget resolution is lazy: commands that operate on a folder
// (bump/pack/push/rename/lint/info/...) call resolveLocalWidget() to populate
// these; folderless commands (list/remote-list/pull) skip it. The "id" arg can
// be the folder name (e.g. "fsrPlaybookBuilder") or the slug-with-version
// (e.g. "fsrPlaybookBuilder-1.0.10") — any trailing version is stripped.
let folderName, widgetDir, info, widgetId;
function resolveLocalWidget() {
  if (!idArg) die("this command requires a <widget-folder> argument");
  folderName = idArg.replace(/-\d+(?:\.\d+)+$/, "");
  widgetDir = path.join(widgetsSrc, folderName, "widget");
  if (!fs.existsSync(path.join(widgetDir, "info.json"))) {
    die(`widget not found: ${widgetDir}/info.json missing`);
  }
  info = JSON.parse(fs.readFileSync(path.join(widgetDir, "info.json"), "utf8"));
  widgetId = `${info.name}-${info.version}`; // matches harness mount path
}

// ─── small http helpers (no extra deps) ──────────────────────────────────
const { request: httpRequest } = require("http");
const { request: httpsRequest } = require("https");
const { URL } = require("url");

function http(urlStr, opts = {}, body = null) {
  const u = new URL(urlStr);
  const mod = u.protocol === "https:" ? httpsRequest : httpRequest;
  const reqOpts = {
    method: opts.method || "GET",
    headers: opts.headers || {},
    // SOAR appliances ship with self-signed certs; this CLI only talks to the
    // host the developer themselves put in .env (FORTISOAR_HOST) or to the
    // local harness. Matches the existing Playwright probe + dev server. If
    // you're pointing at a prod-signed SOAR, set NODE_EXTRA_CA_CERTS instead.
    rejectUnauthorized: false,
  };
  return new Promise((resolve, reject) => {
    const req = mod(u, reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function harnessAlive() {
  try {
    const r = await http(`${HARNESS_URL}/_fsr/widgets`, { method: "GET" });
    return r.status === 200;
  } catch (_) { return false; }
}

function die(msg) { console.error("error:", msg); process.exit(2); }
function ok(msg)  { console.log("✓", msg); }
function info_(msg) { console.log("·", msg); }

// ─── credential helpers (OS keychain via optional @napi-rs/keyring) ────────
function loadKeyring() {
  try {
    return require("@napi-rs/keyring");
  } catch (_) {
    die(
      "@napi-rs/keyring is not installed. Run `npm install` (it's an optional\n" +
      "  dependency), or skip the keychain and set FSR_PASSWORD in your environment/.env."
    );
  }
}

function prompt(question, def) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(def ? `${question} [${def}]: ` : `${question}: `, (a) => {
      rl.close();
      resolve((a || "").trim() || def || "");
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
    // Suppress echo of the typed secret; still print the prompt itself.
    rl._writeToOutput = function (str) {
      if (!rl.stdoutMuted || str.includes(question)) process.stdout.write(str);
    };
  });
}

// ─── commands ────────────────────────────────────────────────────────────

async function cmdRename() {
  resolveLocalWidget();
  // Local filesystem operation only — does NOT touch the running harness or the
  // SOAR box. SOAR keys a widget by `name`, so a renamed package installs as a
  // NEW widget (new uuid); reconciling the box is a separate, deliberate step.
  // Title is the input; the camelCase `name` (the SOAR widget key) is derived
  // from it. `--name` overrides the derivation for an unusual title.
  const title = typeof flags.title === "string" ? flags.title : null;
  if (!title) die('rename requires --title "New Title"');
  // Optional display/identity fields — applied to info.json only when passed.
  const opts = { title };
  if (typeof flags.subtitle === "string") opts.subtitle = flags.subtitle;
  if (typeof flags.description === "string") opts.description = flags.description;
  if (typeof flags["release-notes"] === "string") opts.releaseNotes = flags["release-notes"];
  const { renameWidget, widgetNameFromTitle } = require("../packager");
  let report;
  try {
    const newName = flags.name || widgetNameFromTitle(title);
    info_(`title "${title}" → name "${newName}"`);
    report = renameWidget(widgetsSrc, folderName, newName, opts);
  } catch (e) {
    die(e.message);
  }
  ok(`renamed ${report.oldName} → ${report.newName} (title: "${title}")`);
  info_(`folder: ${report.newFolder}`);
  info_(`rewrote ${report.changedFiles.length} file(s):`);
  for (const f of report.changedFiles) info_(`  ${path.relative(widgetsSrc, f)}`);
  console.log("");
  info_("next steps:");
  info_("  1. restart the harness (scripts/ship.sh) so it rescans widgets-src");
  info_(`  2. \`widget bump ${report.newName}\` then \`widget push ${report.newName}\` to install the renamed widget`);
  info_("  3. reconcile the OLD-named widget on the box (verify-uuid / delete) as decided");
}

async function cmdBump() {
  resolveLocalWidget();
  // Delegate to the harness so behavior matches the UI's bump-and-install.
  // The harness rewrites controller suffix + folder name + script refs.
  await ensureHarness();
  const bump = flags.bump || "patch";
  const r = await http(`${HARNESS_URL}/_fsr/fix-info/${widgetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify({ bump })).catch(() => null);
  if (!r) die("bump request failed");
  if (r.status >= 400) die(`bump failed (${r.status}): ${r.text.slice(0, 400)}`);
  ok(`bumped ${folderName} → ${(r.json && r.json.version) || "(see harness log)"}`);
}

async function cmdPack() {
  resolveLocalWidget();
  await ensureHarness();
  const r = await http(`${HARNESS_URL}/_fsr/package/${widgetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify({}));
  if (r.status >= 400) die(`pack failed (${r.status}): ${r.text.slice(0, 400)}`);
  ok(`packaged: ${(r.json && r.json.archivePath) || r.text}`);
}

async function cmdPush() {
  resolveLocalWidget();
  await ensureHarness();
  if (!FSR_HOST) die("FSR_BASE_URL not set in .env");
  const payload = {};
  if (flags.bump) payload.bump = flags.bump;
  if (flags.version) payload.version = flags.version;
  if (flags["skip-lint"]) payload.skipLint = true;
  // widgetId carries info.json's CURRENT version, but the server bumps it
  // (when --bump/--version is set) before packaging — so don't print a version
  // here that's about to change. Report the actual installed version, which
  // the install response echoes back, in the success line below.
  const bumpNote = flags.version ? ` → v${flags.version}`
    : flags.bump ? ` (--bump ${flags.bump})` : "";
  info_(`pushing ${info.name}${bumpNote} → ${FSR_HOST}`);
  const r = await http(`${HARNESS_URL}/_fsr/install/${widgetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify(payload));
  if (r.status >= 400) die(`push failed (${r.status}): ${r.text.slice(0, 800)}`);
  const installed = (r.json && r.json.version) ? `${info.name}-${r.json.version}` : widgetId;
  ok(`installed on SOAR: ${installed} (uuid=${r.json && r.json.uuid})`);
}

async function cmdVerifyRemote() {
  resolveLocalWidget();
  if (!FSR_HOST || !FSR_USER || !FSR_PASS) {
    die("FSR_BASE_URL/FSR_USERNAME/FSR_PASSWORD must be set in .env for verify-remote");
  }
  // Re-read info in case push just bumped.
  const fresh = JSON.parse(fs.readFileSync(path.join(widgetDir, "info.json"), "utf8"));
  const verifyId = `${fresh.name}-${fresh.version}`;

  // Generic probe + per-widget spec file (optional).
  const verifyMod = require("./widget-verify-remote");
  const result = await verifyMod.run({
    host: FSR_HOST,
    user: FSR_USER,
    pass: FSR_PASS,
    alert: flags.alert || process.env.FSR_PROBE_ALERT_IRI || process.env.FORTISOAR_PROBE_ALERT_IRI || null,
    mock: flags.mock || null,
    widgetDir,
    widgetName: fresh.name,
    widgetTitle: fresh.title || fresh.name,
    widgetVersion: fresh.version,
    widgetId: verifyId,
    outDir: flags["out-dir"] || "/tmp/widget-verify",
  });
  if (!result.ok) die(`verify-remote failed: ${result.error}\nArtifacts: ${result.outDir}`);
  ok(`verify-remote passed (${result.checksRun} checks). Artifacts: ${result.outDir}`);
}

async function cmdShip() {
  await cmdPush();
  // After push the version may have been bumped; verify-remote re-reads.
  await cmdVerifyRemote();
  ok("ship complete");
}

async function cmdLogin() {
  // Store the FortiSOAR password in the OS keychain so it never lives in .env.
  const { Entry } = loadKeyring();
  const { user: defUser, service } = resolveSoarEnv();
  const user = idArg || flags.user || (await prompt("FortiSOAR username", defUser));
  if (!user) die("username required");
  const pass = typeof flags.password === "string" ? flags.password : await promptHidden("FortiSOAR password: ");
  if (!pass) die("password required");
  new Entry(service, user).setPassword(pass);
  ok(`stored password for ${user} in the OS keychain (service "${service}")`);
  info_("you can now delete the FSR_PASSWORD line from .env");
}

async function cmdLogout() {
  const { Entry } = loadKeyring();
  const { user: defUser, service } = resolveSoarEnv();
  const user = idArg || flags.user || defUser;
  if (!user) die("username required — `widget logout <user>`");
  const removed = new Entry(service, user).deletePassword();
  ok(removed ? `removed keychain password for ${user}` : `no keychain entry for ${user}`);
}

async function cmdCreds() {
  // Show what WOULD be used to authenticate, without printing any secret.
  const { host, user, pass, apiKey, service } = resolveSoarEnv();
  let kr = "(@napi-rs/keyring not installed)";
  try {
    const { Entry } = require("@napi-rs/keyring");
    kr = user && new Entry(service, user).getPassword() ? "present" : "none";
  } catch (_) { /* keep default */ }
  info_(`host:     ${host || "(unset)"}`);
  info_(`user:     ${user || "(unset)"}`);
  info_(`password: ${pass ? "resolved" : "MISSING"}`);
  info_(`api key:  ${apiKey ? "resolved" : "(none)"}`);
  info_(`keychain: service "${service}", entry for ${user || "?"}: ${kr}`);
  info_("precedence: env var > OS keychain > .env");
}

async function cmdList() {
  // Local widgets the harness has discovered, with version + lint status.
  await ensureHarness();
  const r = await http(`${HARNESS_URL}/_fsr/widgets`);
  if (r.status >= 400 || !r.json) die(`list failed (${r.status})`);
  const rows = (r.json.widgets || []).map((w) => {
    const errs = (w.lint && w.lint.errors && w.lint.errors.length) || 0;
    const stale = (w.staleVersionRefs && w.staleVersionRefs.length) || 0;
    return [w.name, w.version, errs ? `${errs} err` : stale ? `${stale} stale` : "ok", w.title || ""];
  });
  printTable(["NAME", "VERSION", "LINT", "TITLE"], rows);
  if (flags.json) console.log(JSON.stringify(r.json, null, 2));
}

async function cmdRemoteList() {
  // Widgets installed on the SOAR box (the source for `pull`).
  await ensureHarness();
  const r = await http(`${HARNESS_URL}/_fsr/remote-widgets`);
  if (r.status >= 400 || !r.json) die(`remote-list failed (${r.status}): ${r.text.slice(0, 300)}`);
  const all = r.json.widgets || [];
  const rows = all
    .filter((w) => flags.all || !w.inbuilt) // hide platform-managed widgets unless --all
    .map((w) => [w.name, w.version, w.inbuilt ? "inbuilt" : "custom", w.title || "", w.uuid]);
  printTable(["NAME", "VERSION", "KIND", "TITLE", "UUID"], rows);
  info_(`${rows.length} shown${flags.all ? "" : " (custom only — pass --all for inbuilt)"} of ${all.length} on ${FSR_HOST}`);
  if (flags.json) console.log(JSON.stringify(r.json, null, 2));
}

async function cmdPull() {
  // Download a widget FROM the box INTO widgets-src/<folder>/widget. The arg may
  // be a uuid, a widget `name`, or a `title`; non-uuids are resolved against the
  // remote list. Refuses to overwrite an existing folder (server-enforced).
  if (!idArg) die("pull requires <uuid|name|title> (see `widget remote-list`)");
  await ensureHarness();
  let uuid = idArg;
  if (!/^[a-f0-9-]{16,}$/i.test(idArg)) {
    const lr = await http(`${HARNESS_URL}/_fsr/remote-widgets`);
    if (lr.status >= 400 || !lr.json) die(`could not list remote widgets (${lr.status})`);
    const matches = (lr.json.widgets || []).filter(
      (w) => w.uuid === idArg || w.name === idArg || w.title === idArg
    );
    if (matches.length === 0) die(`no remote widget matches "${idArg}" — try \`widget remote-list\``);
    if (matches.length > 1) die(`"${idArg}" is ambiguous (${matches.map((m) => m.name).join(", ")}); pass a uuid`);
    uuid = matches[0].uuid;
    info_(`resolved "${idArg}" → ${matches[0].name} (${uuid})`);
  }
  const payload = flags.folder ? { folder: flags.folder } : {};
  const r = await http(
    `${HARNESS_URL}/_fsr/import/${encodeURIComponent(uuid)}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    JSON.stringify(payload)
  );
  if (r.status >= 400) die(`pull failed (${r.status}): ${r.text.slice(0, 400)}`);
  ok(`pulled ${r.json.name}-${r.json.version} → widgets-src/${r.json.folder}`);
}

async function cmdLint() {
  resolveLocalWidget();
  await ensureHarness();
  const r = await http(`${HARNESS_URL}/_fsr/lint/${widgetId}`);
  if (r.status >= 400 || !r.json) die(`lint failed (${r.status}): ${r.text.slice(0, 300)}`);
  const { errors = [], warnings = [] } = r.json.lint || {};
  for (const e of errors) console.log(`  ✗ ${typeof e === "string" ? e : JSON.stringify(e)}`);
  for (const w of warnings) console.log(`  ! ${typeof w === "string" ? w : JSON.stringify(w)}`);
  if (errors.length === 0 && warnings.length === 0) ok(`${widgetId}: clean`);
  else if (errors.length) die(`${errors.length} error(s), ${warnings.length} warning(s)`);
  else ok(`${warnings.length} warning(s), no errors`);
}

async function cmdInfo() {
  resolveLocalWidget();
  await ensureHarness();
  const r = await http(`${HARNESS_URL}/_fsr/package/${widgetId}/info`);
  if (r.status >= 400 || !r.json) die(`info failed (${r.status})`);
  console.log(JSON.stringify(r.json, null, 2));
}

// Minimal column-aligned table printer (no deps).
function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] == null ? "" : r[i]).length))
  );
  const fmt = (cells) => cells.map((c, i) => String(c == null ? "" : c).padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
}

async function ensureHarness() {
  if (await harnessAlive()) return;
  die(`harness not reachable at ${HARNESS_URL} — run \`pnpm start\` (or \`node server.js\`) first`);
}

// ─── dispatch ────────────────────────────────────────────────────────────
const COMMANDS = {
  login: cmdLogin,
  logout: cmdLogout,
  creds: cmdCreds,
  list: cmdList,
  "remote-list": cmdRemoteList,
  pull: cmdPull,
  info: cmdInfo,
  lint: cmdLint,
  rename: cmdRename,
  bump: cmdBump,
  pack: cmdPack,
  push: cmdPush,
  "verify-remote": cmdVerifyRemote,
  ship: cmdShip,
};

const handler = COMMANDS[cmd];
if (!handler) { console.error(`unknown command: ${cmd}`); usage(1); }
handler().catch((e) => die(e.stack || e.message || String(e)));
