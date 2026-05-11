/* Local widget dev server.
   - Auto-discovers widgets in widgets-src/<repo>/widget/  (each must contain info.json)
   - Serves the harness page at /
   - Authenticates to FORTISOAR_HOST, caches the JWT, re-auths on 401
   - Exposes /_fsr/widgets and /_fsr/stylesheets for the harness bootstrap
   - Proxies everything else (assets + APIs) to FORTISOAR_HOST */
"use strict";

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const HU = require("./lib/harnessUtils");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const {
  packageWidget,
  bumpVersion,
  isValidVersion,
  writeInfoVersion,
  syncSourceToInfoJson,
  validateWidget,
  suggestInfoFix,
  applyInfoFix,
} = require("./packager");

// Default port intentionally non-common so dev sessions don't collide with
// the 3000/4000/4400/8080 buckets that other tools grab. Override with PORT=.
const PORT = Number(process.env.PORT || 14400);
const HOST = process.env.FORTISOAR_HOST;
const USER = process.env.FORTISOAR_USERNAME;
const PASS = process.env.FORTISOAR_PASSWORD;
let PROXY_VERBOSE = process.env.PROXY_VERBOSE === "1";

const HARNESS_MODULE_PATH = path.resolve(__dirname, "harness.module.js");
const FSR_APP_PATH_FOR_LINT = path.resolve(__dirname, "..", "fsr_src", "app.unmin.js");
// Services registered by the SOAR bundle; parsed once at startup. The bundle
// is large (~2.5MB) so we don't watch/re-parse it. These ship to SOAR for real.
const FSR_BUNDLE_SERVICES = (() => {
  try {
    const svcs = HU.parseRegisteredServices(fs.readFileSync(FSR_APP_PATH_FOR_LINT, "utf8"));
    console.log(`[lint] indexed ${svcs.length} services from fsr_src/app.unmin.js`);
    return svcs;
  } catch (e) {
    console.warn(`[lint] failed to index app.unmin.js services: ${e.message}`);
    return [];
  }
})();
// Vendor modules loaded in index.html. Not in app.unmin.js or harness module.
const VENDOR_PROVIDED_SERVICES = ["$resource"];
// Real-in-SOAR set: present at install time without the widget shipping it.
const PLATFORM_SERVICES = Array.from(
  new Set([...FSR_BUNDLE_SERVICES, ...VENDOR_PROVIDED_SERVICES])
);
// Harness-only stub set: services registered solely by harness.module.js so
// the local mount renders. Publish-time lint flags injection of these as a
// real risk because SOAR will not have them unless the widget ships its own.
function readHarnessStubbedServices() {
  return HU.parseRegisteredServices(fs.readFileSync(HARNESS_MODULE_PATH, "utf8"));
}
let HARNESS_STUBBED_SERVICES = (() => {
  try { return readHarnessStubbedServices(); } catch { return []; }
})();
// Permissive union retained for diagnostics / SSE broadcasts.
let REGISTERED_SERVICES = Array.from(
  new Set([...PLATFORM_SERVICES, ...HARNESS_STUBBED_SERVICES])
);
fs.watch(HARNESS_MODULE_PATH, { persistent: false }, () => {
  try {
    HARNESS_STUBBED_SERVICES = readHarnessStubbedServices();
    REGISTERED_SERVICES = Array.from(
      new Set([...PLATFORM_SERVICES, ...HARNESS_STUBBED_SERVICES])
    );
    for (const w of WIDGETS) refreshWidget(w);
    broadcast({ type: "harness-reload", services: REGISTERED_SERVICES });
  } catch (e) { console.warn(`harness.module.js reload failed: ${e.message}`); }
});

// Per-widget: parse <script src="…"> tags from view.html/edit.html, follow
// each to a real file inside the widget tree, and union the .factory/
// .service/etc. names declared there. These are the only widget-local
// services that actually ship to SOAR (the templates load them at runtime).
const WIDGET_LOCAL_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
// Build a map of `serviceName -> "widgetAssets/.../file.js"` by parsing every
// .js file under widgetAssets/. Used by the linter to suggest the exact
// <script> tag to paste when a controller injects a service whose factory
// lives in widgetAssets but isn't <script>-tagged from view.html / edit.html.
function widgetAssetServiceMap(widgetDir) {
  const out = {};
  const root = path.join(widgetDir, "widgetAssets");
  if (!fs.existsSync(root)) return out;
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), sub);
      else if (e.isFile() && e.name.endsWith(".js")) {
        try {
          const js = fs.readFileSync(path.join(dir, e.name), "utf8");
          for (const name of HU.parseRegisteredServices(js)) {
            if (!(name in out)) out[name] = "widgetAssets/" + sub;
          }
        } catch { /* skip unreadable file */ }
      }
    }
  };
  walk(root, "");
  return out;
}

function widgetLocalServicesFor(widgetDir) {
  const out = new Set();
  for (const tpl of ["view.html", "edit.html"]) {
    let html = "";
    try { html = fs.readFileSync(path.join(widgetDir, tpl), "utf8"); } catch { continue; }
    let m;
    while ((m = WIDGET_LOCAL_SCRIPT_RE.exec(html)) !== null) {
      const src = m[1];
      if (/^https?:\/\//i.test(src) || src.startsWith("//")) continue; // CDN — ships nothing local
      // SOAR serves widget assets under `<name>-<version>/...`. The src in
      // view.html uses that prefix; the source tree doesn't. Try both.
      const candidates = [
        path.join(widgetDir, src),
        path.join(widgetDir, src.replace(/^[^/]+\//, "")),
      ];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const js = fs.readFileSync(p, "utf8");
            for (const name of HU.parseRegisteredServices(js)) out.add(name);
            break;
          }
        } catch { /* ignore + try next candidate */ }
      }
    }
  }
  return Array.from(out);
}

// Lint context files we read off disk per widget.
const LINT_FILES = ["view.controller.js", "edit.controller.js", "view.html", "edit.html"];

function readLintFiles(widgetDir) {
  const out = {};
  for (const f of LINT_FILES) {
    const p = path.join(widgetDir, f);
    try { out[f] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; }
    catch { out[f] = null; }
  }
  return out;
}

function lintFor(widget) {
  const infoPath = path.join(widget.dir, "info.json");
  let info = null;
  try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch { /* surfaced below */ }
  return HU.lintWidget({
    info,
    files: readLintFiles(widget.dir),
    // Real-in-SOAR services. Anything not in here (and not in widgetLocal)
    // either fails publish-time or only works locally as a harness stub.
    registeredServices: PLATFORM_SERVICES,
    harnessStubbedServices: HARNESS_STUBBED_SERVICES,
    widgetLocalServices: widgetLocalServicesFor(widget.dir),
    widgetAssetServiceMap: widgetAssetServiceMap(widget.dir),
    staleVersionRefs: widget.staleVersionRefs || [],
    viewControllers: widget.viewControllers || [],
    editControllers: widget.editControllers || [],
  });
}

