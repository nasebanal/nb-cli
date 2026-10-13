import { describe, expect, it } from "vitest";
import { parseSpecmaticCoverage } from "./specmatic.js";

// The shape `specmatic test` (2.55) embeds in its HTML report, trimmed to what is read.
const doc = (details: unknown) => ({
  results: { tool: { name: "Specmatic" }, summary: { tests: 24, extra: { executionDetails: details } } },
  reportFormat: "CTRF",
});
const one = { specification: "/shared/openapi/openapi.yaml", coverageMetrics: { apiCoverage: 90, coveredOperations: 19, totalOperationsWithFilters: 21, totalOperations: 22 } };

const asHtml = (json: unknown) =>
  `<html><script>app()</script><script>\n(function() {\n const report = ${JSON.stringify(json)};\n const specmaticConfig = {};\n})();</script></html>`;

describe("parseSpecmaticCoverage", () => {
  it("reads the coverage from a JSON copy of the report", () => {
    expect(parseSpecmaticCoverage(JSON.stringify(doc([one])))).toEqual({ coverage_pct: 90.5, covered: 19, total: 21 });
  });

  it("reads it from the HTML report, where it is embedded as `const report = {...}`", () => {
    expect(parseSpecmaticCoverage(asHtml(doc([one])))).toEqual({ coverage_pct: 90.5, covered: 19, total: 21 });
  });

  it("is not confused by braces and quotes inside strings of the embedded report", () => {
    const tricky = { ...one, specification: 'a "quoted" } path {', operations: [{ path: "/x/{id}", reasons: ['say "hi" \\ }'] }] };
    expect(parseSpecmaticCoverage(asHtml(doc([tricky]))).covered).toBe(19);
  });

  it("adds several specs together, counting operations rather than averaging percentages", () => {
    const a = { coverageMetrics: { coveredOperations: 1, totalOperationsWithFilters: 2 } };
    const b = { coverageMetrics: { coveredOperations: 9, totalOperationsWithFilters: 10 } };
    expect(parseSpecmaticCoverage(JSON.stringify(doc([a, b])))).toEqual({ coverage_pct: 83.3, covered: 10, total: 12 });
  });

  it("falls back to totalOperations when no filter was applied", () => {
    const d = { coverageMetrics: { coveredOperations: 3, totalOperations: 4 } };
    expect(parseSpecmaticCoverage(JSON.stringify(doc([d]))).coverage_pct).toBe(75);
  });

  it("names the problem when the file is not a Specmatic report", () => {
    expect(() => parseSpecmaticCoverage("<html>nothing</html>")).toThrow(/no embedded report/);
    expect(() => parseSpecmaticCoverage("{ not json")).toThrow(/Cannot read the Specmatic report/);
    expect(() => parseSpecmaticCoverage(JSON.stringify({ results: {} }))).toThrow(/no executionDetails/);
    expect(() => parseSpecmaticCoverage(JSON.stringify(doc([{ coverageMetrics: { coveredOperations: 0, totalOperationsWithFilters: 0 } }])))).toThrow(/no operations/);
  });
});
