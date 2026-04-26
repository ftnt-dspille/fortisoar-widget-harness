"use strict";

/* Pure utilities used by the harness page. Kept dependency-free so they can
   run in both the browser (loaded via <script>) and Node (jest tests). */

/* Resolve a dotted path against an object: resolvePath(rec, "source.host") -> rec.source.host.
   Returns undefined if any segment is missing. Supports numeric segments for arrays. */
function resolvePath(obj, path) {
  if (obj == null || typeof path !== "string" || path === "") return undefined;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/* Derive the dev controller name SOAR widgets register under. Mirrors the
   convention enforced by the packager: <name><digitsOfVersion>DevCtrl. */
function deriveControllerName(name, version) {
  if (!name) throw new Error("deriveControllerName: missing name");
  const digits = String(version || "").split(".").join("");
  return `${name}${digits}DevCtrl`;
}

/* Edit controllers follow SOAR's `edit<CapitalizedName><digits>DevCtrl`
   convention — see e.g. editJinjaEditorWidget113DevCtrl. */
function deriveEditControllerName(name, version) {
  if (!name) throw new Error("deriveEditControllerName: missing name");
  const digits = String(version || "").split(".").join("");
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return `edit${cap}${digits}DevCtrl`;
}

/* Merge a saved config over the widget's declared defaults. Saved values
   win; both inputs may be null/undefined. Always returns an object. */
function mergeConfig(defaults, saved) {
  return Object.assign({}, defaults || {}, saved || {});
}

/* localStorage key for a widget's saved config. Stable per widget id so
   bumping a widget's version starts fresh — matches SOAR's "config attached
   to widget instance" semantics closely enough for dev. */
function configStorageKey(widgetId) {
  return `harness:config:${widgetId}`;
}

/* Build the SOAR record-fetch path used by View Panel / Drawer contexts.
   `withRelationships` mirrors the `$relationships=true` query SOAR widgets
   typically rely on for nested-field rendering. */
function recordFetchPath(module, id, withRelationships) {
  if (!module || !id) throw new Error("recordFetchPath: module and id required");
  const qs = withRelationships ? "?$relationships=true" : "";
  return `/api/3/${module}/${encodeURIComponent(id)}${qs}`;
}

/* Resolve a `config.mapping`-style object against a record. Each value may be:
   - a plain string ("source.host")  -> resolved by path
   - a non-string (number, bool, etc) -> returned as-is
   The result is a plain object the widget can read without re-implementing
   the path walk. Unknown paths yield `undefined`, not an error. */
function resolveMapping(mapping, record) {
  const out = {};
  if (!mapping || typeof mapping !== "object") return out;
  for (const [key, val] of Object.entries(mapping)) {
    if (typeof val === "string") {
      const stripped = val.replace(/^record\./, "");
      out[key] = resolvePath(record, stripped);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/* Build the `$state` shape expected for a given context. Used by the harness
   to replace `__HARNESS_STATE` on context switch. */
function stateForContext(ctx, params) {
  switch (ctx) {
    case "viewpanel":
      return { current: { name: "viewPanel.modulesDetail" }, params: params || {} };
    case "drawer":
      return { current: { name: "viewPanel.modulesDetail" }, params: Object.assign({ drawer: true }, params || {}) };
    case "dashboard":
    default:
      return { current: { name: "main.dashboard" }, params: {} };
  }
}

/* Statically extract names registered with `.controller("name", ...)` from
   a controller source file. Used to detect version/controller-name drift
   before bootstrapping Angular. Dynamic names (concatenations, variables)
   are not resolved -- callers should treat an empty result as "unknown"
   rather than "missing". */
function extractRegisteredControllers(source) {
  if (typeof source !== "string" || !source) return [];
  const out = [];
  const re = /\.controller\s*\(\s*["']([A-Za-z_$][\w$]*)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

const api = {
  resolvePath,
  deriveControllerName,
  deriveEditControllerName,
  extractRegisteredControllers,
  mergeConfig,
  configStorageKey,
  recordFetchPath,
  resolveMapping,
  stateForContext,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.HarnessUtils = api;
}
