"use strict";

const {
  resolvePath,
  deriveControllerName,
  deriveEditControllerName,
  mergeConfig,
  configStorageKey,
  recordFetchPath,
  resolveMapping,
  stateForContext,
  extractInjectedDependencies,
  parseRegisteredServices,
  rootNgControllerError,
  lintWidget,
} = require("../lib/harnessUtils");

describe("resolvePath", () => {
  const rec = {
    name: "alert-1",
    source: { host: "10.0.0.1", ports: [22, 80] },
    nested: { a: { b: { c: "deep" } } },
  };

  test("walks dotted paths", () => {
    expect(resolvePath(rec, "name")).toBe("alert-1");
    expect(resolvePath(rec, "source.host")).toBe("10.0.0.1");
    expect(resolvePath(rec, "nested.a.b.c")).toBe("deep");
  });

  test("returns undefined for missing segments", () => {
    expect(resolvePath(rec, "source.missing")).toBeUndefined();
    expect(resolvePath(rec, "missing.deep.path")).toBeUndefined();
  });

  test("handles array index segments", () => {
    expect(resolvePath(rec, "source.ports.0")).toBe(22);
    expect(resolvePath(rec, "source.ports.1")).toBe(80);
  });

  test("guards null / empty inputs", () => {
    expect(resolvePath(null, "x")).toBeUndefined();
    expect(resolvePath(rec, "")).toBeUndefined();
    expect(resolvePath(rec, undefined)).toBeUndefined();
  });
});

describe("deriveControllerName", () => {
  test("strips dots from version and appends DevCtrl", () => {
    expect(deriveControllerName("jinjaEditorWidget", "1.1.2")).toBe("jinjaEditorWidget112DevCtrl");
    expect(deriveControllerName("foo", "10.0.0")).toBe("foo1000DevCtrl");
  });

  test("missing version yields no digits", () => {
    expect(deriveControllerName("foo", "")).toBe("fooDevCtrl");
    expect(deriveControllerName("foo")).toBe("fooDevCtrl");
  });

  test("missing name throws", () => {
    expect(() => deriveControllerName("")).toThrow(/missing name/);
    expect(() => deriveControllerName(null, "1.0.0")).toThrow(/missing name/);
  });
});

describe("deriveEditControllerName", () => {
  test("capitalizes the widget name and prefixes with 'edit'", () => {
    expect(deriveEditControllerName("jinjaEditorWidget", "1.1.3")).toBe("editJinjaEditorWidget113DevCtrl");
    expect(deriveEditControllerName("foo", "2.0")).toBe("editFoo20DevCtrl");
  });

  test("missing name throws", () => {
    expect(() => deriveEditControllerName("", "1.0.0")).toThrow(/missing name/);
  });
});

