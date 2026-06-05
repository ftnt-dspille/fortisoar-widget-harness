"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  isValidWidgetName,
  widgetNameFromTitle,
  nameVariationPairs,
  rewriteNameInDir,
  renameWidget,
} = require("../packager");

// Build a throwaway widgets-src tree containing one widget whose source mirrors
// the real fsrPlaybookBuilder shapes: versioned DevCtrl names, the capitalized
// `edit<Name>` controller, an ng-controller ref, a versioned asset path, and an
// internal `fsrPb*` abbreviation that must survive the rename untouched.
function makeWidget(srcRoot, name) {
  const dir = path.join(srcRoot, name, "widget");
  fs.mkdirSync(path.join(dir, "widgetAssets", "js"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify({ name, title: "FSR Playbook Builder", version: "1.2.0" }, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, "view.controller.js"),
    `angular.module('x').controller('${name}120DevCtrl', ${name}120DevCtrl)\n` +
      `  .directive('fsrPbAutosize', function () {});\n` +
      `${name}120DevCtrl.$inject = ['$scope', 'fsrPbAgentService'];\n` +
      `function ${name}120DevCtrl($scope, fsrPbAgentService) {}\n`
  );
  fs.writeFileSync(
    path.join(dir, "edit.controller.js"),
    `angular.module('x').controller('edit${name[0].toUpperCase() + name.slice(1)}120DevCtrl', edit${name[0].toUpperCase() + name.slice(1)}120DevCtrl);\n`
  );
  fs.writeFileSync(
    path.join(dir, "view.html"),
    `<div data-ng-controller="${name}120DevCtrl" aria-label="FSR Playbook Builder">` +
      `<script src="${name}-1.2.0/widgetAssets/js/fsrPbRender.js"></script></div>\n`
  );
  fs.writeFileSync(path.join(dir, "edit.html"), `<div>edit</div>\n`);
  fs.writeFileSync(
    path.join(dir, "widgetAssets", "js", "fsrPbMockConnector.service.js"),
    `var KEY = '${name}-1.0.0';\nangular.module('x').service('fsrPbAgentService', function(){});\n`
  );
  return dir;
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rename-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isValidWidgetName", () => {
  test.each([
    ["fsrPlaybookComposer", true],
    ["Widget123", true],
    ["fsr-playbook", false],
    ["fsr playbook", false],
    ["1widget", false],
    ["fsrPlaybookBuilder-1.2.0", false],
    ["", false],
  ])("%s -> %s", (name, ok) => {
    expect(isValidWidgetName(name)).toBe(ok);
  });
});

describe("widgetNameFromTitle", () => {
  test.each([
    ["FSR Playbook Composer", "fsrPlaybookComposer"],
    ["C2 Hunter", "c2Hunter"],
    ["  Threat   Intel  Board ", "threatIntelBoard"],
    ["FortiSOAR Widget!", "fortisoarWidget"],
    ["already", "already"],
  ])("%j -> %s", (title, name) => {
    expect(widgetNameFromTitle(title)).toBe(name);
  });

  test.each(["", "   ", "!!!", "123 board"])("rejects %j", (title) => {
    expect(() => widgetNameFromTitle(title)).toThrow(/cannot derive/);
  });
});

describe("nameVariationPairs", () => {
  test("yields bare + capitalized forms, deduped", () => {
    const pairs = nameVariationPairs("fsrPlaybookBuilder", "fsrPlaybookComposer");
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["fsrPlaybookBuilder", "fsrPlaybookComposer"],
        ["FsrPlaybookBuilder", "FsrPlaybookComposer"],
      ])
    );
    // bare form is its own decapitalized form -> only two rules, not three.
    expect(pairs).toHaveLength(2);
  });
});

