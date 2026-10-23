import { describe, expect, it } from "vitest";
import { compareVersions } from "./update.js";

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.4.0", "0.5.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
  it("ignores pre-release suffixes", () => {
    expect(compareVersions("0.5.0-next.1", "0.5.0")).toBe(0);
  });
});
