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
  test("dashboard yields main.dashboard with empty params", () => {
    expect(stateForContext("dashboard")).toEqual({
      current: { name: "main.dashboard" },
      params: {},
    });
  });

  test("viewpanel passes params through", () => {
    expect(stateForContext("viewpanel", { module: "alerts", id: "x" })).toEqual({
      current: { name: "viewPanel.modulesDetail" },
      params: { module: "alerts", id: "x" },
    });
  });

  test("drawer adds drawer flag to params", () => {
    expect(stateForContext("drawer", { id: "x" })).toEqual({
      current: { name: "viewPanel.modulesDetail" },
      params: { drawer: true, id: "x" },
    });
  });

  test("unknown context falls back to dashboard", () => {
    expect(stateForContext("garbage")).toEqual({
      current: { name: "main.dashboard" },
      params: {},
    });
  });
});
