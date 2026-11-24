import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_CATALOG } from "./apis.js";

const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

/** The groups NASEBANAL Evolution's beta is behind: outside the compatibility promise until Evolution leaves beta. */
const BETA_GROUPS = ["assurance", "specs"];

describe("beta groups (outside the compatibility promise)", () => {
  it("are marked [beta] in the catalog, and the stable groups are not", () => {
    const marked = API_CATALOG.filter((a) => a.summary.startsWith("[beta] ")).map((a) => a.name);
    expect(marked.sort()).toEqual([...BETA_GROUPS].sort());
    expect(API_CATALOG.map((a) => a.name)).toEqual(expect.arrayContaining(["account", "record", "target", ...BETA_GROUPS]));
  });

  it("are the ones the README's stability section names, so the code and the promise cannot drift", () => {
    const section = readme.slice(readme.indexOf("## Stability and compatibility"), readme.indexOf("## Installation"));
    expect(section).toContain("**[beta]**");
    for (const name of BETA_GROUPS) expect(section, name).toContain(`\`${name}\``);
    for (const name of ["account", "record", "target"]) expect(section, name).not.toContain(`\`${name}\` and`);
  });
});
