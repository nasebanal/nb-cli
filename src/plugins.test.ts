import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describePlugin, findPlugins, isPluginName, missingMessage, pluginCall, pluginHelp, runPlugin } from "./plugins.js";

const RESERVED: ReadonlySet<string> = new Set(["help", "auth", "specs", "assurance"]);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nb-plugins-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Put an executable (or not) file into a directory under the temp root; returns the directory. */
function tool(dir: string, file: string, body: string, mode = 0o755): string {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), body, { mode });
  chmodSync(join(d, file), mode);
  return d;
}
const script = (name: string, desc: string, extra = "") => `#!/usr/bin/env bash\n# nb-${name} - ${desc}\n#\n# Usage:\n#   nb-${name} ...\n${extra}`;

describe("isPluginName", () => {
  it("accepts a plain lowercase name and nothing that could leave the directory", () => {
    for (const ok of ["secrets", "quickstarts", "a", "my-tool", "tool2"]) expect(isPluginName(ok), ok).toBe(true);
    for (const bad of ["", "../x", "a/b", "Secrets", "-x", "2tool", "a b", ".hidden", "a".repeat(40)]) expect(isPluginName(bad), bad).toBe(false);
  });
});

describe("describePlugin", () => {
  it("reads the description from the first comment line after the shebang, without running anything", () => {
    const d = tool("bin", "nb-secrets", script("secrets", "keep secrets in passphrase-encrypted files (age)", "touch RAN\n"));
    expect(describePlugin(join(d, "nb-secrets"), "secrets")).toBe("keep secrets in passphrase-encrypted files (age)");
  });

  it("is empty when the first comment line is not `nb-<name> - ...`, when it names another tool, or when the file is not a script", () => {
    expect(describePlugin(join(tool("a", "nb-x", "#!/bin/sh\n# does things\n"), "nb-x"), "x")).toBe("");
    expect(describePlugin(join(tool("b", "nb-y", script("other", "not mine")), "nb-y"), "y")).toBe("");
    expect(describePlugin(join(tool("c", "nb-z", "\x7fELF binary-ish \0\0"), "nb-z"), "z")).toBe("");
    expect(describePlugin(join(root, "missing"), "m")).toBe("");
  });

  it("does not dig past the first comment line for a description, and cuts a long one", () => {
    expect(describePlugin(join(tool("d", "nb-w", "#!/bin/sh\n#\n# usage\n# nb-w - too late\n"), "nb-w"), "w")).toBe("");
    const long = "x".repeat(300);
    expect(describePlugin(join(tool("e", "nb-v", script("v", long)), "nb-v"), "v")).toHaveLength(100);
  });
});

describe("findPlugins", () => {
  it("lists the executable nb-<name> programs on PATH, sorted, each with its description", () => {
    const a = tool("a", "nb-secrets", script("secrets", "keeps secrets"));
    const b = tool("b", "nb-quickstarts", script("quickstarts", "runs the quickstarts"));
    const found = findPlugins([a, b].join(delimiter), RESERVED);
    expect(found.map((p) => [p.name, p.description])).toEqual([
      ["quickstarts", "runs the quickstarts"],
      ["secrets", "keeps secrets"],
    ]);
  });

  it("follows a symlink (how --install puts a tool on PATH)", () => {
    const real = tool("real", "nb-secrets", script("secrets", "via a link"));
    const links = join(root, "links");
    mkdirSync(links);
    symlinkSync(join(real, "nb-secrets"), join(links, "nb-secrets"));
    expect(findPlugins(links, RESERVED).map((p) => p.description)).toEqual(["via a link"]);
  });

  it("skips what is not a tool: not executable, a directory, a bad name, a built-in command's name, and anything not starting with nb-", () => {
    const d = tool("a", "nb-noexec", script("noexec", "x"), 0o644);
    tool("a", "nb-auth", script("auth", "hijack"));
    tool("a", "nb-Bad", script("Bad", "x"));
    tool("a", "other-tool", script("other-tool", "x"));
    mkdirSync(join(d, "nb-dir"));
    tool("a", "nb-good", script("good", "ok"));
    expect(findPlugins(d, RESERVED).map((p) => p.name)).toEqual(["good"]);
  });

  it("takes the first directory on PATH for a name, ignores a missing directory and an empty entry, and tolerates no PATH", () => {
    const first = tool("first", "nb-t", script("t", "first one"));
    const second = tool("second", "nb-t", script("t", "second one"));
    expect(findPlugins([join(root, "nowhere"), "", first, second].join(delimiter), RESERVED).map((p) => p.description)).toEqual(["first one"]);
    expect(findPlugins(undefined, RESERVED)).toEqual([]);
    expect(findPlugins("", RESERVED)).toEqual([]);
  });
});

