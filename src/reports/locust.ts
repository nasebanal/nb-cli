/**
 * Locust's CSV output (`--csv <prefix>`) -> the normalised `load` summary.
 *
 * The pass/fail rule is the one nb-quickstarts' `locust/bin/exit_code.py`
 * applies to Locust's own exit code, reproduced from the files so a report can
 * be uploaded after the run without carrying the exit code along: any unhandled
 * task exception, or a failure ratio above the allowed one, fails the run.
 */
import { toRecords } from "./csv.js";
import type { SuiteFailure } from "./junit.js";

export interface LocustFiles {
  stats: string;
  failures?: string;
  exceptions?: string;
  history?: string;
}

export interface LocustSummary {
  total: number;
  passed: number;
  failed: number;
  duration_ms: number | null;
  metrics: Record<string, number>;
  failures: SuiteFailure[];
  status: "passed" | "failed";
  /** Why the run failed, for the CLI's one-line report; empty when it passed. */
  reasons: string[];
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "N/A") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export function summariseLocust(files: LocustFiles, maxFailRatio: number): LocustSummary {
  const stats = toRecords(files.stats);
  const total = stats.find((r) => r.Name === "Aggregated");
  if (!total) throw new Error('No "Aggregated" row in the stats CSV - is this a Locust *_stats.csv file?');

  const requests = num(total["Request Count"]) ?? 0;
  const failed = num(total["Failure Count"]) ?? 0;

  const metrics: Record<string, number> = { requests, failures: failed };
  const put = (key: string, value: number | null) => {
    if (value !== null) metrics[key] = round(value);
  };
  put("avg_ms", num(total["Average Response Time"]));
  put("p50_ms", num(total["50%"]) ?? num(total["Median Response Time"]));
  put("p95_ms", num(total["95%"]));
  put("p99_ms", num(total["99%"]));
  put("max_ms", num(total["Max Response Time"]));
  put("rps", num(total["Requests/s"]));
  const ratio = requests > 0 ? failed / requests : 0;
  metrics.error_rate_pct = round(ratio * 100);

  const exceptions = files.exceptions ? toRecords(files.exceptions).length : 0;
  if (files.exceptions !== undefined) metrics.exceptions = exceptions;

  const failures: SuiteFailure[] = (files.failures ? toRecords(files.failures) : []).map((r) => ({
    name: `${r.Method ?? ""} ${r.Name ?? ""}`.trim() || "(unnamed request)",
    message: r.Error ? `${r.Error}${r.Occurrences ? ` (x${r.Occurrences})` : ""}` : null,
  }));

  let duration_ms: number | null = null;
  if (files.history) {
    const stamps = toRecords(files.history)
      .map((r) => num(r.Timestamp))
      .filter((n): n is number => n !== null);
    if (stamps.length > 1) duration_ms = Math.round((Math.max(...stamps) - Math.min(...stamps)) * 1000);
  }

  const reasons: string[] = [];
  if (exceptions > 0) reasons.push(`${exceptions} unhandled task exception(s)`);
  if (ratio > maxFailRatio) {
    reasons.push(`failure ratio ${(ratio * 100).toFixed(1)}% > allowed ${(maxFailRatio * 100).toFixed(1)}%`);
  }

  return {
    total: requests,
    passed: requests - failed,
    failed,
    duration_ms,
    metrics,
    failures,
    status: reasons.length === 0 ? "passed" : "failed",
    reasons,
  };
}
