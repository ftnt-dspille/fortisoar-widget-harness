// Standalone SOAR client for live connector-integration tests.
//
// Deliberately does NOT depend on the running harness proxy — it authenticates
// to FORTISOAR_HOST directly with .env creds so the live suite is portable to
// CI. Mirrors the wire the widget uses: POST /api/integration/execute/ with
// {connector, version, config, operation, params}; the connector's response
// envelope is returned under `.data`.
//
// Usage:
//   const { makeClient } = require("./lib/soarClient");
//   const soar = await makeClient();              // authenticates, resolves connector + default config
//   const health = await soar.exec("health_check", {});
"use strict";

const https = require("https");
const { URL } = require("url");

const CONNECTOR_NAME = "fsr-playbook-builder";
// SOAR's connector search tokenizes oddly: the full hyphenated name
// ("fsr-playbook-builder") matches 0 rows, but a bare token matches. Search by
// a token, then filter by exact name client-side.
const CONNECTOR_SEARCH = "playbook";

// One TLS-relaxed agent: SOAR dev appliances ship self-signed certs (same
// allowance the harness proxy and verify-remote already make).
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (set it in .env for live tests)`);
  return v;
}

// Low-level JSON request with a bounded timeout. Returns {status, json, text}.
function request(method, urlStr, { token, body, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, agent },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) { /* non-JSON */ }
          resolve({ status: res.statusCode, json, text: data });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${method} ${u.pathname}`)));
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Retry wrapper for transient failures (network blips, SOAR 5xx). CI-shaped:
// bounded attempts, linear backoff. Does NOT retry 4xx (those are real bugs).
async function withRetry(fn, { attempts = 3, label = "op" } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fn();
      if (res && typeof res.status === "number" && res.status >= 500 && i < attempts) {
        last = new Error(`${label}: HTTP ${res.status} (attempt ${i}/${attempts})`);
      } else {
        return res;
      }
    } catch (e) {
      last = e;
      if (i >= attempts) break;
    }
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
  throw last || new Error(`${label}: exhausted ${attempts} attempts`);
}

async function makeClient() {
  const host = env("FORTISOAR_HOST").replace(/\/+$/, "");
  const user = env("FORTISOAR_USERNAME");
  const pass = env("FORTISOAR_PASSWORD");

  // ── authenticate ─────────────────────────────────────────────────────
  const auth = await withRetry(
    () => request("POST", `${host}/auth/authenticate`, { body: { credentials: { loginid: user, password: pass } } }),
    { label: "authenticate" }
  );
  if (auth.status < 200 || auth.status >= 300 || !auth.json || !auth.json.token) {
    throw new Error(`authenticate failed: HTTP ${auth.status} ${auth.text.slice(0, 200)}`);
  }
  const token = auth.json.token;

  // ── resolve connector + default config (never hardcode the config id) ──
  const search = await withRetry(
    () => request("GET", `${host}/api/integration/connectors/?search=${encodeURIComponent(CONNECTOR_SEARCH)}`, { token }),
    { label: "resolve-connector" }
  );
  const rec = search.json && search.json.data && search.json.data.find((c) => c.name === CONNECTOR_NAME);
  if (!rec) throw new Error(`connector ${CONNECTOR_NAME} not found / not installed on ${host}`);
  const configs = rec.configuration || [];
  const chosen = configs.find((c) => c.default) || configs[0];
  if (!chosen) throw new Error(`connector ${CONNECTOR_NAME} has no configuration`);

  const meta = { host, connector: CONNECTOR_NAME, version: rec.version, configId: chosen.config_id, configName: chosen.name, agent: rec.agent };

  // ── exec: call a connector operation, return the connector's payload ───
  // Throws on transport/SOAR error. Returns the `.data` envelope verbatim so
  // callers assert on the connector's own contract shape.
  async function exec(operation, params = {}, { timeoutMs = 120000 } = {}) {
    const res = await withRetry(
      () => request("POST", `${host}/api/integration/execute/?format=json`, {
        token,
        timeoutMs,
        body: { connector: CONNECTOR_NAME, version: meta.version, config: meta.configId, operation, params },
      }),
      { label: `exec:${operation}` }
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`exec ${operation}: HTTP ${res.status} ${res.text.slice(0, 300)}`);
    }
    if (res.json && res.json.status && res.json.status !== "Success") {
      throw new Error(`exec ${operation}: connector status=${res.json.status} message=${res.json.message || ""}`);
    }
    return res.json ? res.json.data : null;
  }

  // Generic platform GET/DELETE for side-effect verification (e.g. confirm a
  // pushed workflow exists, then clean it up).
  async function get(pathAndQuery) {
    const res = await withRetry(() => request("GET", `${host}${pathAndQuery}`, { token }), { label: `get ${pathAndQuery}` });
    return res.json;
  }
  async function del(pathAndQuery) {
    const res = await request("DELETE", `${host}${pathAndQuery}`, { token });
    return { status: res.status, json: res.json };
  }

  return { meta, exec, get, del, token };
}

module.exports = { makeClient, CONNECTOR_NAME };