describe("pluginCall", () => {
  const argv = (...a: string[]) => ["node", "nb", ...a];

  it("is a tool call when the first word after nb names an installed tool, with the rest of the command line as its arguments", () => {
    const d = tool("a", "nb-secrets", script("secrets", "x"));
    const call = pluginCall(argv("secrets", "run", "f.age", "--", "true"), d, RESERVED);
    expect(call && "plugin" in call && [call.plugin.name, call.args]).toEqual(["secrets", ["run", "f.age", "--", "true"]]);
  });

  it("leaves a built-in command, an option, no word, a name that is not plain, and an unknown word to the CLI", () => {
    const d = tool("a", "nb-secrets", script("secrets", "x"));
    tool("a", "nb-auth", script("auth", "hijack"));
    for (const a of [["auth", "status"], ["--help"], ["-h"], [], ["../secrets"], ["nosuchthing"], ["--env", "local", "secrets"]]) {
      expect(pluginCall(argv(...a), d, RESERVED), a.join(" ")).toBeUndefined();
    }
  });

  it("says a published tool is missing when it is not on PATH, and stays quiet for a word that is no known tool", () => {
    expect(pluginCall(argv("secrets"), join(root, "empty"), RESERVED)).toEqual({ missing: "secrets" });
    expect(pluginCall(argv("whatever"), join(root, "empty"), RESERVED)).toBeUndefined();
    expect(missingMessage("quickstarts")).toContain("https://github.com/nasebanal/nb-quickstarts");
  });
});

describe("pluginHelp", () => {
  it("lists the installed tools with their descriptions and, apart, where to get the published ones that are missing", () => {
    const text = pluginHelp([{ name: "secrets", file: "/x/nb-secrets", description: "keeps secrets" }]);
    expect(text).toContain("Tools (programs named nb-<name> on your PATH):");
    expect(text).toMatch(/\n {2}secrets {2}keeps secrets\n/);
    expect(text).toContain("Run `nb <tool> -h` for a tool's own usage.");
    expect(text).toContain("Other NASEBANAL tools (not installed");
    expect(text).toMatch(/\n {2}quickstarts {2}https:\/\/github\.com\/nasebanal\/nb-quickstarts\n/);
    expect(text).not.toMatch(/\n {2}secrets .*github/);
  });

  it("only points to the published tools when none is installed, and to nothing when all are", () => {
    expect(pluginHelp([])).not.toContain("Tools (programs named");
    expect(pluginHelp([])).toContain("nb-secrets");
    const all = pluginHelp([
      { name: "secrets", file: "/x", description: "" },
      { name: "quickstarts", file: "/y", description: "" },
    ]);
    expect(all).not.toContain("Other NASEBANAL tools");
  });
});

describe("runPlugin", () => {
  it("runs the program with the arguments after its name, tells it how it was called, and returns its exit status", async () => {
    const out = join(root, "out.txt");
    const d = tool("a", "nb-echo", `#!/bin/sh\nprintf '%s|%s' "$NB_PLUGIN_NAME" "$*" > '${out}'\nexit 3\n`);
    const status = await runPlugin({ name: "echo", file: join(d, "nb-echo"), description: "" }, ["a", "b c"]);
    expect(status).toBe(3);
    expect(readFileSync(out, "utf8")).toBe("nb echo|a b c");
  });

  it("returns 128 plus the signal number when the program is killed, and 126 when it cannot be started", async () => {
    const d = tool("a", "nb-die", "#!/bin/sh\nkill -TERM $$\n");
    expect(await runPlugin({ name: "die", file: join(d, "nb-die"), description: "" }, [])).toBe(128 + 15);
    const err: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    try {
      expect(await runPlugin({ name: "gone", file: join(root, "does-not-exist"), description: "" }, [])).toBe(126);
    } finally {
      process.stderr.write = orig;
    }
    expect(err.join("")).toContain("cannot run");
  });
});
