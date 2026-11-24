/**
 * External tools: `nb <name> ...` runs the program `nb-<name>` found on PATH, the way `git` and `kubectl` do.
 *
 * Independent NASEBANAL tools (`nb-secrets`, `nb-quickstarts`) keep their own repositories, their own install and
 * their own release; they do not need Node or this package. `nb` only finds them and hands over, so `nb secrets -h`
 * shows the tool's own usage, and `nb -h` lists what is installed.
 *
 * Decisions that matter:
 *  - A built-in command always wins over a tool of the same name, so a tool cannot take over `nb auth`.
 *  - Nothing is executed to build the list (`nb -h` must be fast and must not run whatever happens to be called `nb-*`
 *    on PATH): the one-line description is READ from the first comment line of the script, `# nb-<name> - <what it does>`.
 *    A program that is not a script has a name and no description.
 *  - The program is started directly, never through a shell, and only when the user types its name.
 *  - macOS and Linux (executable bit, `:` in PATH). On Windows no tool is found.
 */
import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readdirSync, readSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { constants as osConstants } from "node:os";

export interface Plugin {
  /** `secrets` for `nb-secrets`. */
  name: string;
  /** The first path on PATH that holds it. */
  file: string;
  /** One line, or "" when the program is not a script that gives one. */
  description: string;
}

/** Tools NASEBANAL publishes, so `nb -h` and a mistyped call can say where to get one that is not installed. */
export const KNOWN_TOOLS: Record<string, { repo: string }> = {
  secrets: { repo: "https://github.com/nasebanal/nb-secrets" },
  quickstarts: { repo: "https://github.com/nasebanal/nb-quickstarts" },
};

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const DESCRIPTION_MAX = 100;

/** Whether `name` could be a tool name: plain lowercase, so nothing like `../x` ever reaches the file system. */
export function isPluginName(name: string): boolean {
  return NAME.test(name);
}

/** The one-line description in the first comment line after the shebang (`# nb-secrets - keep secrets ...`), or "". */
export function describePlugin(file: string, name: string): string {
  let head = "";
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(2048);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
  if (!head.startsWith("#!")) return ""; // a binary (or anything that is not a script) gives no description
  for (const line of head.split("\n").slice(1)) {
    if (!line.startsWith("#")) return "";
    const text = line.replace(/^#\s?/, "").trim();
    if (text === "") continue;
    const m = /^nb-([a-z0-9-]+)\s+-\s+(.+)$/.exec(text);
    // The first non-empty comment line is the description, or there is none: do not dig for one.
    return m && m[1] === name ? m[2].slice(0, DESCRIPTION_MAX) : "";
  }
  return "";
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false; // follows a symlink
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every `nb-<name>` on PATH, by name. The first directory on PATH wins, a name that is not plain or that a built-in
 * command already uses is skipped, and a file that is not executable is not a tool.
 */
export function findPlugins(pathEnv: string | undefined, reserved: ReadonlySet<string>): Plugin[] {
  if (process.platform === "win32" || !pathEnv) return [];
  const found = new Map<string, Plugin>();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("nb-")) continue;
      const name = entry.slice(3);
      if (!isPluginName(name) || reserved.has(name) || found.has(name)) continue;
      const file = join(dir, entry);
      if (!isExecutableFile(file)) continue;
      found.set(name, { name, file, description: describePlugin(file, name) });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What `nb <name> ...` should do with the command line, or undefined to let the CLI handle it as usual.
 * Only the first word after `nb` is looked at: `nb secrets run ...` is a tool call, `nb --env local secrets` is not.
 */
export function pluginCall(
  argv: readonly string[],
  pathEnv: string | undefined,
  reserved: ReadonlySet<string>,
): { plugin: Plugin; args: string[] } | { missing: string } | undefined {
  const name = argv[2];
  if (!name || !isPluginName(name) || reserved.has(name)) return undefined;
  const plugin = findPlugins(pathEnv, reserved).find((p) => p.name === name);
  if (plugin) return { plugin, args: argv.slice(3) };
  return name in KNOWN_TOOLS ? { missing: name } : undefined;
}

/** The "Tools" part of `nb -h`: what is installed with its description, and where to get the published tools that are not. */
export function pluginHelp(plugins: readonly Plugin[]): string {
  const lines: string[] = [""];
  if (plugins.length > 0) {
    lines.push("Tools:");
    const width = Math.max(...plugins.map((p) => p.name.length)) + 2;
    for (const p of plugins) lines.push(`  ${p.name.padEnd(width)}${p.description}`.trimEnd());
    lines.push("", "A tool is a program named nb-<name> on your PATH; `nb <tool> -h` shows its own usage.");
  }
  const absent = Object.entries(KNOWN_TOOLS).filter(([name]) => !plugins.some((p) => p.name === name));
  if (absent.length > 0) {
    if (plugins.length > 0) lines.push("");
    lines.push("Other tools (not installed; `nb <tool>` runs them once `nb-<tool>` is on your PATH):");
    const width = Math.max(...absent.map(([name]) => name.length)) + 2;
    for (const [name, t] of absent) lines.push(`  ${name.padEnd(width)}${t.repo}`);
  }
  return lines.join("\n") + "\n";
}

/** What `nb <name>` says when the tool is published but not on PATH. */
export function missingMessage(name: string): string {
  return (
    `nb: '${name}' is not installed. It is a separate tool, run by \`nb ${name}\` as \`nb-${name}\` from your PATH.\n` +
    `Get it from ${KNOWN_TOOLS[name].repo}`
  );
}

/**
 * Run the tool with the arguments after its name, the terminal and the environment as they are (plus
 * `NB_PLUGIN_NAME=nb <name>`, so a tool can print its usage the way it was called). Resolves to the exit status.
 */
export function runPlugin(plugin: Plugin, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(plugin.file, args, {
      stdio: "inherit",
      env: { ...process.env, NB_PLUGIN_NAME: `nb ${plugin.name}` },
    });
    // Ctrl-C reaches the whole foreground group: the tool decides what to do with it (a passphrase prompt, say), and
    // `nb` waits for it instead of leaving first. A terminate request is passed on.
    const ignoreInterrupt = () => undefined;
    const forwardTerminate = () => child.kill("SIGTERM");
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGTERM", forwardTerminate);
    const done = (status: number) => {
      process.off("SIGINT", ignoreInterrupt);
      process.off("SIGTERM", forwardTerminate);
      resolve(status);
    };
    child.on("error", (err) => {
      process.stderr.write(`nb: cannot run ${plugin.file}: ${err.message}\n`);
      done(126);
    });
    child.on("close", (code, signal) => {
      if (code !== null) return done(code);
      const sig = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
      done(sig ? 128 + sig : 1);
    });
  });
}