// Credential check is deferred to startup so the module can be imported
// by tests without exiting. See the require.main block at the bottom.

// Token cache
let cachedToken = null;
let tokenExpiry = 0;
let tokenPromise = null;
const REFRESH_SKEW_MS = 60 * 1000;
const FALLBACK_TTL_MS = 50 * 60 * 1000;

function decodeJwtExpiryMs(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8")
    );
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function upstreamRequest({ method, pathAndQuery, body, headers }) {
  return new Promise((resolve, reject) => {
    const url = new URL(HOST.replace(/\/$/, "") + pathAndQuery);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: false,
        headers: Object.assign(
          { Accept: "*/*" },
          body ? { "Content-Length": Buffer.byteLength(body) } : {},
          headers || {}
        ),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Posts a multipart/form-data body upstream. Used for solutionpacks/install
// which expects fields plus a .tgz file. Built on top of https.request so it
// shares the same `rejectUnauthorized: false` posture as upstreamRequest.
function upstreamMultipart({ pathAndQuery, fields, file, headers }) {
  return new Promise((resolve, reject) => {
    const boundary = "----fsr" + crypto.randomBytes(8).toString("hex");
    const chunks = [];
    for (const [name, value] of Object.entries(fields || {})) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${value}\r\n`
        )
      );
    }
    if (file) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
            `Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`
        )
      );
      chunks.push(file.content);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);

    const url = new URL(HOST.replace(/\/$/, "") + pathAndQuery);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        rejectUnauthorized: false,
        headers: Object.assign(
          {
            Accept: "*/*",
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          headers || {}
        ),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.warn(`upstreamMultipart ${res.statusCode} ${pathAndQuery} | headers: ${JSON.stringify(res.headers)} | body: ${data.slice(0, 500) || "(empty)"}`);
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Binary-safe upstream request. upstreamRequest concatenates response chunks
// as utf8 strings, which corrupts gzip/tar bytes — so the widget-export flow
// (which returns a .tgz) goes through this variant instead.
function upstreamRequestBinary({ method, pathAndQuery, body, headers }) {
  return new Promise((resolve, reject) => {
    const url = new URL(HOST.replace(/\/$/, "") + pathAndQuery);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: false,
        headers: Object.assign(
          { Accept: "*/*" },
          body ? { "Content-Length": Buffer.byteLength(body) } : {},
          headers || {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function authenticate() {
  const body = JSON.stringify({
    credentials: { loginid: USER, password: PASS },
  });
  const res = await upstreamRequest({
    method: "POST",
    pathAndQuery: "/auth/authenticate",
    body,
    headers: { "Content-Type": "application/json" },
  });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`auth ${res.status}: ${res.body.slice(0, 300)}`);
  const parsed = JSON.parse(res.body);
  if (!parsed.token) throw new Error("auth response missing token");
  return parsed.token;
}

async function ensureToken() {
  if (cachedToken && Date.now() < tokenExpiry - REFRESH_SKEW_MS) {
    return cachedToken;
  }
  if (!tokenPromise) {
    console.log(
      cachedToken
        ? "auth: token expired, re-authenticating…"
        : `auth: fetching token as ${USER}…`
    );
    tokenPromise = authenticate()
      .then((token) => {
        cachedToken = token;
        tokenExpiry = decodeJwtExpiryMs(token) || Date.now() + FALLBACK_TTL_MS;
        console.log(
          `auth: ok, token expires ${new Date(tokenExpiry).toISOString()}`
        );
        return token;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

function invalidateToken() {
  cachedToken = null;
  tokenExpiry = 0;
}

// Widget discovery
const WIDGETS_SRC = process.env.WIDGETS_SRC
  ? path.resolve(process.env.WIDGETS_SRC)
  : path.resolve(__dirname, "widgets-src");

// Files we scan for stale `<name>-<version>` references. The widget templates
// frequently embed versioned paths (e.g. <link href="<name>-1.1.3/...">) that
// must follow info.json's version, but get forgotten on a version bump.
const VERSIONED_REF_FILES = ["view.html", "edit.html", "view.controller.js", "edit.controller.js"];

function staleRefRegex(name) {
  // Match `<name>-X.Y[.Z...]` -- capture the version portion so we can compare
  // it against the current one. We don't include trailing slash so it picks
  // up paths and bare identifiers alike.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + escaped + "-(\\d+(?:\\.\\d+)+)", "g");
}

function scanStaleVersionRefs(widgetDir, name, version) {
  const out = [];
  const re = staleRefRegex(name);
  for (const file of VERSIONED_REF_FILES) {
    const p = path.join(widgetDir, file);
    if (!fs.existsSync(p)) continue;
    let src;
    try { src = fs.readFileSync(p, "utf8"); } catch (_) { continue; }
    const seen = new Set();
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (m[1] !== version) seen.add(m[1]);
    }
    if (seen.size > 0) out.push({ file, staleVersions: Array.from(seen) });
  }
  return out;
}

// Build a widget record for a single widgets-src/<folder>/widget directory.
// Returns null if info.json is missing/invalid; caller decides whether to skip
// or surface an error.
function buildWidgetRecord(folder) {
  const widgetDir = path.join(WIDGETS_SRC, folder, "widget");
  const infoPath = path.join(widgetDir, "info.json");
  if (!fs.existsSync(infoPath)) return null;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  } catch (err) {
    console.warn(`skipping ${folder}: bad info.json (${err.message})`);
    return null;
  }
  if (!info.name || !info.version) {
    console.warn(`skipping ${folder}: info.json missing name or version`);
    return null;
  }
  const readControllers = (file) => {
    const p = path.join(widgetDir, file);
    if (!fs.existsSync(p)) return [];
    try {
      return HU.extractRegisteredControllers(fs.readFileSync(p, "utf8"));
    } catch (_) {
      return [];
    }
  };
  return {
    folder,
    dir: widgetDir,
    id: `${info.name}-${info.version}`,
    name: info.name,
    version: info.version,
    title: info.title || info.name,
    subTitle: info.subTitle || "",
    pages: (info.metadata && info.metadata.pages) || [],
    viewControllers: readControllers("view.controller.js"),
    editControllers: readControllers("edit.controller.js"),
    assetScripts: scanAssetScripts(widgetDir),
    staleVersionRefs: scanStaleVersionRefs(widgetDir, info.name, info.version),
  };
}

// Recursively list .js files under widgetAssets/ (relative paths). The
// harness loads these before bootstrap so widget-local services like
// chartService are registered alongside view/edit controllers.
function scanAssetScripts(widgetDir) {
  const root = path.join(widgetDir, "widgetAssets");
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), sub);
      else if (e.isFile() && e.name.endsWith(".js")) out.push("widgetAssets/" + sub);
    }
  };
  walk(root, "");
  return out;
}

function discoverWidgets() {
  if (!fs.existsSync(WIDGETS_SRC)) {
    console.warn(`widgets-src/ not found at ${WIDGETS_SRC}`);
    return [];
  }
  const entries = fs.readdirSync(WIDGETS_SRC, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rec = buildWidgetRecord(e.name);
    if (rec) out.push(rec);
  }
  return out;
}

const app = express();
const WIDGETS = discoverWidgets();

// SSE clients receive widget-change, harness-reload, and proxy-log events.
// Each client is a Response with an open keep-alive stream. We push JSON
// objects with a `type` field so the browser can route them to the right
// handler (hot-reload, network panel, etc.).
const sseClients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* client gone */ }
  }
}

// Refresh cached metadata + lint for a widget. Called on file-watcher events
// and after the harness module changes (which can change `unknown-dependency`
// outcomes for every widget at once).
function refreshWidget(w) {
  const reread = (file) => {
    const p = path.join(w.dir, file);
    if (!fs.existsSync(p)) return [];
    try { return HU.extractRegisteredControllers(fs.readFileSync(p, "utf8")); }
    catch { return []; }
  };
  try {
    const info = JSON.parse(fs.readFileSync(path.join(w.dir, "info.json"), "utf8"));
    const newId = `${info.name}-${info.version}`;
    if (newId !== w.id) {
      widgetsById.delete(w.id);
      w.id = newId;
      w.version = info.version;
      w.title = info.title || info.name;
      widgetsById.set(newId, w);
      mountWidget(w);
    }
  } catch { /* lint will report */ }
  w.viewControllers = reread("view.controller.js");
  w.editControllers = reread("edit.controller.js");
  w.staleVersionRefs = scanStaleVersionRefs(w.dir, w.name, w.version);
  w.lint = lintFor(w);
}

// Proxy log ring buffer for the in-page Network tab.
const PROXY_LOG_MAX = 200;
const PROXY_LOG = [];
let proxyLogSeq = 0;
const REDACT_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-csrf-token"]);
function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v;
  }
  return out;
}
function recordProxy(entry) {
  entry.id = ++proxyLogSeq;
  PROXY_LOG.push(entry);
  if (PROXY_LOG.length > PROXY_LOG_MAX) PROXY_LOG.shift();
  broadcast({ type: "proxy", entry });
}

// Force every harness response to be uncacheable. Setting cacheControl:false
// on express.static only suppresses *its* Cache-Control header — browsers
// still apply heuristic caching, so an edited controller can keep running
// the previous build until "Clear site data". no-store kills heuristics too.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

function mountWidget(w) {
  app.use(`/${w.id}`, express.static(w.dir, { etag: false, cacheControl: false }));
  console.log(`mount  /${w.id}  ->  ${w.dir}`);
}

for (const w of WIDGETS) mountWidget(w);
if (WIDGETS.length === 0) {
  console.warn("no widgets discovered; drop a folder with info.json into widgets-src/");
}

app.use(
  "/",
  express.static(path.resolve(__dirname, "public"), {
    etag: false,
    cacheControl: false,
    index: ["index.html"],
  })
);
app.use(
  "/harness.module.js",
  express.static(path.resolve(__dirname, "harness.module.js"), { etag: false, cacheControl: false })
);
app.use(
  "/lib",
  express.static(path.resolve(__dirname, "lib"), { etag: false, cacheControl: false })
);

// Serve SOAR\'s extracted UI templates (templateUrl: "app/components/...").
// Otherwise these resolve via the proxy, which returns SOAR\'s SPA shell on
// any unauthenticated request and breaks Angular\'s template parser
// (Cannot read properties of undefined when csChart\'s template fails to
// produce a real fragment). Falls through to the proxy on miss so we still
// hit the live host for assets we haven\'t extracted.
app.use(
  "/app",
  express.static(path.resolve(__dirname, "..", "fsr_src", "templates-extracted", "app"), {
    etag: false,
    cacheControl: false,
    fallthrough: true,
  })
);

// Serve fsr_src/app.unmin.js with the cybersponse module's dep array stripped
// so the harness can register an empty cybersponse module without dragging in
// ~50 vendor/fortisoar.* sub-modules. The on-disk file stays pristine.
const FSR_APP_PATH = path.resolve(__dirname, "..", "fsr_src", "app.unmin.js");
let FSR_APP_PATCHED = null;
function loadPatchedFsrApp() {
  if (FSR_APP_PATCHED) return FSR_APP_PATCHED;
  const src = fs.readFileSync(FSR_APP_PATH, "utf8");
  // Vendor angular modules we DO load (from CDN, before app.unmin.js) and
  // therefore want as cybersponse dep so their providers ($resource, etc.)
  // are visible in the bundle\'s factories. Add new entries as we add the
  // matching <script> tags in index.html. Keep this minimal — the rest of
  // SOAR\'s ~50 dep modules stay stripped and dealt with via stubs/no-ops.
  // All fortisoar.* and cybersponse.authentication sub-modules are actually
  // defined inside app.unmin.js — they were stripped along with vendor deps
  // by the empty-deps patch. Add them back so their factories (translationService,
  // etc.) are visible to cybersponse\'s injector.
  const HARNESS_VENDOR_DEPS = [
    "ngResource",
    "ngMessages",
    "ui.bootstrap",
    "ui.select",
    "ngSanitize",
    "angularMoment",
    "ngFileUpload",
    "cybersponse.authentication",
    "fortisoar.global",
    "fortisoar.globalization",
    "fortisoar.queues",
    "fortisoar.archival",
    "fortisoar.marketplace",
    "fortisoar.dataIngestion",
    "fortisoar.notification",
    "fortisoar.preProcessing",
    "fortisoar.phishing-email-classifier",
  ];
  const depsLiteral = JSON.stringify(HARNESS_VENDOR_DEPS).replace(/"/g, '"');
  const patched = src.replace(
    /angular\.module\("cybersponse",\s*\[[^\]]*\]\)/,
    `angular.module("cybersponse", ${depsLiteral})`
  );
  if (patched === src) {
    console.warn("[/_fsr/app.unmin.js] WARNING: dep-array patch did not match");
  } else {
    console.log("[/_fsr/app.unmin.js] patched cybersponse module deps -> []");
  }
  // The bundle dereferences a few vendor globals at script-load (outside any
  // angular.config callback), so we have to satisfy them before the bundle
  // body runs or it throws and the cybersponse module never gets created.
  // Each stub here was added in response to a real boot-time TypeError; keep
  // them no-ops unless something actually needs the vendor's behavior.
  const prelude = [
    '// --- harness shim prelude (injected by server.js) ---',
    'window["@uirouter/sticky-states"] = window["@uirouter/sticky-states"] || { StickyStatesPlugin: function () {} };',
    // Neutralize the bundle\'s .config and .run calls on cybersponse: they',
    // inject vendor providers ($urlRouterProvider, $breadcrumbProvider,',
    // localStorageServiceProvider, etc.) and SOAR services',
    // (appInitializeService, stateService) we don\'t have. We restore the',
    // real .config/.run in the epilogue so harness.module.js can still use',
    // them. Wrap angular.module so any reference to "cybersponse" returns',
    // a module whose .config/.run are no-ops during bundle load.',
    '(function(){',
    '  var origModule = angular.module;',
    '  var neutralized = [];',
    '  function shouldNeutralize(name){',
    '    return name === "cybersponse" || name === "cybersponse.authentication" || name.indexOf("fortisoar.") === 0;',
    '  }',
    '  angular.module = function(name, requires, configFn) {',
    '    var mod = origModule.apply(this, arguments);',
    '    if (shouldNeutralize(name) && !mod.__harnessNeutralized) {',
    '      mod.__harnessNeutralized = true;',
    '      mod.__origConfig = mod.config;',
    '      mod.__origRun = mod.run;',
    '      mod.config = function(){ return mod; };',
    '      mod.run = function(){ return mod; };',
    '      neutralized.push(name);',
    '    }',
    '    return mod;',
    '  };',
    '  window.__harnessRestoreCybersponse = function(){',
    '    for (var i = 0; i < neutralized.length; i++) {',
    '      var n = neutralized[i];',
    '      var mod = origModule.call(angular, n);',
    '      if (mod && mod.__harnessNeutralized) {',
    '        mod.config = mod.__origConfig;',
    '        mod.run = mod.__origRun;',
    '        delete mod.__harnessNeutralized;',
    '      }',
    '    }',
    '    console.log("[harness] restored .config/.run on " + neutralized.length + " modules: " + neutralized.join(", "));',
    '    angular.module = origModule;',
    '  };',
    '})();',
    '// --- end shim prelude ---',
    '',
  ].join('\n');
  const epilogue = [
    '',
    '// --- harness shim epilogue (injected by server.js) ---',
    'try { window.__harnessRestoreCybersponse && window.__harnessRestoreCybersponse(); }',
    'catch (e) { console.error("[harness] restore failed", e); }',
    '// --- end shim epilogue ---',
    '',
  ].join('\n');
  FSR_APP_PATCHED = prelude + patched + epilogue;
  return FSR_APP_PATCHED;
}
app.get("/_fsr/app.unmin.js", (_req, res) => {
  try {
    const body = loadPatchedFsrApp();
    res.set("Content-Type", "application/javascript; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(body);
  } catch (e) {
    res.status(500).type("text/plain").send(`failed to load app.unmin.js: ${e.message}`);
  }
});

// Templates bundle: includes $templateCache.put(...) calls for SOAR templates
// like lookupPopover.html, required by csTypeahead + cs-conditional directives
// when uibPopover needs the template. This must load AFTER app.unmin.js but can
// load before or after harness.module.js (it only registers templates, doesn't
// require real Angular services).
app.get("/_fsr/templates.min.js", (_req, res) => {
  try {
    const body = fs.readFileSync(
      path.resolve(__dirname, "..", "fsr_src", "templates.min.a64ddbd8.js"),
      "utf8"
    );
    // The dangling `||` in SOAR's ui-select-choices ng-show is intentional:
    // ui-select 0.20.0's link step appends `$select.open && $select.items.length > 0`,
    // completing the expression. Stripping the `||` leaves two expressions
    // glued together and trips $parse (syntax error).
    res.set("Content-Type", "application/javascript; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(body);
  } catch (e) {
    res.status(500).type("text/plain").send(`failed to load templates: ${e.message}`);
  }
});

// Paths we serve locally; the proxy skips these.
const LOCAL_PATHS = new Set(["/", "/index.html", "/harness.module.js"]);
function isLocalPath(p) {
  if (LOCAL_PATHS.has(p)) return true;
  if (p.startsWith("/lib/")) return true;
  for (const w of WIDGETS) if (p.startsWith(`/${w.id}/`)) return true;
  if (p.startsWith("/_fsr/")) return true;
  return false;
}

// Lightweight surface for the in-page status strip — a one-shot read of
// "what is this harness pointed at" without needing to scrape the proxy.
app.get("/_fsr/info", (_req, res) => {
  let host = "";
  try { host = new URL(HOST || "").host; } catch (_) { host = HOST || "(unset)"; }
  res.json({ proxyHost: host, widgetCount: WIDGETS.length });
});

app.get("/_fsr/widgets", (_req, res) => {
  res.json({
    widgets: WIDGETS.map((w) => ({
      id: w.id,
      name: w.name,
      version: w.version,
      title: w.title,
      subTitle: w.subTitle,
      pages: w.pages,
      viewControllers: w.viewControllers || [],
      editControllers: w.editControllers || [],
      assetScripts: w.assetScripts || [],
      staleVersionRefs: w.staleVersionRefs || [],
      lint: w.lint || { errors: [], warnings: [] },
    })),
    registeredServices: REGISTERED_SERVICES,
  });
});

app.get("/_fsr/lint/:id", (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });
  refreshWidget(w);
  res.json({ id: w.id, lint: w.lint });
});

// SSE: widget-change, harness-reload, proxy-log entries. Sends a hello so
// the client knows the channel is alive even if no event fires for a while.
app.get("/_fsr/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "hello", verbose: PROXY_VERBOSE })}\n\n`);
  sseClients.add(res);
  const ka = setInterval(() => {
    try { res.write(`: keepalive\n\n`); } catch { /* ignore */ }
  }, 25000);
  req.on("close", () => {
    clearInterval(ka);
    sseClients.delete(res);
  });
});

app.get("/_fsr/proxy-log", (_req, res) => {
  res.json({ entries: PROXY_LOG, verbose: PROXY_VERBOSE });
});

app.post("/_fsr/proxy-log/verbose", express.json(), (req, res) => {
  const v = !!(req.body && req.body.verbose);
  PROXY_VERBOSE = v;
  broadcast({ type: "verbose", verbose: v });
  res.json({ verbose: v });
});

app.delete("/_fsr/proxy-log", (_req, res) => {
  PROXY_LOG.length = 0;
  broadcast({ type: "proxy-clear" });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Disk cache for slow, idempotent preload calls (translations + metadata).
// In `cached` mode the harness serves from dev/cache/ on hit and fetches
// upstream + writes the cache on miss. In `live` mode the middleware no-ops
// and every request goes straight to the proxy. Toggle persists across
// restarts so devs keep their choice.
// ---------------------------------------------------------------------------
const CACHE_DIR = path.resolve(__dirname, "dev", "cache");
const CACHE_MODE_FILE = path.join(CACHE_DIR, "mode.json");
const CACHEABLE_PATTERNS = [
  /^\/locales\/static\/en\.json$/,
  /^\/api\/3\/model_metadatas(?:\?|$)/,
  /^\/api\/locale\/1\/[^/]+\/en\.json$/,
];
function isCacheable(url) {
  return CACHEABLE_PATTERNS.some((re) => re.test(url));
}
function readCacheMode() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_MODE_FILE, "utf8"));
    return j.mode === "live" ? "live" : "cached";
  } catch { return "cached"; }
}
function writeCacheMode(mode) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_MODE_FILE, JSON.stringify({ mode }));
}
let CACHE_MODE = readCacheMode();
function cacheFileFor(url) {
  const h = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(CACHE_DIR, h + ".json");
}
function readCacheEntry(url) {
  try { return JSON.parse(fs.readFileSync(cacheFileFor(url), "utf8")); }
  catch { return null; }
}
function writeCacheEntry(url, entry) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFileFor(url), JSON.stringify(entry));
}