describe("renameWidget", () => {
  test("rewrites identity everywhere and moves the folder", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    const report = renameWidget(tmp, "fsrPlaybookBuilder", "fsrPlaybookComposer");

    expect(fs.existsSync(path.join(tmp, "fsrPlaybookBuilder"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "fsrPlaybookComposer", "widget", "info.json"))).toBe(true);
    expect(report.changedFiles.length).toBeGreaterThanOrEqual(4);

    const w = path.join(tmp, "fsrPlaybookComposer", "widget");
    const info = JSON.parse(fs.readFileSync(path.join(w, "info.json"), "utf8"));
    expect(info.name).toBe("fsrPlaybookComposer");
    // title is NOT derived from name -> unchanged.
    expect(info.title).toBe("FSR Playbook Builder");

    const view = fs.readFileSync(path.join(w, "view.controller.js"), "utf8");
    expect(view).toContain("fsrPlaybookComposer120DevCtrl");
    expect(view).not.toContain("fsrPlaybookBuilder");
    // internal abbreviation prefix survives untouched.
    expect(view).toContain("fsrPbAgentService");
    expect(view).toContain("fsrPbAutosize");

    const edit = fs.readFileSync(path.join(w, "edit.controller.js"), "utf8");
    expect(edit).toContain("editFsrPlaybookComposer120DevCtrl");
    expect(edit).not.toContain("Builder");

    const html = fs.readFileSync(path.join(w, "view.html"), "utf8");
    expect(html).toContain('data-ng-controller="fsrPlaybookComposer120DevCtrl"');
    expect(html).toContain("fsrPlaybookComposer-1.2.0/widgetAssets");

    const mock = fs.readFileSync(path.join(w, "widgetAssets", "js", "fsrPbMockConnector.service.js"), "utf8");
    expect(mock).toContain("fsrPlaybookComposer-1.0.0");
    expect(mock).toContain("fsrPbAgentService");
  });

  test("updates title when provided, and swaps the title string in templates", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    renameWidget(tmp, "fsrPlaybookBuilder", "fsrPlaybookComposer", { title: "FSR Playbook Composer" });
    const w = path.join(tmp, "fsrPlaybookComposer", "widget");
    const info = JSON.parse(fs.readFileSync(path.join(w, "info.json"), "utf8"));
    expect(info.title).toBe("FSR Playbook Composer");
    // The human title string (aria-label) is swapped even though it isn't the
    // camelCase machine name.
    const html = fs.readFileSync(path.join(w, "view.html"), "utf8");
    expect(html).toContain('aria-label="FSR Playbook Composer"');
    expect(html).not.toContain("FSR Playbook Builder");
  });

  test("applies subtitle, description, and releaseNotes when provided", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    renameWidget(tmp, "fsrPlaybookBuilder", "fsrSocAssistant", {
      title: "FSR SOC Assistant",
      subtitle: "Agentic triage & response",
      description: "Conversational SOC copilot.",
      releaseNotes: "Rebranded; scope broadened.",
    });
    const info = JSON.parse(
      fs.readFileSync(path.join(tmp, "fsrSocAssistant", "widget", "info.json"), "utf8")
    );
    expect(info.subTitle).toBe("Agentic triage & response");
    expect(info.metadata.description).toBe("Conversational SOC copilot.");
    expect(info.releaseNotes).toBe("Rebranded; scope broadened.");
  });

  test("leaves display fields untouched when not provided", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    // Seed a subTitle so we can assert it survives a name-only rename.
    const seed = path.join(tmp, "fsrPlaybookBuilder", "widget", "info.json");
    const info0 = JSON.parse(fs.readFileSync(seed, "utf8"));
    info0.subTitle = "original sub";
    fs.writeFileSync(seed, JSON.stringify(info0, null, 2) + "\n");
    renameWidget(tmp, "fsrPlaybookBuilder", "fsrPlaybookComposer");
    const info = JSON.parse(
      fs.readFileSync(path.join(tmp, "fsrPlaybookComposer", "widget", "info.json"), "utf8")
    );
    expect(info.subTitle).toBe("original sub");
  });

  test("changedFiles paths point at the moved folder", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    const report = renameWidget(tmp, "fsrPlaybookBuilder", "fsrPlaybookComposer", { title: "FSR Playbook Composer" });
    for (const f of report.changedFiles) {
      expect(fs.existsSync(f)).toBe(true);
      expect(f).toContain(path.join("fsrPlaybookComposer", "widget"));
    }
  });

  test("refuses invalid names without moving anything", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    expect(() => renameWidget(tmp, "fsrPlaybookBuilder", "bad name")).toThrow(/invalid widget name/);
    expect(fs.existsSync(path.join(tmp, "fsrPlaybookBuilder", "widget", "info.json"))).toBe(true);
  });

  test("refuses when target folder already exists", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    makeWidget(tmp, "fsrPlaybookComposer");
    expect(() => renameWidget(tmp, "fsrPlaybookBuilder", "fsrPlaybookComposer")).toThrow(/already exists/);
  });

  test("refuses identical name", () => {
    makeWidget(tmp, "fsrPlaybookBuilder");
    expect(() => renameWidget(tmp, "fsrPlaybookBuilder", "fsrPlaybookBuilder")).toThrow(/identical/);
  });
});

describe("rewriteNameInDir", () => {
  test("returns the files it changed and skips unrelated files", () => {
    const dir = makeWidget(tmp, "fsrPlaybookBuilder");
    fs.writeFileSync(path.join(dir, "unrelated.json"), JSON.stringify({ k: "v" }) + "\n");
    const changed = rewriteNameInDir(dir, "fsrPlaybookBuilder", "fsrPlaybookComposer");
    expect(changed.some((f) => f.endsWith("unrelated.json"))).toBe(false);
    expect(changed.some((f) => f.endsWith("view.controller.js"))).toBe(true);
  });
});
