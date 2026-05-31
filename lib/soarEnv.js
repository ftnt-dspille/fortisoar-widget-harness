"use strict";
/**
 * Single source of truth for SOAR connection details.
 *
 * Standardized on the fsr_core project's .env convention so one .env can drive
 * both projects:
 *   FSR_BASE_URL   host, scheme optional, no trailing slash (e.g. foo.forticloud.com)
 *   FSR_PORT       optional non-standard port (overrides any port in the URL)
 *   FSR_USERNAME   login id
 *   FSR_PASSWORD   password (exchanged for a JWT)
 *   FSR_API_KEY    optional API key (preferred over user/pass where supported)
 *
 * Legacy FORTISOAR_HOST / FORTISOAR_USERNAME / FORTISOAR_PASSWORD are still read
 * as a fallback so nothing breaks mid-transition.
 */

function resolveSoarEnv(env) {
  env = env || process.env;

  let raw = (env.FSR_BASE_URL || env.FORTISOAR_HOST || "").trim();
  const port = (env.FSR_PORT || "").trim();
  let host = "";
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw; // scheme optional in FSR_BASE_URL
    raw = raw.replace(/\/+$/, "");
    if (port) {
      try {
        const u = new URL(raw);
        u.port = port; // explicit FSR_PORT overrides any port already in the URL
        host = u.origin;
      } catch (_) {
        host = raw;
      }
    } else {
      host = raw;
    }
  }

  return {
    host: host,
    user: (env.FSR_USERNAME || env.FORTISOAR_USERNAME || "").trim(),
    pass: env.FSR_PASSWORD || env.FORTISOAR_PASSWORD || "",
    apiKey: (env.FSR_API_KEY || "").trim(),
  };
}

module.exports = { resolveSoarEnv };
