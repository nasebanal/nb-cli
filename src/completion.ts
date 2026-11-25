/**
 * Tab completion: `nb completion zsh|bash` prints a script that asks `nb __complete <words...>` for candidates.
 *
 * The script is thin on purpose; what can be completed lives here, so it follows the command tree (the generated API
 * groups included) without a second list to keep up to date.
 *
 *  - The first word: the built-in commands and the tools found on PATH (`nb quick<TAB>` -> `quickstarts`).
 *  - Below a built-in command: its sub-commands, or its options after a `-`.
 *  - Below a tool: whatever `nb-<tool> --complete <words...>` prints, one candidate per line (the last word is the
 *    one being typed). A tool is asked only when its script contains the literal `--complete`: like `nb -h`, this
 *    must not run an `nb-*` program that never said it can answer.
 */
import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import type { Command } from "commander";
import type { Plugin } from "./plugins.js";

export const SHELLS = ["zsh", "bash"] as const;
export type Shell = (typeof SHELLS)[number];

/** Global options that take a value, so the word after one is not a command. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["--env", "--token"]);
const TOOL_TIMEOUT_MS = 2000;
const SCAN_BYTES = 64 * 1024;

export function completionScript(shell: Shell): string {
  if (shell === "zsh") {
    return [
      "# nb tab completion (zsh). Add to ~/.zshrc, after compinit:  source <(nb completion zsh)",
      "_nb() {",
      "  local -a candidates",
      '  candidates=("${(@f)$(nb __complete "${(@)words[2,CURRENT]}" 2>/dev/null)}")',
      "  candidates=(${candidates:#})",
      "  (( ${#candidates} )) && compadd -- $candidates",
      "}",
      "compdef _nb nb",
      "",
    ].join("\n");
  }
  return [
    "# nb tab completion (bash). Add to ~/.bashrc:  source <(nb completion bash)",
    "_nb_complete() {",
    "  local IFS=$'\\n'",
    '  COMPREPLY=($(nb __complete "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))',
    "}",
    "complete -F _nb_complete nb",
    "",
  ].join("\n");
}

/** Whether the tool's script says it answers `--complete` (read, never run). */
export function supportsComplete(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(SCAN_BYTES);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString("utf8");
      return text.startsWith("#!") && text.includes("--complete");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Ask a tool for candidates: its stdout lines, or nothing when it fails, times out or is silent. */
export function askTool(plugin: Plugin, words: readonly string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      plugin.file,
      ["--complete", ...words],
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, NB_PLUGIN_NAME: `nb ${plugin.name}` } },
      (err, stdout) => resolve(err ? [] : lines(stdout)),
    ).stdin?.end();
  });
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

function visible(cmd: Command): Command[] {
  return cmd.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden);
}

/**
 * The candidates for `words` (what follows `nb`; the last one is being typed, possibly empty).
 * `ask` is how a tool is asked, injected so a test needs no process.
 */
export async function complete(
  program: Command,
  plugins: readonly Plugin[],
  words: readonly string[],
  ask: (plugin: Plugin, words: readonly string[]) => Promise<string[]> = askTool,
): Promise<string[]> {
  if (words.length === 0) return [];
  const current = words[words.length - 1];
  let prior = words.slice(0, -1);

  // Global options come before the command: `nb --env local assu<TAB>`.
  while (prior.length > 0 && prior[0].startsWith("-")) {
    prior = prior.slice(GLOBAL_OPTIONS_WITH_VALUE.has(prior[0]) ? 2 : 1);
  }

  let names: string[];
  if (prior.length === 0) {
    if (current.startsWith("-")) {
      names = program.options.flatMap((o) => (o.long ? [o.long] : []));
    } else {
      names = [...visible(program).map((c) => c.name()), ...plugins.map((p) => p.name)];
    }
  } else {
    const builtin = program.commands.find((c) => c.name() === prior[0] || c.aliases().includes(prior[0]));
    const plugin = builtin ? undefined : plugins.find((p) => p.name === prior[0]);
    if (plugin) {
      return supportsComplete(plugin.file) ? ask(plugin, [...prior.slice(1), current]) : [];
    }
    let cmd = builtin;
    for (const w of prior.slice(1)) {
      if (!cmd) break;
      if (w.startsWith("-")) continue;
      cmd = cmd.commands.find((c) => c.name() === w || c.aliases().includes(w));
    }
    if (!cmd) return [];
    names = current.startsWith("-")
      ? cmd.options.flatMap((o) => (o.long ? [o.long] : []))
      : visible(cmd).map((c) => c.name());
  }
  return [...new Set(names)].filter((n) => n.startsWith(current)).sort();
}
