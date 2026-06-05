"use strict";
// soarEnv credential resolution. The OS keychain dep (@napi-rs/keyring) is not
// installed in CI, so we mock it as a VIRTUAL module. resolveSoarEnv is called
// with an explicit env object throughout, which keeps it hermetic (the .env
// file tier is only read on the default-process.env path, never in tests).

const KEYCHAIN = {}; // account -> stored secret
jest.mock(
  "@napi-rs/keyring",
  () => ({
    Entry: class {
      constructor(_service, account) { this.account = account; }
      getPassword() { return KEYCHAIN[this.account] || null; }
      setPassword(v) { KEYCHAIN[this.account] = v; }
      deletePassword() { const had = this.account in KEYCHAIN; delete KEYCHAIN[this.account]; return had; }
    },
  }),
  { virtual: true }
);

const { resolveSoarEnv } = require("../lib/soarEnv");

beforeEach(() => { for (const k of Object.keys(KEYCHAIN)) delete KEYCHAIN[k]; });

describe("host / port parsing (unchanged behavior)", () => {
  test("adds https scheme and strips trailing slash", () => {
    const { host } = resolveSoarEnv({ FSR_BASE_URL: "soar.example.com/" });
    expect(host).toBe("https://soar.example.com");
  });
  test("FSR_PORT overrides the URL port", () => {
    const { host } = resolveSoarEnv({ FSR_BASE_URL: "https://soar.example.com:443", FSR_PORT: "8443" });
    expect(host).toBe("https://soar.example.com:8443");
  });
});

describe("password precedence: env var > keychain > .env", () => {
  test("explicit env var wins even if a keychain entry exists", () => {
    KEYCHAIN["admin"] = "from-keychain";
    const { pass } = resolveSoarEnv({ FSR_USERNAME: "admin", FSR_PASSWORD: "from-env" });
    expect(pass).toBe("from-env");
  });

  test("keychain is used when no env password is set", () => {
    KEYCHAIN["admin"] = "from-keychain";
    const { pass } = resolveSoarEnv({ FSR_USERNAME: "admin" });
    expect(pass).toBe("from-keychain");
  });

  test("empty when neither env nor keychain has a secret", () => {
    const { pass } = resolveSoarEnv({ FSR_USERNAME: "nobody" });
    expect(pass).toBe("");
  });

  test("legacy FORTISOAR_PASSWORD still works", () => {
    const { pass } = resolveSoarEnv({ FSR_USERNAME: "admin", FORTISOAR_PASSWORD: "legacy" });
    expect(pass).toBe("legacy");
  });
});

describe("api key precedence (separate keychain account)", () => {
  test("env api key wins", () => {
    KEYCHAIN["admin:apikey"] = "kc-key";
    const { apiKey } = resolveSoarEnv({ FSR_USERNAME: "admin", FSR_API_KEY: "env-key" });
    expect(apiKey).toBe("env-key");
  });
  test("keychain api key used when env unset", () => {
    KEYCHAIN["admin:apikey"] = "kc-key";
    const { apiKey } = resolveSoarEnv({ FSR_USERNAME: "admin" });
    expect(apiKey).toBe("kc-key");
  });
});

describe("service name", () => {
  test("defaults to fsr-widget-harness", () => {
    expect(resolveSoarEnv({}).service).toBe("fsr-widget-harness");
  });
});
