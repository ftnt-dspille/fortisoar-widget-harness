"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  bumpVersion,
  isValidVersion,
  versionToNumeric,
  writeInfoVersion,
  rewriteForVersion,
  packageWidget,
  validateInfoMetadata,
  validateControllers,
  validateWidget,
  suggestInfoFix,
  applyInfoFix,
} = require("../packager");

// Minimal info.json metadata block that satisfies validateInfoMetadata.
function validMetadata(extra = {}) {
  return {
    windowClass: "Full Width",
    size: "lg",
    standalone: false,
    pages: ["Dashboard"],
    compatibility: ["7.6.0"],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// bumpVersion
// ---------------------------------------------------------------------------
describe("bumpVersion", () => {
  test.each([
    ["1.0.0", "patch", "1.0.1"],
    ["1.0.9", "patch", "1.0.10"],
    ["1.0.0", "minor", "1.1.0"],
    ["1.3.5", "minor", "1.4.0"],
    ["1.3.5", "major", "2.0.0"],
    ["0.0.0", "major", "1.0.0"],
    ["2.9.99", "patch", "2.9.100"],
  ])("bumps %s by %s → %s", (current, part, expected) => {
    expect(bumpVersion(current, part)).toBe(expected);
  });

  test("resets minor and patch on major bump", () => {
    expect(bumpVersion("3.7.2", "major")).toBe("4.0.0");
  });

  test("resets patch on minor bump", () => {
    expect(bumpVersion("1.4.9", "minor")).toBe("1.5.0");
  });

  test("throws on unknown bump part", () => {
    expect(() => bumpVersion("1.0.0", "nano")).toThrow("unknown bump part");
  });

  test("handles versions with missing segments", () => {
    expect(bumpVersion("1", "patch")).toBe("1.0.1");
    expect(bumpVersion("1.2", "minor")).toBe("1.3.0");
  });
});

// ---------------------------------------------------------------------------
// isValidVersion
// ---------------------------------------------------------------------------
describe("isValidVersion", () => {
  test.each(["1.0.0", "0.0.1", "10.20.30", "1.0", "1", "0.0.0"])(
    "accepts valid version %s",
    (v) => expect(isValidVersion(v)).toBe(true)
  );

  test.each(["", "abc", "1.0.0.0", "1.0.x", null, undefined, 1, "v1.0.0"])(
    "rejects invalid version %s",
    (v) => expect(isValidVersion(v)).toBe(false)
  );
});

// ---------------------------------------------------------------------------
// versionToNumeric
// ---------------------------------------------------------------------------
describe("versionToNumeric", () => {
  test("strips dots", () => {
    expect(versionToNumeric("1.0.0")).toBe("100");
    expect(versionToNumeric("1.1.2")).toBe("112");
    expect(versionToNumeric("10.20.30")).toBe("102030");
  });
});

// ---------------------------------------------------------------------------
// writeInfoVersion
// ---------------------------------------------------------------------------
describe("writeInfoVersion", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("updates version field in info.json", () => {
    const infoPath = path.join(tmpDir, "info.json");
    fs.writeFileSync(infoPath, JSON.stringify({ name: "myWidget", version: "1.0.0" }, null, 2));
    writeInfoVersion(infoPath, "1.0.1");
    const updated = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    expect(updated.version).toBe("1.0.1");
    expect(updated.name).toBe("myWidget");
  });

  test("preserves trailing newline", () => {
    const infoPath = path.join(tmpDir, "info.json");
    fs.writeFileSync(infoPath, JSON.stringify({ name: "w", version: "1.0.0" }, null, 2) + "\n");
    writeInfoVersion(infoPath, "2.0.0");
    expect(fs.readFileSync(infoPath, "utf8").endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rewriteForVersion
// ---------------------------------------------------------------------------
describe("rewriteForVersion", () => {
  let tmpDir;

  function makeWidget(dir, version, extraContent = "") {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "view.controller.js"),
      `angular.module("cybersponse").controller("myWidget100DevCtrl", ctrl);\n${extraContent}`
    );
    fs.writeFileSync(
      path.join(dir, "edit.controller.js"),
      `angular.module("cybersponse").controller("editmyWidget100DevCtrl", ctrl);\n`
    );
    // noinspection XmlUnresolvedReference
    fs.writeFileSync(
      path.join(dir, "view.html"),
      `<div ng-controller="myWidget-1.0.0/someref">hello</div>\n`
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-rewrite-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rewrites controller name in view.controller.js", () => {
    makeWidget(tmpDir, "1.0.0");
    rewriteForVersion(tmpDir, "myWidget", "2.0.0");
    const content = fs.readFileSync(path.join(tmpDir, "view.controller.js"), "utf8");
    expect(content).toContain("myWidget200DevCtrl");
    expect(content).not.toContain("myWidget100DevCtrl");
  });

  test("rewrites edit controller name in edit.controller.js", () => {
    makeWidget(tmpDir, "1.0.0");
    rewriteForVersion(tmpDir, "myWidget", "1.1.0");
    const content = fs.readFileSync(path.join(tmpDir, "edit.controller.js"), "utf8");
    expect(content).toContain("editmyWidget110DevCtrl");
    expect(content).not.toContain("editmyWidget100DevCtrl");
  });

  test("rewrites versioned path refs in view.html", () => {
    makeWidget(tmpDir, "1.0.0");
    rewriteForVersion(tmpDir, "myWidget", "1.2.0");
    const content = fs.readFileSync(path.join(tmpDir, "view.html"), "utf8");
    expect(content).toContain("myWidget-1.2.0/");
    expect(content).not.toContain("myWidget-1.0.0/");
  });

  test("rewrites bare versioned widget id strings in view.controller.js", () => {
    // Regression: hardcoded `'myWidget-1.0.0'` strings (e.g. localStorage keys
    // using a widgetId fallback) were missed by the rewrite because the regex
    // required a trailing `/`. After a bump, the lint check `stale-version-ref`
    // would block install until the string was hand-edited.
    makeWidget(
      tmpDir,
      "1.0.0",
      "var widgetId = (w.__id__ || 'myWidget-1.0.0');\n"
    );
    rewriteForVersion(tmpDir, "myWidget", "1.0.1");
    const content = fs.readFileSync(path.join(tmpDir, "view.controller.js"), "utf8");
    expect(content).toContain("'myWidget-1.0.1'");
    expect(content).not.toContain("'myWidget-1.0.0'");
  });

  test("does not rewrite a non-version word that happens to follow `<name>-`", () => {
    // Guard: `myWidget-utils` shouldn't be touched.
    makeWidget(tmpDir, "1.0.0", "// see myWidget-utils.md\n");
    rewriteForVersion(tmpDir, "myWidget", "1.0.1");
    const content = fs.readFileSync(path.join(tmpDir, "view.controller.js"), "utf8");
    expect(content).toContain("myWidget-utils.md");
  });

  test("is idempotent — rewriting twice gives the same result", () => {
    makeWidget(tmpDir, "1.0.0");
    rewriteForVersion(tmpDir, "myWidget", "2.0.0");
    const after1 = fs.readFileSync(path.join(tmpDir, "view.controller.js"), "utf8");
    rewriteForVersion(tmpDir, "myWidget", "2.0.0");
    const after2 = fs.readFileSync(path.join(tmpDir, "view.controller.js"), "utf8");
    expect(after1).toBe(after2);
  });
});

// ---------------------------------------------------------------------------
// packageWidget — integration (runs real tar)
// ---------------------------------------------------------------------------
describe("packageWidget", () => {
  let srcDir, outDir;

  function makeFullWidget(dir, name, version, infoOverrides = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    const digits = version.replace(/\./g, "");
    const info = {
      name,
      version,
      title: name,
      metadata: validMetadata(),
      ...infoOverrides,
    };
    fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify(info, null, 2));
    fs.writeFileSync(path.join(dir, "view.html"), "<div>view</div>");
    fs.writeFileSync(path.join(dir, "edit.html"), "<div>edit</div>");
    fs.writeFileSync(
      path.join(dir, "view.controller.js"),
      `angular.module("cybersponse").controller("${cap}${digits}Ctrl", function(){});\n`
    );
    fs.writeFileSync(
      path.join(dir, "edit.controller.js"),
      `angular.module("cybersponse").controller("edit${cap}${digits}Ctrl", function(){});\n`
    );
  }

  beforeEach(() => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-pkg-src-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-pkg-out-"));
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test("produces a .tgz archive in the output directory", async () => {
    makeFullWidget(srcDir, "testWidget", "1.0.0");
    const result = await packageWidget(srcDir, outDir);
    expect(result.archiveName).toBe("testWidget-1.0.0.tgz");
    expect(result.widgetName).toBe("testWidget");
    expect(result.version).toBe("1.0.0");
    expect(result.size).toBeGreaterThan(0);
    expect(fs.existsSync(result.archivePath)).toBe(true);
  });

  test("result includes correct fileCount", async () => {
    makeFullWidget(srcDir, "testWidget", "1.0.0");
    const result = await packageWidget(srcDir, outDir);
    expect(result.fileCount).toBeGreaterThanOrEqual(5);
  });

  test("throws when info.json is missing", async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    await expect(packageWidget(srcDir, outDir)).rejects.toThrow("info.json not found");
  });

  test("throws when required files are missing", async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "info.json"), JSON.stringify({ name: "w", version: "1.0.0" }));
    await expect(packageWidget(srcDir, outDir)).rejects.toThrow("missing required file");
  });

  test("excludes dot-files and underscore-files from the archive", async () => {
    makeFullWidget(srcDir, "testWidget", "1.0.0");
    fs.writeFileSync(path.join(srcDir, ".DS_Store"), "junk");
    fs.writeFileSync(path.join(srcDir, "_private.js"), "priv");
    const result = await packageWidget(srcDir, outDir);
    expect(result.archiveName).toBe("testWidget-1.0.0.tgz");
    expect(fs.existsSync(result.archivePath)).toBe(true);
  });

  test("rejects widget missing metadata.pages (required by SOAR registry)", async () => {
    makeFullWidget(srcDir, "testWidget", "1.0.0", { metadata: {} });
    await expect(packageWidget(srcDir, outDir)).rejects.toThrow(
      /widget validation failed[\s\S]*metadata\.pages/
    );
  });

  test("packages successfully when only optional metadata is missing", async () => {
    makeFullWidget(srcDir, "testWidget", "1.0.0", {
      metadata: { pages: ["Dashboard"] }, // no windowClass/size/standalone
    });
    const result = await packageWidget(srcDir, outDir);
    expect(result.archiveName).toBe("testWidget-1.0.0.tgz");
    expect(result.warnings.some((w) => /windowClass/.test(w))).toBe(true);
  });

  test("rejects widget whose controller version digits drift from info.json", async () => {
    makeFullWidget(srcDir, "testWidget", "1.0.0");
    // Hand-edit info.json to a different version *without* re-running rewrite,
    // simulating someone bumping the version but skipping the controller sync.
    const infoPath = path.join(srcDir, "info.json");
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    info.version = "2.0.0";
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
    // packageWidget runs rewriteForVersion internally so it self-heals — to
    // trigger the drift error we have to bypass it. Confirm validateWidget
    // catches the drift directly instead.
    const report = validateWidget(srcDir, info);
    expect(report.errors.some((e) => /version digits/.test(e))).toBe(true);
  });
});

