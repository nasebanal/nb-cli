import { describe, expect, it } from "vitest";
import { summariseZap } from "./zap.js";

const alert = (name: string, riskcode: string, extra: Record<string, unknown> = {}) => ({
  name, riskcode, confidence: "2", riskdesc: `${["Informational", "Low", "Medium", "High"][Number(riskcode)] ?? "?"} (Medium)`, count: "2",
  instances: [{ uri: "http://internal.example/secret?token=abc", evidence: "token=abc" }], desc: "<p>long text</p>", ...extra,
});
const report = (...sites: unknown[]) => JSON.stringify({ "@programName": "ZAP", "@version": "2.17.0", created: "2026-11-27T03:00:00Z", site: sites });
const site = (name: string, ...alerts: unknown[]) => ({ "@name": name, alerts });

describe("summariseZap", () => {
  const s = summariseZap(report(site("http://web", alert("Info one", "0"), alert("Low one", "1"), alert("Medium one", "2")), site("http://api", alert("High one", "3"))));

  it("reads every site, most severe first, with the severity counts", () => {
    expect(s.cases.map((c) => [c.name, c.status])).toEqual([["http://api > High one", "failed"], ["http://web > Medium one", "failed"], ["http://web > Low one", "failed"], ["http://web > Info one", "passed"]]);
    expect(s).toMatchObject({ total: 4, passed: 1, failed: 3, skipped: 0, metrics: { high: 1, medium: 1, low: 1, info: 1 }, version: "2.17.0" });
  });

  it("fails the run for a high alert only: medium and low are findings", () => {
    expect(s.status).toBe("failed");
    expect(summariseZap(report(site("http://web", alert("m", "2"), alert("l", "1")))).status).toBe("passed");
  });

  it("does not count a false positive, and keeps it as a skipped case", () => {
    const fp = summariseZap(report(site("http://web", alert("Not real", "3", { confidence: "0" }))));
    expect(fp).toMatchObject({ status: "passed", total: 1, failed: 0, skipped: 1, metrics: { high: 0, medium: 0, low: 0, info: 0 }, failures: [] });
    expect(fp.cases[0]).toMatchObject({ status: "skipped", message: "Marked as a false positive: High (Medium), 2 instance(s)" });
  });

  it("takes nothing that could hold a secret of the scanned system", () => {
    expect(JSON.stringify(s)).not.toMatch(/token=abc|internal\.example|long text/);
  });

  it("reads a scanned site with no alert as clean", () => {
    expect(summariseZap(report(site("http://web")))).toMatchObject({ status: "passed", total: 1, passed: 1, metrics: { high: 0 } });
  });

  it.each([
    ["not JSON", "<OWASPZAPReport/>"],
    ["JSON of something else", '{"results": []}'],
    ["no site at all (nothing was scanned)", report()],
    ["a site without its alerts", report({ "@name": "http://web" })],
    ["an unknown severity", report(site("http://web", alert("x", "4")))],
    ["an alert without a severity", report(site("http://web", { name: "x" }))],
  ])("refuses %s rather than calling it clean", (_what, file) => {
    expect(() => summariseZap(file)).toThrow();
  });
});
