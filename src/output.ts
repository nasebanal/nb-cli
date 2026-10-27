/**
 * Output helpers. Default output is pretty JSON to stdout; errors go to stderr.
 * A future iteration can add `--format table` once command metadata is richer.
 */
import { appendFileSync } from "node:fs";
import { ApiError } from "./http.js";

/** In GitHub Actions, make a value available to later steps as `steps.<id>.outputs.<key>`. A missing output file never fails a command that succeeded. */
export function exportGithubOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try {
    appendFileSync(file, `${key}=${value}\n`);
  } catch {
    // The command succeeded; its output file is a convenience.
  }
}

/**
 * Why a 401 may come from the shell and not from the login: `NB_TOKEN` in the environment always wins over `nb auth login`
 * (the CI path), so a token left exported - typically a PAT made for production - is what gets sent, and a local server has
 * never heard of it. Null when `NB_TOKEN` is not set (then the hint to log in is the whole story).
 */
export function envTokenHint(): string | null {
  return process.env.NB_TOKEN ? "NB_TOKEN is set in this shell and takes priority over `nb auth login`. If it is not valid for this server (a PAT made for production is unknown to a local one), run `unset NB_TOKEN` and try again." : null;
}

export function printJson(data: unknown): void {
  if (typeof data === "string") {
    process.stdout.write(data + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function printError(err: unknown): void {
  if (err instanceof ApiError) {
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.data !== undefined && err.data !== "") {
      const body = typeof err.data === "string" ? err.data : JSON.stringify(err.data, null, 2);
      process.stderr.write(body + "\n");
    }
    if (err.status === 401) {
      process.stderr.write("\nHint: run `nb auth login` or set NB_TOKEN to authenticate.\n");
      const envHint = envTokenHint();
      if (envHint) process.stderr.write(`${envHint}\n`);
    }
    return;
  }
  process.stderr.write(`Error: ${(err as Error).message ?? String(err)}\n`);
}