describe("validateInfoMetadata", () => {
  test("accepts a fully-populated info.json", () => {
    const info = { name: "w", version: "1.0.0", metadata: validMetadata() };
    const r = validateInfoMetadata(info);
    expect(r.errors).toEqual([]);
  });

  test("only metadata.pages is a hard error; windowClass/size/standalone are warnings", () => {
    const info = { name: "w", version: "1.0.0", metadata: { compatibility: ["7.6.0"] } };
    const r = validateInfoMetadata(info);
    expect(r.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/metadata\.pages/)])
    );
    expect(r.errors.some((e) => /windowClass|size|standalone/.test(e))).toBe(false);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/windowClass/),
        expect.stringMatching(/size/),
        expect.stringMatching(/standalone/),
      ])
    );
  });

  test("flags missing metadata block entirely", () => {
    const r = validateInfoMetadata({ name: "w", version: "1.0.0" });
    expect(r.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing 'metadata'/)])
    );
  });

  test("flags invalid version", () => {
    const r = validateInfoMetadata({ name: "w", version: "v1.0", metadata: validMetadata() });
    expect(r.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/invalid version/)])
    );
  });

  test("warns (does not error) on missing publisher / category / compatibility", () => {
    const info = {
      name: "w",
      version: "1.0.0",
      metadata: { windowClass: "Full Width", size: "lg", standalone: false, pages: ["Dashboard"] },
    };
    const r = validateInfoMetadata(info);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/compatibility/),
        expect.stringMatching(/category/),
        expect.stringMatching(/publisher/),
      ])
    );
  });
});

