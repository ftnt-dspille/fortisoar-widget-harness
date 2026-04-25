"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REQUIRED_FILES = [
  "info.json",
  "view.html",
  "edit.html",
  "view.controller.js",
  "edit.controller.js",
];

function versionToNumeric(v) {
  return String(v).replace(/\./g, "");
}

function bumpVersion(current, part) {
  const parts = String(current).split(".").map((n) => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  for (let i = 0; i < parts.length; i++) if (!Number.isFinite(parts[i])) parts[i] = 0;
  if (part === "major") {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (part === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else if (part === "patch") {
    parts[2] += 1;
  } else {
    throw new Error(`unknown bump part: ${part}`);
  }
  return parts.slice(0, 3).join(".");
}

function isValidVersion(v) {
  return typeof v === "string" && /^\d+(\.\d+){0,2}$/.test(v);
}

function writeInfoVersion(infoPath, newVersion) {
  const raw = fs.readFileSync(infoPath, "utf8");
  const info = JSON.parse(raw);
  info.version = newVersion;
  // Preserve trailing newline if present
  const trailingNewline = /\n$/.test(raw) ? "\n" : "";
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2) + trailingNewline);
  return info;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function decapitalize(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Rewrites controller references to `<name><numericVersion>DevCtrl` — the
// shape SOAR resolves at install time when `development: true`. Mirrors
// the four regex passes in ~/.local/bin/package-widget-simp. Extends the
// reference by also rewriting view.html (ng-controller + versioned
// `<widgetName>-X.Y.Z/` path refs), since source view.html must match the
// registered controller name for the harness and the packaged tgz alike.
//
// NOTE on suffix: Source / harness / dev-preview uses `DevCtrl`; SOAR's
// publish pipeline strips `Dev` on install so the registered controller
// matches `widgetTemplateService.generateWidgetDefinition`'s expected
// `<name><ver>Ctrl`. Keep `DevCtrl` here.
function rewriteForVersion(dir, widgetName, version) {
  const numver = versionToNumeric(version);
  const newver = `${numver}Dev`;
  const variations = uniq([
    widgetName,
    capitalize(widgetName),
    decapitalize(widgetName),
  ]);
  const versionPathRe = new RegExp(
    `\\b${escapeRegex(widgetName)}-\\d+(?:\\.\\d+)*(?:[-.][A-Za-z0-9.]+)?/`,
    "g"
  );
  const versionPathReplacement = `${widgetName}-${version}/`;

  function rewrite(absPath, opts) {
    if (!fs.existsSync(absPath)) return;
    let contents = fs.readFileSync(absPath, "utf8");
    if (opts && opts.rewritePaths) {
      contents = contents.replace(versionPathRe, versionPathReplacement);
    }
    for (const w of variations) {
      const esc = escapeRegex(w);
      // `\d+(?:Dev)?Ctrl` catches both the reference-script source form
      // (`<name>100Ctrl`) and our already-synced form (`<name>102DevCtrl`),
      // so a bump rewrites either into the new `<newver>DevCtrl`.
      contents = contents
        .replace(new RegExp(`edit${esc}\\d+(?:Dev)?Ctrl`, "g"), `edit${w}${newver}Ctrl`)
        .replace(new RegExp(`(?<!edit)${esc}\\d+(?:Dev)?Ctrl`, "g"), `${w}${newver}Ctrl`)
        .replace(new RegExp(`\\bedit${esc}Ctrl\\b`, "g"), `edit${w}${newver}Ctrl`)
        .replace(new RegExp(`(?<!edit)\\b${esc}Ctrl\\b`, "g"), `${w}${newver}Ctrl`);
    }
    fs.writeFileSync(absPath, contents);
  }

  rewrite(path.join(dir, "edit.controller.js"));
  rewrite(path.join(dir, "view.controller.js"));
  rewrite(path.join(dir, "view.html"), { rewritePaths: true });
}

// Convenience alias — same function is used by packageWidget (against a
// tmp copy) and by the bump endpoint (against the source dir).
const syncSourceToInfoJson = rewriteForVersion;

function uniq(arr) {
  const seen = new Set();
  return arr.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
}

function shouldSkipName(name) {
  return (
    name === ".DS_Store" ||
    name === "__MACOSX" ||
    name.startsWith("._") ||
    name.startsWith(".") ||
    name.startsWith("_")
  );
}

function copyCleanRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkipName(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyCleanRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function listPackagedFiles(dir) {
  const out = [];
  (function walk(cur) {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (shouldSkipName(e.name)) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  })(dir);
  return out;
}

function validateStructure(dir) {
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length > 0) {
    throw new Error(`missing required file(s): ${missing.join(", ")}`);
  }
}

function runTar(cwd, archivePath, relFiles) {
  return new Promise((resolve, reject) => {
    const args = [
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--exclude=.*",
      "--exclude=_*",
      "--exclude=*/.*",
      "--exclude=*/_*",
      "-czf",
      archivePath,
      ...relFiles,
    ];
    const child = spawn("tar", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
        COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
      },
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function packageWidget(widgetDir, outputDir) {
  const infoPath = path.join(widgetDir, "info.json");
  if (!fs.existsSync(infoPath)) throw new Error("info.json not found");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  if (!info.name) throw new Error("info.json missing 'name'");
  if (!info.version) throw new Error("info.json missing 'version'");

  const widgetName = info.name;
  const version = info.version;
  const packageRoot = `${widgetName}-${version}`;
  const archiveName = `${packageRoot}.tgz`;

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-pkg-"));
  const tmpDir = path.join(tmpParent, packageRoot);

  try {
    copyCleanRecursive(widgetDir, tmpDir);
    rewriteForVersion(tmpDir, widgetName, version);
    validateStructure(tmpDir);

    const absOutputDir = path.resolve(outputDir);
    fs.mkdirSync(absOutputDir, { recursive: true });
    const archivePath = path.join(absOutputDir, archiveName);

    const absFiles = listPackagedFiles(tmpDir);
    if (absFiles.length === 0) throw new Error("no valid files to package");
    const relFiles = absFiles.map((p) => path.relative(tmpParent, p));

    await runTar(tmpParent, archivePath, relFiles);

    const size = fs.statSync(archivePath).size;
    return { archivePath, archiveName, widgetName, version, size, fileCount: absFiles.length };
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
}

module.exports = {
  packageWidget,
  versionToNumeric,
  bumpVersion,
  isValidVersion,
  writeInfoVersion,
  rewriteForVersion,
  syncSourceToInfoJson,
};
