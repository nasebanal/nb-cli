import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseUrlOverride, resetBaseUrlWarning } from "./config.js";

let stderr: string[];
beforeEach(() => {
  stderr = [];
  resetBaseUrlWarning();
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
  for (const k of ["NB_BASE_URL", "NB_ASSURANCE_BASE_URL", "NB_RECORD_BASE_URL", "NB_SPECS_BASE_URL"]) vi.stubEnv(k, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("baseUrlOverride", () => {
  it("is undefined when nothing is set (the spec's own servers entry then decides), and says nothing", () => {
    expect(baseUrlOverride("assurance")).toBeUndefined();
    expect(stderr).toEqual([]);
  });

  it("reads the API's own variable, without a trailing slash, and says nothing", () => {
    vi.stubEnv("NB_ASSURANCE_BASE_URL", "http://localhost:8791/");
    expect(baseUrlOverride("assurance")).toBe("http://localhost:8791");
    expect(stderr).toEqual([]);
  });

  it("keeps each API's variable to that API: another API's host is not used", () => {
    vi.stubEnv("NB_ASSURANCE_BASE_URL", "http://localhost:8791");
    expect(baseUrlOverride("record")).toBeUndefined();
    vi.stubEnv("NB_RECORD_BASE_URL", "http://localhost:8787");
    expect(baseUrlOverride("record")).toBe("http://localhost:8787");
    expect(baseUrlOverride("assurance")).toBe("http://localhost:8791");
  });

  it("still honours the shared NB_BASE_URL, and says once that it is deprecated and which variable replaces it", () => {
    vi.stubEnv("NB_BASE_URL", "http://stub.test");
    expect(baseUrlOverride("assurance")).toBe("http://stub.test");
    expect(baseUrlOverride("record")).toBe("http://stub.test");
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("deprecated");
    expect(stderr[0]).toContain("NB_ASSURANCE_BASE_URL");
  });

  it("prefers the API's own variable over the shared one, and then does not warn", () => {
    vi.stubEnv("NB_BASE_URL", "http://stub.test");
    vi.stubEnv("NB_ASSURANCE_BASE_URL", "http://localhost:8791");
    expect(baseUrlOverride("assurance")).toBe("http://localhost:8791");
    expect(stderr).toEqual([]);
  });

  it("treats an empty value as unset", () => {
    vi.stubEnv("NB_BASE_URL", "  ");
    vi.stubEnv("NB_ASSURANCE_BASE_URL", "");
    expect(baseUrlOverride("assurance")).toBeUndefined();
  });
});
