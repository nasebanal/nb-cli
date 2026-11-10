import { describe, expect, it } from "vitest";
import { apiVersionFromInfoVersion, apiVersionOf, checkApiVersion, sameApiVersion } from "./apiVersion.js";

describe("apiVersionFromInfoVersion: the major of info.version, as nb-specs-api derives it", () => {
  it("gives v<major> for a semver-like version, leading zeros dropped", () => {
    for (const [info, want] of [["1.8.0", "v1"], ["v2.0", "v2"], ["V3", "v3"], ["1.0.0-rc.1", "v1"], ["2.1.0+build.5", "v2"], ["007.1", "v7"], [" 4.2 ", "v4"], ["12", "v12"], ["999.9.9", "v999"]] as const) {
      expect(apiVersionFromInfoVersion(info), info).toBe(want);
    }
  });

  it("gives none when there is no leading numeric major (the version must then be named with --api-version)", () => {
    for (const info of ["2023-01", "2023.1", "latest", "1.x", "", "abc", "1.2.3.4", "v", "-1", "1_0"]) {
      expect(apiVersionFromInfoVersion(info), info).toBeNull();
    }
  });
});

describe("apiVersionOf: a document's API version", () => {
  it("reads info.version from YAML and JSON", () => {
    expect(apiVersionOf("openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.8.0\npaths: {}\n")).toBe("v1");
    expect(apiVersionOf('{"openapi":"3.0.3","info":{"title":"T","version":"2.0.0"},"paths":{}}')).toBe("v2");
  });

  it("reads a version YAML turned into a number as the text the author wrote", () => {
    expect(apiVersionOf("openapi: 3.0.3\ninfo:\n  title: T\n  version: 2\n")).toBe("v2");
    expect(apiVersionOf("openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0\n")).toBe("v1");
  });

  it("gives none for a missing or unreadable one", () => {
    expect(apiVersionOf("openapi: 3.0.3\ninfo:\n  title: T\n")).toBeNull();
    expect(apiVersionOf("openapi: 3.0.3\ninfo:\n  title: T\n  version: 2023-01\n")).toBeNull();
    expect(apiVersionOf("{ not: [valid")).toBeNull();
    expect(apiVersionOf("nonsense")).toBeNull();
  });
});

describe("checkApiVersion / sameApiVersion", () => {
  it("takes the catalog's label rule, trimmed", () => {
    expect(checkApiVersion(" v1 ")).toBe("v1");
    expect(checkApiVersion("2026-10")).toBe("2026-10");
    for (const bad of ["", "v 1", "x".repeat(33), "v/1"]) expect(() => checkApiVersion(bad), bad).toThrow(/must be a version label/);
  });

  it("compares ignoring case, and an absent one is v1 only through the caller", () => {
    expect(sameApiVersion("V1", "v1")).toBe(true);
    expect(sameApiVersion("v1", "v2")).toBe(false);
  });
});
