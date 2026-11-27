import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The CLI as a user runs it. PATH holds nothing, so no `nb-*` tool of this machine appears in the help. */
const nbOnPath = (path: string, ...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: path, NB_NO_UPDATE_NOTIFIER: "1" } });
const nb = (...args: string[]) => nbOnPath("", ...args);

describe("tab completion in the help (set up once, so not among the everyday commands)", () => {
  const help = nb("--help");
  const commands = help.slice(help.indexOf("Commands:"), help.indexOf("[beta] marks"));

  it("is not in the command list", () => {
    expect(commands).toContain("auth");
    expect(commands).toContain("upgrade");
    expect(commands).not.toContain("completion");
  });

  it("is said in one line at the end of the help, with how to set it up", () => {
    expect(help.trimEnd().split("\n").at(-1)).toBe("Tab completion (set up once): source <(nb completion zsh)   # or bash");
  });

  it("is set off by one blank line, with tools installed or not", () => {
    expect(help).toMatch(/[^\n]\n\nTab completion \(set up once\)/);
    const bin = mkdtempSync(join(tmpdir(), "nb-help-"));
    writeFileSync(join(bin, "nb-demo"), "#!/bin/sh\n# nb-demo - a demo tool\n", { mode: 0o755 });
    const withTool = nbOnPath(bin, "--help");
    expect(withTool).toContain("a demo tool");
    expect(withTool).toMatch(/[^\n]\n\nTab completion \(set up once\)/);
  });

  it("still works as before, and explains itself", () => {
    expect(nb("completion", "zsh")).toContain("compdef _nb nb");
    expect(nb("completion", "bash")).toContain("complete -F _nb_complete nb");
    expect(nb("completion", "--help")).toContain("source <(nb completion zsh)");
  });

  it("is left out of what Tab offers, while its shells are still offered below it", () => {
    expect(nb("__complete", "comp").trim()).toBe("");
    expect(nb("__complete", "au").trim()).toBe("auth");
  });
}, 60000);