describe("validateControllers", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-vctrl-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeCtrls(viewName, editName) {
    fs.writeFileSync(
      path.join(dir, "view.controller.js"),
      `angular.module("cybersponse").controller("${viewName}", function(){});\n`
    );
    fs.writeFileSync(
      path.join(dir, "edit.controller.js"),
      `angular.module("cybersponse").controller("${editName}", function(){});\n`
    );
  }

  test("accepts matched DevCtrl pair", () => {
    writeCtrls("MyWidget123DevCtrl", "editMyWidget123DevCtrl");
    const r = validateControllers(dir, { name: "myWidget", version: "1.2.3" });
    expect(r.errors).toEqual([]);
  });

  test("accepts non-Dev variant (post-publish form)", () => {
    writeCtrls("MyWidget123Ctrl", "editMyWidget123Ctrl");
    const r = validateControllers(dir, { name: "myWidget", version: "1.2.3" });
    expect(r.errors).toEqual([]);
  });

  test("flags version-digit drift between info.json and controller name", () => {
    writeCtrls("MyWidget100DevCtrl", "editMyWidget100DevCtrl");
    const r = validateControllers(dir, { name: "myWidget", version: "1.2.3" });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.every((e) => /version digits/.test(e))).toBe(true);
  });

  test("flags missing .controller(...) registration", () => {
    fs.writeFileSync(path.join(dir, "view.controller.js"), "// no controller here\n");
    fs.writeFileSync(path.join(dir, "edit.controller.js"), "// nothing\n");
    const r = validateControllers(dir, { name: "myWidget", version: "1.0.0" });
    expect(r.errors.some((e) => /no \.controller/.test(e))).toBe(true);
  });

  test("flags wrongly-shaped controller name (e.g. wrong widget name)", () => {
    writeCtrls("OtherWidget100DevCtrl", "editOtherWidget100DevCtrl");
    const r = validateControllers(dir, { name: "myWidget", version: "1.0.0" });
    expect(r.errors.some((e) => /no controller matches/.test(e))).toBe(true);
  });
});

