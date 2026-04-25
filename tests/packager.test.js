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
} = require("../packager");

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

  function makeFullWidget(dir, name, version) {
    fs.mkdirSync(dir, { recursive: true });
    const info = { name, version, title: name };
    fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify(info, null, 2));
    fs.writeFileSync(path.join(dir, "view.html"), "<div>view</div>");
    fs.writeFileSync(path.join(dir, "edit.html"), "<div>edit</div>");
    fs.writeFileSync(
      path.join(dir, "view.controller.js"),
      `angular.module("cybersponse").controller("${name}100Ctrl", function(){});\n`
    );
    fs.writeFileSync(
      path.join(dir, "edit.controller.js"),
      `angular.module("cybersponse").controller("edit${name}100Ctrl", function(){});\n`
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
});
