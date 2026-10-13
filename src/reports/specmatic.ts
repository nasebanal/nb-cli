/**
 * Specmatic's API coverage -> the `coverage_pct` metric of a `contract` suite.
 *
 * `specmatic test` writes JUnit XML (the pass/fail counts) and an HTML report. The coverage - how many of
 * the spec's operations a test actually exercised - is only in that report, as the JSON the page renders
 * from (`const report = {...}`, a CTRF-style document: `results.summary.extra.executionDetails[]` with a
 * `coverageMetrics` per spec). This reads the number out of either that HTML file or a plain JSON copy of
 * the same document, so the spec-derived coverage reaches Assurance without the spec itself being uploaded.
 *
 * The HTML embedding is Specmatic's own, not a documented interface: when it changes the parse fails with
 * a message naming the file, and the upload (without coverage) is still one flag away.
 */

export interface SpecmaticCoverage {
  /** Covered operations over the operations in scope, 0..100, one decimal. */
  coverage_pct: number;
  covered: number;
  total: number;
}

interface CoverageMetrics {
  coveredOperations?: number;
  totalOperationsWithFilters?: number;
  totalOperations?: number;
}

/** The end index (exclusive) of the JSON object that starts at `start`, honouring strings and escapes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unterminated JSON object");
}

function reportJson(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const marker = "const report = ";
  const at = text.indexOf(marker);
  if (at < 0) throw new Error("no embedded report found");
  const start = at + marker.length;
  return JSON.parse(text.slice(start, objectEnd(text, start)));
}

export function parseSpecmaticCoverage(text: string): SpecmaticCoverage {
  let doc: any;
  try {
    doc = reportJson(text);
  } catch (err) {
    throw new Error(`Cannot read the Specmatic report (${err instanceof Error ? err.message : String(err)})`);
  }
  const details: { coverageMetrics?: CoverageMetrics }[] | undefined = doc?.results?.summary?.extra?.executionDetails;
  if (!Array.isArray(details) || details.length === 0) {
    throw new Error("The Specmatic report has no executionDetails (was it written by `specmatic test`?)");
  }
  let covered = 0;
  let total = 0;
  for (const d of details) {
    const m = d.coverageMetrics;
    if (!m) continue;
    covered += m.coveredOperations ?? 0;
    total += m.totalOperationsWithFilters ?? m.totalOperations ?? 0;
  }
  if (total <= 0) throw new Error("The Specmatic report lists no operations to cover");
  return { coverage_pct: Math.round((covered / total) * 1000) / 10, covered, total };
}