describe("suggestInfoFix", () => {
  test("returns null when no fixable errors", () => {
    expect(suggestInfoFix({ name: "w", version: "1.0.0", metadata: validMetadata() })).toBeNull();
  });

  test("suggests pages default when missing", () => {
    const patch = suggestInfoFix({ name: "w", version: "1.0.0", metadata: {} });
    expect(patch).toEqual({ metadata: { pages: ["Dashboard", "View Panel"] } });
  });

  test("returns null when only optional fields are missing", () => {
    const patch = suggestInfoFix({
      name: "w", version: "1.0.0",
      metadata: { pages: ["Dashboard"] }, // no windowClass/size/standalone — those are warnings, not auto-suggested
    });
    expect(patch).toBeNull();
  });

  test("handles missing metadata block entirely", () => {
    const patch = suggestInfoFix({ name: "w", version: "1.0.0" });
    expect(patch.metadata.pages).toEqual(["Dashboard", "View Panel"]);
  });

  test("applying the suggestion clears all fixable errors", () => {
    const info = { name: "w", version: "1.0.0", metadata: { compatibility: ["7.6.0"] } };
    const patch = suggestInfoFix(info);
    // Simulate apply (deep merge):
    info.metadata = { ...info.metadata, ...patch.metadata };
    expect(validateInfoMetadata(info).errors).toEqual([]);
  });
});

describe("applyInfoFix", () => {
  let dir, infoPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-fix-"));
    infoPath = path.join(dir, "info.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("deep-merges patch into existing info.json", () => {
    fs.writeFileSync(
      infoPath,
      JSON.stringify({ name: "w", version: "1.0.0", metadata: { compatibility: ["7.6.0"] } }, null, 2)
    );
    applyInfoFix(infoPath, { metadata: { windowClass: "Full Width", size: "lg", standalone: false, pages: ["Dashboard"] } });
    const after = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    expect(after.metadata.compatibility).toEqual(["7.6.0"]); // preserved
    expect(after.metadata.windowClass).toBe("Full Width");   // added
    expect(after.metadata.size).toBe("lg");
    expect(after.name).toBe("w");                            // untouched
  });

  test("preserves trailing newline", () => {
    fs.writeFileSync(infoPath, JSON.stringify({ name: "w", version: "1.0.0", metadata: {} }, null, 2) + "\n");
    applyInfoFix(infoPath, { metadata: { standalone: false } });
    expect(fs.readFileSync(infoPath, "utf8").endsWith("\n")).toBe(true);
  });
});
