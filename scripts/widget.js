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

const { resolveSoarEnv } = require("../lib/soarEnv");
const HARNESS_URL = process.env.HARNESS_URL || "http://localhost:14400";
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
  console.log(`usage: widget <cmd> <widget-folder> [flags]

commands:
  bump <id>                         bump version in info.json (--bump patch|minor|major, default patch)
  pack <id>                         build .tgz only (no upload)
  push <id> [--bump <p>]            pack + upload + publish to SOAR
  verify-remote <id> [--alert IRI]  open SOAR + drawer with Playwright, smoke-test the widget
  ship <id> [--bump <p>] [--alert IRI]   push + verify-remote
`);
  process.exit(code);
}

if (!cmd || cmd === "-h" || cmd === "--help") usage(0);
if (!idArg) usage(1);

// Discover the widget folder under widgets-src/. The "id" arg can be the
// folder name (e.g. "fsrPlaybookBuilder") or the slug-with-version
// (e.g. "fsrPlaybookBuilder-1.0.10"). Strip any trailing version.
const widgetsSrc = path.resolve(__dirname, "..", "widgets-src");
const folderName = idArg.replace(/-\d+(?:\.\d+)+$/, "");
const widgetDir = path.join(widgetsSrc, folderName, "widget");
if (!fs.existsSync(path.join(widgetDir, "info.json"))) {
  die(`widget not found: ${widgetDir}/info.json missing`);
}
const info = JSON.parse(fs.readFileSync(path.join(widgetDir, "info.json"), "utf8"));
const widgetId = `${info.name}-${info.version}`; // matches harness mount path

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

// ─── commands ────────────────────────────────────────────────────────────

async function cmdBump() {
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
  await ensureHarness();
  const r = await http(`${HARNESS_URL}/_fsr/package/${widgetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify({}));
  if (r.status >= 400) die(`pack failed (${r.status}): ${r.text.slice(0, 400)}`);
  ok(`packaged: ${(r.json && r.json.archivePath) || r.text}`);
}

async function cmdPush() {
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

async function ensureHarness() {
  if (await harnessAlive()) return;
  die(`harness not reachable at ${HARNESS_URL} — run \`pnpm start\` (or \`node server.js\`) first`);
}

// ─── dispatch ────────────────────────────────────────────────────────────
const COMMANDS = {
  bump: cmdBump,
  pack: cmdPack,
  push: cmdPush,
  "verify-remote": cmdVerifyRemote,
  ship: cmdShip,
};

const handler = COMMANDS[cmd];
if (!handler) { console.error(`unknown command: ${cmd}`); usage(1); }
handler().catch((e) => die(e.stack || e.message || String(e)));