describe("mergeConfig", () => {
  test("saved values override defaults", () => {
    const out = mergeConfig({ a: 1, b: 2 }, { b: 99, c: 3 });
    expect(out).toEqual({ a: 1, b: 99, c: 3 });
  });

  test("either side may be null/undefined", () => {
    expect(mergeConfig(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeConfig({ a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeConfig(null, null)).toEqual({});
  });

  test("returns a fresh object (no aliasing)", () => {
    const defaults = { a: 1 };
    const out = mergeConfig(defaults, { b: 2 });
    out.a = 99;
    expect(defaults.a).toBe(1);
  });
});

describe("configStorageKey", () => {
  test("namespaced and stable per widget id", () => {
    expect(configStorageKey("jinjaEditorWidget-1.1.2")).toBe("harness:config:jinjaEditorWidget-1.1.2");
  });
});

describe("recordFetchPath", () => {
  test("builds module/id path with relationships", () => {
    expect(recordFetchPath("alerts", "abc-123", true)).toBe("/api/3/alerts/abc-123?$relationships=true");
  });

  test("omits query when relationships are false", () => {
    expect(recordFetchPath("alerts", "abc", false)).toBe("/api/3/alerts/abc");
  });

  test("encodes ids that contain special characters", () => {
    expect(recordFetchPath("alerts", "a/b", false)).toBe("/api/3/alerts/a%2Fb");
  });

  test("throws when module or id missing", () => {
    expect(() => recordFetchPath("", "x")).toThrow();
    expect(() => recordFetchPath("alerts", "")).toThrow();
  });
});

describe("resolveMapping", () => {
  const record = { name: "alert", source: { host: "h1" } };

  test("walks string values as paths", () => {
    expect(resolveMapping({ title: "name", host: "source.host" }, record)).toEqual({
      title: "alert",
      host: "h1",
    });
  });

  test("strips leading 'record.' to match SOAR mapping syntax", () => {
    expect(resolveMapping({ host: "record.source.host" }, record)).toEqual({ host: "h1" });
  });

  test("non-string values pass through unchanged", () => {
    expect(resolveMapping({ enabled: true, n: 5, fallback: null }, record)).toEqual({
      enabled: true,
      n: 5,
      fallback: null,
    });
  });

  test("missing paths produce undefined", () => {
    expect(resolveMapping({ x: "missing.thing" }, record)).toEqual({ x: undefined });
  });

  test("non-object mapping returns empty object", () => {
    expect(resolveMapping(null, record)).toEqual({});
    expect(resolveMapping("oops", record)).toEqual({});
  });
});

describe("stateForContext", () => {
  // Implementation always seeds `params.page` with the context name so
  // widgets that read `$state.params.page` (the `page === 'dashboard'`
  // branches in c3charts and elsewhere) work uniformly across contexts.
  test("dashboard yields main.dashboard with page=dashboard", () => {
    expect(stateForContext("dashboard")).toEqual({
      current: { name: "main.dashboard" },
      params: { page: "dashboard" },
    });
  });

  test("viewpanel passes params through with page=viewPanel", () => {
    expect(stateForContext("viewpanel", { module: "alerts", id: "x" })).toEqual({
      current: { name: "viewPanel.modulesDetail" },
      params: { page: "viewPanel", module: "alerts", id: "x" },
    });
  });

  test("drawer adds drawer flag to params with page=viewPanel", () => {
    expect(stateForContext("drawer", { id: "x" })).toEqual({
      current: { name: "viewPanel.modulesDetail" },
      params: { page: "viewPanel", drawer: true, id: "x" },
    });
  });

  test("unknown context falls back to dashboard", () => {
    expect(stateForContext("garbage")).toEqual({
      current: { name: "main.dashboard" },
      params: { page: "dashboard" },
    });
  });
});

describe("extractInjectedDependencies", () => {
  test("picks up the $inject array form", () => {
    const src = `
      function Ctrl(){}
      Ctrl.$inject = ["$scope", "Modules", "toaster"];
      angular.module("x").controller("Ctrl", Ctrl);
    `;
    expect(extractInjectedDependencies(src).sort()).toEqual(["$scope", "Modules", "toaster"].sort());
  });

  test("picks up the inline-array .controller form", () => {
    const src = `angular.module("x").controller("C", ["$scope", "Foo", function ($scope, Foo) {}]);`;
    expect(extractInjectedDependencies(src).sort()).toEqual(["$scope", "Foo"].sort());
  });

  test("picks up the implicit function-arg form", () => {
    const src = `
      function MyCtrl($scope, Bar, $http) {}
      angular.module("x").controller("MyCtrl", MyCtrl);
    `;
    expect(extractInjectedDependencies(src).sort()).toEqual(["$scope", "Bar", "$http"].sort());
  });

  test("returns [] for empty / non-string input", () => {
    expect(extractInjectedDependencies("")).toEqual([]);
    expect(extractInjectedDependencies(null)).toEqual([]);
  });
});

describe("parseRegisteredServices", () => {
  test("collects factory/value/directive registrations", () => {
    const src = `
      angular.module("cybersponse", [])
        .factory("Foo", function () {})
        .value("config", {})
        .directive("csSpinner", function () {});
    `;
    expect(parseRegisteredServices(src).sort()).toEqual(["Foo", "config", "csSpinner"].sort());
  });
});

describe("rootNgControllerError", () => {
  test("flags ng-controller on root", () => {
    expect(rootNgControllerError(`<div ng-controller="X">x</div>`)).toMatch(/collides/);
    expect(rootNgControllerError(`<div data-ng-controller="X">x</div>`)).toMatch(/collides/);
  });
  test("clean root returns null", () => {
    expect(rootNgControllerError(`<div class="x">y</div>`)).toBeNull();
  });
  test("ignores leading comment", () => {
    expect(rootNgControllerError(`<!-- top --><div class="x"></div>`)).toBeNull();
  });
});

describe("lintWidget", () => {
  const baseFiles = {
    "view.controller.js": `function foo112DevCtrl($scope){} foo112DevCtrl.$inject=["$scope"]; angular.module("x").controller("foo112DevCtrl", foo112DevCtrl);`,
    "edit.controller.js": `function editFoo112DevCtrl($scope){} editFoo112DevCtrl.$inject=["$scope"]; angular.module("x").controller("editFoo112DevCtrl", editFoo112DevCtrl);`,
    "view.html": `<div><span>{{x}}</span></div>`,
    "edit.html": `<div></div>`,
  };
  const baseInfo = { name: "foo", version: "1.1.2", title: "Foo" };

  test("clean widget yields no errors", () => {
    const r = lintWidget({
      info: baseInfo,
      files: baseFiles,
      registeredServices: [],
      viewControllers: ["foo112DevCtrl"],
      editControllers: ["editFoo112DevCtrl"],
    });
    expect(r.errors).toEqual([]);
  });

  test("missing required file is an error", () => {
    const files = Object.assign({}, baseFiles); delete files["edit.html"];
    const r = lintWidget({ info: baseInfo, files });
    expect(r.errors.some((e) => e.code === "file-missing" && e.file === "edit.html")).toBe(true);
  });

  test("controller mismatch is fixable", () => {
    const r = lintWidget({
      info: baseInfo,
      files: baseFiles,
      viewControllers: ["foo111DevCtrl"],
    });
    const e = r.errors.find((x) => x.code === "controller-mismatch");
    expect(e).toBeTruthy();
    expect(e.fixable).toBe(true);
  });

  test("unknown injected service is reported", () => {
    const files = Object.assign({}, baseFiles, {
      "view.controller.js": `function f(){} f.$inject=["$scope","NotRegistered"]; angular.module("x").controller("foo112DevCtrl", f);`,
    });
    const r = lintWidget({
      info: baseInfo,
      files,
      registeredServices: ["Modules"],
      viewControllers: ["foo112DevCtrl"],
    });
    const e = r.errors.find((x) => x.code === "unknown-dependency");
    expect(e).toBeTruthy();
    expect(e.unknown).toContain("NotRegistered");
  });

  test("ng-controller on root is an error", () => {
    const files = Object.assign({}, baseFiles, { "view.html": `<div ng-controller="x">y</div>` });
    const r = lintWidget({ info: baseInfo, files });
    expect(r.errors.some((e) => e.code === "root-ng-controller")).toBe(true);
  });

  test("missing info.json yields a single error", () => {
    const r = lintWidget({ info: null, files: {} });
    expect(r.errors[0].code).toBe("info-missing");
  });
});