app.get("/_fsr/cache/mode", (_req, res) => {
  res.json({ mode: CACHE_MODE });
});
app.post("/_fsr/cache/mode", express.json(), (req, res) => {
  const mode = req.body && req.body.mode === "live" ? "live" : "cached";
  CACHE_MODE = mode;
  try { writeCacheMode(mode); } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ mode });
});
app.delete("/_fsr/cache", (_req, res) => {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        if (f.endsWith(".json") && f !== "mode.json") {
          fs.unlinkSync(path.join(CACHE_DIR, f));
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(async (req, res, next) => {
  if (req.method !== "GET") return next();
  if (CACHE_MODE !== "cached") return next();
  if (!isCacheable(req.originalUrl)) return next();

  const url = req.originalUrl;
  const hit = readCacheEntry(url);
  if (hit) {
    console.log(`<- 200 ${url}  (cache hit)`);
    res.setHeader("X-Harness-Cache", "hit");
    res.setHeader("Content-Type", hit.contentType || "application/json");
    return res.status(hit.status || 200).send(hit.body || "");
  }
  try {
    await ensureToken().catch(() => {});
    const headers = { Accept: "application/json" };
    if (cachedToken) headers.Authorization = `Bearer ${cachedToken}`;
    const upstream = await upstreamRequest({ method: "GET", pathAndQuery: url, headers });
    if (upstream.status >= 200 && upstream.status < 300) {
      const entry = {
        url,
        status: upstream.status,
        contentType: "application/json",
        body: upstream.body,
        savedAt: Date.now(),
      };
      try { writeCacheEntry(url, entry); } catch (_) {}
      console.log(`<- ${upstream.status} ${url}  (cache miss → stored)`);
      res.setHeader("X-Harness-Cache", "miss-stored");
      res.setHeader("Content-Type", "application/json");
      return res.status(upstream.status).send(upstream.body);
    }
    console.warn(`<- ${upstream.status} ${url}  (cache miss, not stored)`);
    res.setHeader("X-Harness-Cache", "miss-bypass");
    res.setHeader("Content-Type", "application/json");
    return res.status(upstream.status).send(upstream.body);
  } catch (e) {
    console.warn(`xx cache fetch ${url}: ${e.message}`);
    return next();
  }
});

const PACKAGE_OUTPUT_DIR = process.env.PACKAGE_OUTPUT_DIR
  ? path.resolve(process.env.PACKAGE_OUTPUT_DIR)
  : path.resolve(__dirname, "widget-packages");
const widgetsById = new Map(WIDGETS.map((w) => [w.id, w]));

// Initial lint pass for every discovered widget.
for (const w of WIDGETS) w.lint = lintFor(w);

// Hot-reload: watch each widget's directory for changes to source files. On
// any change we re-extract metadata, re-run lint, and broadcast over SSE so
// connected browsers can soft-remount without a full page reload.
const HOT_RELOAD_FILES = new Set(["info.json", ...LINT_FILES]);
function attachWatcher(w) {
  let debounce = null;
  try {
    fs.watch(w.dir, { persistent: false }, (_event, filename) => {
      if (!filename || !HOT_RELOAD_FILES.has(filename)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const oldId = w.id;
        refreshWidget(w);
        if (oldId !== w.id) console.log(`reload ${oldId} -> ${w.id}`);
        broadcast({ type: "widget-change", id: w.id, oldId, file: filename, lint: w.lint });
      }, 80);
    });
  } catch (e) {
    console.warn(`watch failed for ${w.folder}: ${e.message}`);
  }
}
for (const w of WIDGETS) attachWatcher(w);

// Register a freshly imported widget: build its record, lint, mount, watch,
// and broadcast a widget-change so the connected browser refreshes its
// dropdown. Throws if the folder isn't a valid widget on disk.
function registerImportedWidget(folder) {
  const w = buildWidgetRecord(folder);
  if (!w) throw new Error(`widgets-src/${folder} is not a valid widget`);
  if (widgetsById.has(w.id)) {
    throw new Error(`widget id ${w.id} already exists; rename folder or bump version`);
  }
  WIDGETS.push(w);
  widgetsById.set(w.id, w);
  w.lint = lintFor(w);
  mountWidget(w);
  attachWatcher(w);
  broadcast({ type: "widget-change", id: w.id, oldId: w.id, file: "imported", lint: w.lint });
  return w;
}

function readCurrentInfo(widget) {
  const infoPath = path.join(widget.dir, "info.json");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  return { info, infoPath };
}

// Auto-fix endpoint: when info.json's version no longer matches the digits
// embedded in the controller identifiers, rewrite each controller file by
// substituting every occurrence of the old name with the expected one. Only
// safe when the registered name matches the SOAR convention exactly.
app.post("/_fsr/fix-controllers/:id", (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });
  const expectedView = HU.deriveControllerName(w.name, w.version);
  const expectedEdit = HU.deriveEditControllerName(w.name, w.version);
  const cap = w.name.charAt(0).toUpperCase() + w.name.slice(1);
  const viewPattern = new RegExp("^" + w.name + "\\d+DevCtrl$");
  const editPattern = new RegExp("^edit" + cap + "\\d+DevCtrl$");

  const fixes = [];
  const tryFix = (file, expected, pattern) => {
    const p = path.join(w.dir, file);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, "utf8");
    const registered = HU.extractRegisteredControllers(src);
    const stale = registered.filter((n) => pattern.test(n) && n !== expected);
    if (stale.length === 0) return;
    let next = src;
    for (const old of stale) {
      next = next.split(old).join(expected);
    }
    fs.writeFileSync(p, next, "utf8");
    fixes.push({ file, replaced: stale, expected });
  };

  try {
    tryFix("view.controller.js", expectedView, viewPattern);
    tryFix("edit.controller.js", expectedEdit, editPattern);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Sweep all known files for stale `<name>-X.Y.Z` references and rewrite
  // them to the current version. Same idempotent string-replace approach.
  try {
    const re = staleRefRegex(w.name);
    for (const file of VERSIONED_REF_FILES) {
      const p = path.join(w.dir, file);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      const stale = new Set();
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        if (m[1] !== w.version) stale.add(m[1]);
      }
      if (stale.size === 0) continue;
      let next = src;
      for (const oldVer of stale) {
        next = next.split(`${w.name}-${oldVer}`).join(`${w.name}-${w.version}`);
      }
      fs.writeFileSync(p, next, "utf8");
      fixes.push({ file, replacedVersions: Array.from(stale), to: w.version });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Refresh the cached registrations so /_fsr/widgets reflects the change.
  const reread = (file) => {
    const p = path.join(w.dir, file);
    if (!fs.existsSync(p)) return [];
    try { return HU.extractRegisteredControllers(fs.readFileSync(p, "utf8")); }
    catch (_) { return []; }
  };
  w.viewControllers = reread("view.controller.js");
  w.editControllers = reread("edit.controller.js");
  w.staleVersionRefs = scanStaleVersionRefs(w.dir, w.name, w.version);

  res.json({
    fixes,
    viewControllers: w.viewControllers,
    editControllers: w.editControllers,
    staleVersionRefs: w.staleVersionRefs,
  });
});

app.get("/_fsr/package/:id/info", (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });
  try {
    const { info } = readCurrentInfo(w);
    res.json({ name: info.name, version: info.version, compatibility: (info.metadata && info.metadata.compatibility) || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function blockingLintErrors(w) {
  refreshWidget(w);
  const errs = (w.lint && w.lint.errors) || [];
  return errs;
}

// Applies a JSON merge patch to the widget's info.json. Intended to be called
// by the harness UI after a 400 from /_fsr/package or /_fsr/install — the
// failure response includes a `suggestedFix` patch the user can review and
// POST back here. Body: { patch: <object> }. Refuses any patch that wouldn't
// clear validation errors so we never silently introduce something invalid.
app.post("/_fsr/fix-info/:id", express.json(), (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });
  const patch = req.body && req.body.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return res.status(400).json({ error: "body.patch must be an object" });
  }
  try {
    const { info, infoPath } = readCurrentInfo(w);
    // Sanity check: the patch must only touch known-safe keys (currently
    // metadata.* fields the validator can suggest defaults for). Block any
    // attempt to rewrite name/version/etc through this endpoint.
    const allowedTopLevel = new Set(["metadata"]);
    const allowedMetaKeys = new Set(["windowClass", "size", "standalone", "pages", "compatibility"]);
    for (const k of Object.keys(patch)) {
      if (!allowedTopLevel.has(k)) {
        return res.status(400).json({ error: `patch key '${k}' not allowed` });
      }
      if (k === "metadata") {
        for (const mk of Object.keys(patch.metadata || {})) {
          if (!allowedMetaKeys.has(mk)) {
            return res.status(400).json({ error: `patch metadata.${mk} not allowed` });
          }
        }
      }
    }
    const updated = applyInfoFix(infoPath, patch);
    const after = validateWidget(w.dir, updated);
    console.log(`fix-info: ${w.folder} patched ${JSON.stringify(patch)}`);
    res.json({
      ok: true,
      info: updated,
      validation: after,
    });
  } catch (e) {
    console.error(`fix-info failed for ${w.folder}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/_fsr/package/:id", express.json(), async (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });

  const body = req.body || {};
  // Lint runs AFTER the version sync below — running it here against the
  // pre-bump source would block on stale-version-ref every time the user
  // typed a new version into the bump form, even though syncSourceToInfoJson
  // would have rewritten the references a few lines later. Order matters.
  try {
    const { info, infoPath } = readCurrentInfo(w);
    let version = info.version;

    if (body.version != null && body.version !== "") {
      if (!isValidVersion(body.version)) {
        return res.status(400).json({ error: `invalid version: ${body.version}` });
      }
      version = body.version;
    } else if (body.bump) {
      if (!["patch", "minor", "major"].includes(body.bump)) {
        return res.status(400).json({ error: `invalid bump: ${body.bump}` });
      }
      version = bumpVersion(version, body.bump);
    }

    if (version !== info.version) {
      writeInfoVersion(infoPath, version);
      // Keep source controllers + view.html in lockstep with info.json so
      // the harness-mounted ng-controller matches the registered name and
      // SOAR's derived `<name><digits>DevCtrl` expectation.
      syncSourceToInfoJson(w.dir, info.name, version);
      console.log(`package: ${w.folder} version ${info.version} -> ${version}`);
    }

    if (!body.skipLint) {
      const errs = blockingLintErrors(w);
      if (errs.length > 0) {
        return res.status(400).json({ error: "lint failed", lint: { errors: errs } });
      }
    }

    const freshInfoForValidation = readCurrentInfo(w).info;
    const preflight = validateWidget(w.dir, freshInfoForValidation);
    if (preflight.errors.length > 0) {
      return res.status(400).json({
        error: "widget validation failed",
        validation: preflight,
        suggestedFix: suggestInfoFix(freshInfoForValidation),
        fixEndpoint: `/_fsr/fix-info/${req.params.id}`,
      });
    }

    const result = await packageWidget(w.dir, PACKAGE_OUTPUT_DIR);
    console.log(`package: built ${result.archiveName} (${result.fileCount} files, ${result.size} bytes)`);

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.archiveName}"`
    );
    res.setHeader("X-Package-Version", result.version);
    res.setHeader("X-Package-Path", result.archivePath);
    fs.createReadStream(result.archivePath).pipe(res);
  } catch (e) {
    console.error(`package failed for ${w.folder}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Full round-trip: package -> POST solutionpacks/install -> PUT publish.
// Mirrors the two-step flow the FortiSOAR UI uses. Accepts the same
// bump/version body shape as /_fsr/package/:id so the harness can reuse
// the package-panel inputs.
app.post("/_fsr/install/:id", express.json(), async (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });

  const body = req.body || {};
  // Lint runs AFTER the version sync below, same reasoning as /_fsr/package.
  try {
    const { info, infoPath } = readCurrentInfo(w);
    let version = info.version;
    if (body.version != null && body.version !== "") {
      if (!isValidVersion(body.version)) {
        return res.status(400).json({ error: `invalid version: ${body.version}` });
      }
      version = body.version;
    } else if (body.bump) {
      if (!["patch", "minor", "major"].includes(body.bump)) {
        return res.status(400).json({ error: `invalid bump: ${body.bump}` });
      }
      version = bumpVersion(version, body.bump);
    }
    if (version !== info.version) {
      writeInfoVersion(infoPath, version);
      syncSourceToInfoJson(w.dir, info.name, version);
      console.log(`install: ${w.folder} version ${info.version} -> ${version}`);
    }

    if (!body.skipLint) {
      const errs = blockingLintErrors(w);
      if (errs.length > 0) {
        return res.status(400).json({ error: "lint failed", lint: { errors: errs } });
      }
    }

    const freshInfoForValidation = readCurrentInfo(w).info;
    const preflight = validateWidget(w.dir, freshInfoForValidation);
    if (preflight.errors.length > 0) {
      console.warn(
        `install: validation failed for ${w.folder}: ${preflight.errors.join("; ")}`
      );
      return res.status(400).json({
        error: "widget validation failed",
        validation: preflight,
        suggestedFix: suggestInfoFix(freshInfoForValidation),
        fixEndpoint: `/_fsr/fix-info/${req.params.id}`,
      });
    }

    const pkg = await packageWidget(w.dir, PACKAGE_OUTPUT_DIR);
    console.log(`install: packaged ${pkg.archiveName} (${pkg.size} bytes)`);

    const token = await ensureToken();
    const uploadRes = await upstreamMultipart({
      pathAndQuery: "/api/3/solutionpacks/install?$type=widget&$replace=true",
      headers: { Authorization: `Bearer ${token}` },
      fields: { $type: "widget", $replace: "true" },
      file: {
        name: "file",
        filename: pkg.archiveName,
        contentType: "application/gzip",
        content: fs.readFileSync(pkg.archivePath),
      },
    });
    if (uploadRes.status < 200 || uploadRes.status >= 300) {
      return res.status(502).json({
        error: `upload ${uploadRes.status}`,
        body: uploadRes.body.slice(0, 1000),
      });
    }

    let uploaded;
    try {
      uploaded = JSON.parse(uploadRes.body);
    } catch (e) {
      return res.status(502).json({
        error: "upload response was not JSON",
        body: uploadRes.body.slice(0, 500),
      });
    }
    const uuid = uploaded.uuid;
    if (!uuid) {
      return res
        .status(502)
        .json({ error: "upload response missing uuid", response: uploaded });
    }
    console.log(`install: uploaded widget uuid=${uuid}, now publishing…`);

    // Publish via PUT. SOAR needs a beat to finish processing the tgz
    // before it accepts the draft->published transition, so retry a few
    // times on 4xx. 200 on success.
    const freshInfo = readCurrentInfo(w).info;
    const publishPayload = {
      name: freshInfo.name,
      title: freshInfo.title,
      subTitle: freshInfo.subTitle,
      version: freshInfo.version,
      published_date: freshInfo.published_date,
      releaseNotes: freshInfo.releaseNotes,
      metadata: freshInfo.metadata,
      "@id": `/api/3/widgets/${uuid}`,
      draft: true,
      installed: true,
      enablePublish: false,
      replace: true,
      replaceVersions: [],
      publishedDate: Math.floor(Date.now() / 1000),
    };
    const publishBody = JSON.stringify(publishPayload);

    let publishRes = null;
    let lastErr = null;
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      publishRes = await upstreamRequest({
        method: "PUT",
        pathAndQuery: `/api/3/widgets/${uuid}`,
        body: publishBody,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (publishRes.status >= 200 && publishRes.status < 300) break;
      lastErr = `${publishRes.status} ${publishRes.body.slice(0, 300)}`;
      console.warn(`install: publish attempt ${attempt + 1} failed: ${lastErr}`);
    }
    if (!publishRes || publishRes.status < 200 || publishRes.status >= 300) {
      return res.status(502).json({
        error: `publish failed after ${maxAttempts} attempts: ${lastErr}`,
      });
    }
    console.log(`install: published ${freshInfo.name}-${freshInfo.version}`);
    res.json({
      ok: true,
      uuid: uuid,
      name: freshInfo.name,
      version: freshInfo.version,
      archive: pkg.archiveName,
      size: pkg.size,
    });
  } catch (e) {
    console.error(`install failed for ${w.folder}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// List widgets installed on the proxied SOAR instance. The harness UI uses
// this to populate the import picker. We pass the response through largely
// unchanged so the picker can sort/filter on whatever fields it wants.
app.get("/_fsr/remote-widgets", async (_req, res) => {
  try {
    const token = await ensureToken();
    const result = await upstreamRequest({
      method: "GET",
      pathAndQuery: "/api/3/widgets?$limit=500",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (result.status < 200 || result.status >= 300) {
      return res.status(502).json({
        error: `upstream ${result.status}`,
        body: result.body.slice(0, 500),
      });
    }
    let parsed;
    try { parsed = JSON.parse(result.body); }
    catch (e) { return res.status(502).json({ error: "non-JSON upstream response" }); }
    const members = parsed["hydra:member"] || parsed.member || parsed.data || [];
    const widgets = members.map((w) => ({
      uuid: w.uuid,
      name: w.name,
      version: w.version,
      title: w.title || w.name,
      subTitle: w.subTitle || "",
      section: (w.metadata && w.metadata.section) || w.section || "",
      inbuilt: !!(w.inbuilt || w.systemManaged),
    })).filter((w) => w.uuid);
    widgets.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ widgets, total: widgets.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Import a widget from SOAR: POST /api/3/widgets/export/<uuid> -> tgz, then
// extract into widgets-src/<folder>/widget/. The folder argument must be a
// safe slug; if omitted we derive one from the widget's name. Refuses to
// overwrite an existing folder so the user has to consciously pick a new
// slot when forking. After extract, the widget is hot-attached (lint, mount,
// watch) and a widget-change SSE event is broadcast.
const SAFE_FOLDER_RE = /^[a-zA-Z0-9_-]+$/;
function deriveFolderName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}
function extractTgz(tgzPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tgzPath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exit ${code}: ${stderr.trim()}`))
    );
  });
}

app.post("/_fsr/import/:uuid", express.json(), async (req, res) => {
  const uuid = req.params.uuid;
  if (!/^[a-zA-Z0-9-]+$/.test(uuid)) return res.status(400).json({ error: "bad uuid" });
  const body = req.body || {};
  const folderArg = body.folder ? String(body.folder).trim() : "";
  if (folderArg && !SAFE_FOLDER_RE.test(folderArg)) {
    return res.status(400).json({ error: "folder must match [A-Za-z0-9_-]+" });
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-import-"));
  const tgzPath = path.join(tmp, "widget.tgz");
  try {
    const token = await ensureToken();
    const exportRes = await upstreamRequestBinary({
      method: "POST",
      pathAndQuery: `/api/3/widgets/export/${uuid}`,
      body: JSON.stringify({ development: false }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/octet-stream",
      },
    });
    if (exportRes.status < 200 || exportRes.status >= 300) {
      return res.status(502).json({
        error: `export ${exportRes.status}`,
        body: exportRes.body.slice(0, 300).toString("utf8"),
      });
    }
    fs.writeFileSync(tgzPath, exportRes.body);
    await extractTgz(tgzPath, tmp);

    // tgz layout from SOAR mirrors the packager: a single root dir
    // `<name>-<version>/` containing info.json, view.html, etc.
    const entries = fs
      .readdirSync(tmp)
      .filter((n) => n !== "widget.tgz")
      .map((n) => ({ n, full: path.join(tmp, n) }))
      .filter((e) => fs.statSync(e.full).isDirectory());
    if (entries.length !== 1) {
      return res.status(502).json({
        error: `unexpected tgz layout: ${entries.map((e) => e.n).join(", ") || "<empty>"}`,
      });
    }
    const extracted = entries[0].full;
    const infoPath = path.join(extracted, "info.json");
    if (!fs.existsSync(infoPath)) {
      return res.status(502).json({ error: "tgz missing info.json" });
    }
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    const folder = folderArg || deriveFolderName(info.name);
    if (!folder) return res.status(400).json({ error: "could not derive folder name" });
    const dest = path.join(WIDGETS_SRC, folder);
    if (fs.existsSync(dest)) {
      return res.status(409).json({ error: `widgets-src/${folder} already exists` });
    }

    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(extracted, path.join(dest, "widget"), { recursive: true });

    const w = registerImportedWidget(folder);
    console.log(`import: ${info.name}-${info.version} -> widgets-src/${folder}`);
    res.json({
      ok: true,
      folder,
      id: w.id,
      name: w.name,
      version: w.version,
      title: w.title,
    });
  } catch (e) {
    console.error(`import failed for ${uuid}: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

app.get("/_fsr/stylesheets", async (_req, res) => {
  try {
    await ensureToken().catch(() => {});
    const result = await upstreamRequest({
      method: "GET",
      pathAndQuery: "/",
      headers: cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {},
    });
    if (result.status < 200 || result.status >= 400) {
      return res.status(502).json({
        error: `upstream ${result.status}`,
        body: result.body.slice(0, 500),
      });
    }
    const hrefs = [];
    const linkRe = /<link\b[^>]*>/gi;
    const relRe = /rel\s*=\s*["']?([^"'>\s]+)/i;
    const hrefRe = /href\s*=\s*["']([^"']+)["']/i;
    let m;
    while ((m = linkRe.exec(result.body)) !== null) {
      const tag = m[0];
      const rel = (tag.match(relRe) || [])[1] || "";
      if (!/stylesheet/i.test(rel)) continue;
      const href = (tag.match(hrefRe) || [])[1];
      if (href) hrefs.push(href);
    }
    res.json({ stylesheets: hrefs });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

async function ensureAuthMiddleware(req, res, next) {
  // Fast path: if a non-expired token is cached, call next() synchronously.
  // Awaiting an already-resolved promise still defers to a microtask, which
  // is enough to break http-proxy-middleware v3 POST body streaming on some
  // Node versions (browser sees ERR_EMPTY_RESPONSE after proxyTimeout).
  if (cachedToken && Date.now() < tokenExpiry - REFRESH_SKEW_MS) {
    return next();
  }
  try {
    await ensureToken();
    next();
  } catch (e) {
    console.error(
      `auth failed for ${req.method} ${req.originalUrl}: ${e.message}`
    );
    res.status(502).json({ error: `FortiSOAR auth failed: ${e.message}` });
  }
}

// Body capture for the in-page Network tab. We only buffer when verbose mode
// is on (or the request is non-asset /api/*) to keep the ring buffer useful.
// Bodies are truncated to BODY_CAP bytes; binary payloads are flagged.
const BODY_CAP = 4096;
function shouldCapture(req) {
  if (!PROXY_VERBOSE && !req.originalUrl.startsWith("/api/")) return false;
  return true;
}
function truncate(buf) {
  if (!buf) return { text: "", truncated: false, binary: false };
  const ascii = buf.slice(0, BODY_CAP).toString("utf8");
  const binary = /[\x00-\x08\x0E-\x1F]/.test(ascii.slice(0, 256));
  return { text: ascii, truncated: buf.length > BODY_CAP, binary };
}

const proxy = createProxyMiddleware({
  pathFilter: (p) => !isLocalPath(p),
  target: HOST,
  changeOrigin: true,
  secure: false,
  ws: true,
  selfHandleResponse: false,
  // Cap proxy waits so an unreachable SOAR host (e.g. /node_modules/...)
  // fails the browser request in seconds, not TCP-retry minutes.
  timeout: 10000,
  proxyTimeout: 10000,
  on: {
    proxyReq(proxyReq, req) {
      if (cachedToken) {
        proxyReq.setHeader("Authorization", `Bearer ${cachedToken}`);
      }
      req.__startMs = Date.now();
      req.__capture = shouldCapture(req);
      console.log(`-> ${req.method} ${req.originalUrl}`);
    },
    proxyRes(proxyRes, req) {
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["content-security-policy-report-only"];
      if (proxyRes.statusCode === 401) {
        console.warn(`<- 401 ${req.originalUrl}  (invalidating cached token)`);
        invalidateToken();
      } else if (proxyRes.statusCode >= 400) {
        console.warn(`<- ${proxyRes.statusCode} ${req.originalUrl}`);
      } else {
        console.log(`<- ${proxyRes.statusCode} ${req.originalUrl}`);
      }

      if (req.__capture) {
        const chunks = [];
        let total = 0;
        proxyRes.on("data", (c) => {
          if (total < BODY_CAP) chunks.push(c);
          total += c.length;
        });
        proxyRes.on("end", () => {
          const buf = Buffer.concat(chunks);
          recordProxy({
            ts: Date.now(),
            ms: Date.now() - (req.__startMs || Date.now()),
            method: req.method,
            url: req.originalUrl,
            status: proxyRes.statusCode,
            reqHeaders: redactHeaders(req.headers),
            resHeaders: redactHeaders(proxyRes.headers),
            resBody: truncate(buf),
            resBodyLength: total,
          });
        });
      }
    },
    error(err, req, res) {
      console.error(`xx ${req.originalUrl}  ${err.message}`);
      recordProxy({
        ts: Date.now(),
        ms: Date.now() - (req.__startMs || Date.now()),
        method: req.method,
        url: req.originalUrl,
        status: 0,
        error: err.message,
      });
      if (res && !res.headersSent)
        res.status(502).json({ error: err.message });
    },
  },
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return ensureAuthMiddleware(req, res, next);
  next();
});
app.use(proxy);

if (require.main === module) {
  if (!HOST || !USER || !PASS) {
    console.error(
      "Missing FORTISOAR_HOST / FORTISOAR_USERNAME / FORTISOAR_PASSWORD. " +
        "Copy .env.example to dev/.env and fill it in."
    );
    process.exit(1);
  }
  app.listen(PORT, async () => {
    console.log(`\nharness  http://localhost:${PORT}`);
    console.log(`proxy    ${HOST}\n`);
    try {
      await ensureToken();
    } catch (e) {
      console.error(`warning: initial auth failed: ${e.message}`);
      console.error("server is up; it will retry on the first proxied request.");
    }
  });
} else {
  module.exports = { app, isLocalPath, discoverWidgets, decodeJwtExpiryMs };
}
