import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { complete, completionScript, supportsComplete } from "./completion.js";
import type { Plugin } from "./plugins.js";

function tree(): Command {
  const p = new Command().name("nb").option("--env <env>").option("--token <t>");
  p.command("auth").command("login");
  const assurance = p.command("assurance");
  assurance.command("monitor").option("--spec <s>");
  assurance.command("report");
  p.command("account");
  return p;
}
const plugins: Plugin[] = [
  { name: "quickstarts", file: "/x/nb-quickstarts", description: "" },
  { name: "secrets", file: "/x/nb-secrets", description: "" },
];
const none = async () => [];

describe("complete: first word", () => {
  it("completes built-in commands and tools by prefix", async () => {
    expect(await complete(tree(), plugins, ["assu"], none)).toEqual(["assurance"]);
    expect(await complete(tree(), plugins, ["quick"], none)).toEqual(["quickstarts"]);
    expect(await complete(tree(), plugins, ["a"], none)).toEqual(["account", "assurance", "auth"]);
  });
  it("lists everything for an empty word, and global options after a dash", async () => {
    expect(await complete(tree(), plugins, [""], none)).toEqual(["account", "assurance", "auth", "quickstarts", "secrets"]);
    expect(await complete(tree(), plugins, ["--e"], none)).toEqual(["--env"]);
  });
  it("skips global options before the command", async () => {
    expect(await complete(tree(), plugins, ["--env", "local", "assu"], none)).toEqual(["assurance"]);
  });
});

describe("complete: below a built-in command", () => {
  it("completes sub-commands and options", async () => {
    expect(await complete(tree(), plugins, ["assurance", ""], none)).toEqual(["monitor", "report"]);
    expect(await complete(tree(), plugins, ["assurance", "mon"], none)).toEqual(["monitor"]);
    expect(await complete(tree(), plugins, ["assurance", "monitor", "--s"], none)).toEqual(["--spec"]);
  });
  it("gives nothing for an unknown path", async () => {
    expect(await complete(tree(), plugins, ["nope", ""], none)).toEqual([]);
    expect(await complete(tree(), plugins, ["assurance", "nope", ""], none)).toEqual([]);
  });
});

describe("complete: below a tool", () => {
  it("asks a tool that says it answers --complete, with the words after its name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-compl-"));
    const file = join(dir, "nb-quickstarts");
    writeFileSync(file, "#!/bin/sh\n# nb-quickstarts - x\n# --complete <words...>\n");
    chmodSync(file, 0o755);
    const asked: string[][] = [];
    const ask = async (_p: Plugin, w: readonly string[]) => (asked.push([...w]), ["kong", "kafka"]);
    const out = await complete(tree(), [{ name: "quickstarts", file, description: "" }], ["quickstarts", "k"], ask);
    expect(out).toEqual(["kong", "kafka"]);
    expect(asked).toEqual([["k"]]);
  });
  it("does not ask a tool that never mentions --complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-compl-"));
    const file = join(dir, "nb-secrets");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o755);
    expect(supportsComplete(file)).toBe(false);
    const ask = async () => ["never"];
    expect(await complete(tree(), [{ name: "secrets", file, description: "" }], ["secrets", ""], ask)).toEqual([]);
  });
});

describe("completionScript", () => {
  it("calls nb __complete in both shells", () => {
    expect(completionScript("zsh")).toContain("compdef _nb nb");
    expect(completionScript("zsh")).toContain("nb __complete");
    expect(completionScript("bash")).toContain("complete -F _nb_complete nb");
    expect(completionScript("bash")).toContain("nb __complete");
  });
});
