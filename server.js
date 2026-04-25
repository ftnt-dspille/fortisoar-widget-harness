/* Local widget dev server.
   - Auto-discovers widgets in widgets-src/<repo>/widget/  (each must contain info.json)
   - Serves the harness page at /
   - Authenticates to FORTISOAR_HOST, caches the JWT, re-auths on 401
   - Exposes /_fsr/widgets and /_fsr/stylesheets for the harness bootstrap
   - Proxies everything else (assets + APIs) to FORTISOAR_HOST */
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const {
  packageWidget,
  bumpVersion,
  isValidVersion,
  writeInfoVersion,
  syncSourceToInfoJson,
} = require("./packager");

const PORT = Number(process.env.PORT || 4400);
const HOST = process.env.FORTISOAR_HOST;
const USER = process.env.FORTISOAR_USERNAME;
const PASS = process.env.FORTISOAR_PASSWORD;

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
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
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

function discoverWidgets() {
  if (!fs.existsSync(WIDGETS_SRC)) {
    console.warn(`widgets-src/ not found at ${WIDGETS_SRC}`);
    return [];
  }
  const entries = fs.readdirSync(WIDGETS_SRC, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const widgetDir = path.join(WIDGETS_SRC, e.name, "widget");
    const infoPath = path.join(widgetDir, "info.json");
    if (!fs.existsSync(infoPath)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      if (!info.name || !info.version) {
        console.warn(`skipping ${e.name}: info.json missing name or version`);
        continue;
      }
      out.push({
        folder: e.name,
        dir: widgetDir,
        id: `${info.name}-${info.version}`,
        name: info.name,
        version: info.version,
        title: info.title || info.name,
        subTitle: info.subTitle || "",
        pages: (info.metadata && info.metadata.pages) || [],
      });
    } catch (err) {
      console.warn(`skipping ${e.name}: bad info.json (${err.message})`);
    }
  }
  return out;
}

const app = express();
const WIDGETS = discoverWidgets();

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

// Paths we serve locally; the proxy skips these.
const LOCAL_PATHS = new Set(["/", "/index.html", "/harness.module.js"]);
function isLocalPath(p) {
  if (LOCAL_PATHS.has(p)) return true;
  if (p.startsWith("/lib/")) return true;
  for (const w of WIDGETS) if (p.startsWith(`/${w.id}/`)) return true;
  if (p.startsWith("/_fsr/")) return true;
  return false;
}

app.get("/_fsr/widgets", (_req, res) => {
  res.json({
    widgets: WIDGETS.map((w) => ({
      id: w.id,
      name: w.name,
      version: w.version,
      title: w.title,
      subTitle: w.subTitle,
      pages: w.pages,
    })),
  });
});

const PACKAGE_OUTPUT_DIR = process.env.PACKAGE_OUTPUT_DIR
  ? path.resolve(process.env.PACKAGE_OUTPUT_DIR)
  : path.resolve(__dirname, "widget-packages");
const widgetsById = new Map(WIDGETS.map((w) => [w.id, w]));

// Hot-reload: watch each widget's info.json for version bumps. When the id
// changes, update the in-memory structures and mount a new static route so
// the harness picks up the new version without a server restart.
for (const w of WIDGETS) {
  const infoPath = path.join(w.dir, "info.json");
  let debounce = null;
  fs.watch(infoPath, { persistent: false }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        const newId = `${info.name}-${info.version}`;
        if (newId === w.id) return;
        const oldId = w.id;
        widgetsById.delete(oldId);
        w.id = newId;
        w.version = info.version;
        w.title = info.title || info.name;
        widgetsById.set(newId, w);
        mountWidget(w);
        console.log(`reload ${oldId} -> ${newId}`);
      } catch (err) {
        console.warn(`reload failed for ${w.folder}: ${err.message}`);
      }
    }, 100);
  });
}

function readCurrentInfo(widget) {
  const infoPath = path.join(widget.dir, "info.json");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  return { info, infoPath };
}

app.get("/_fsr/package/:id/info", (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });
  try {
    const { info } = readCurrentInfo(w);
    res.json({ name: info.name, version: info.version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/_fsr/package/:id", express.json(), async (req, res) => {
  const w = widgetsById.get(req.params.id);
  if (!w) return res.status(404).json({ error: "unknown widget id" });

  const body = req.body || {};
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

const proxy = createProxyMiddleware({
  pathFilter: (p) => !isLocalPath(p),
  target: HOST,
  changeOrigin: true,
  secure: false,
  ws: true,
  // Cap proxy waits so an unreachable SOAR host (e.g. /node_modules/...)
  // fails the browser request in seconds, not TCP-retry minutes.
  timeout: 10000,
  proxyTimeout: 10000,
  on: {
    proxyReq(proxyReq, req) {
      if (cachedToken) {
        proxyReq.setHeader("Authorization", `Bearer ${cachedToken}`);
      }
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
    },
    error(err, req, res) {
      console.error(`xx ${req.originalUrl}  ${err.message}`);
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
