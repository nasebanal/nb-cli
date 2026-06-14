/**
 * Output helpers. Default output is pretty JSON to stdout; errors go to stderr.
 * A future iteration can add `--format table` once command metadata is richer.
 */
import { ApiError } from "./http.js";

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
    }
    return;
  }
  process.stderr.write(`Error: ${(err as Error).message ?? String(err)}\n`);
}
