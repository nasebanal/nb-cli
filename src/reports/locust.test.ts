import { describe, it, expect } from "vitest";
import { parseCsv, toRecords } from "./csv.js";
import { summariseLocust } from "./locust.js";

const HEADER =
  "Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,66%,75%,80%,90%,95%,98%,99%,99.9%,99.99%,100%";
const STATS = (reqs: number, fails: number) =>
  `${HEADER}\nGET,/api/accounts,${reqs},${fails},12,15.5,3,210,100,${reqs / 10},0,12,14,16,18,25,40,80,120,200,210,210\n,Aggregated,${reqs},${fails},12,15.5,3,210,100,${reqs / 10},${fails / 10},12,14,16,18,25,40,80,120,200,210,210\n`;

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas/newlines and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });
  it("skips blank lines and reads records by header", () => {
    expect(toRecords("k,v\n\n1,2\n")).toEqual([{ k: "1", v: "2" }]);
    expect(toRecords("")).toEqual([]);
  });
});

describe("summariseLocust", () => {
  it("builds the load summary from the Aggregated row", () => {
    const r = summariseLocust({ stats: STATS(1000, 0) }, 0);
    expect(r).toMatchObject({ total: 1000, passed: 1000, failed: 0, status: "passed", reasons: [] });
    expect(r.metrics).toMatchObject({
      requests: 1000,
      failures: 0,
      avg_ms: 15.5,
      p50_ms: 12,
      p95_ms: 40,
      p99_ms: 120,
      max_ms: 210,
      rps: 100,
      error_rate_pct: 0,
    });
  });

  it("fails on any failed request when no failures are tolerated, passes within the allowed ratio", () => {
    const strict = summariseLocust({ stats: STATS(1000, 5) }, 0);
    expect(strict.status).toBe("failed");
    expect(strict.reasons[0]).toMatch(/failure ratio 0\.5% > allowed 0\.0%/);
    expect(strict.metrics.error_rate_pct).toBe(0.5);
    expect(summariseLocust({ stats: STATS(1000, 5) }, 0.01).status).toBe("passed");
  });

  it("fails on unhandled task exceptions regardless of the ratio, and counts them", () => {
    const exceptions = "Count,Message,Traceback,Nodes\n2,boom,trace,worker1\n";
    const r = summariseLocust({ stats: STATS(100, 0), exceptions }, 1);
    expect(r.status).toBe("failed");
    expect(r.reasons).toEqual(["1 unhandled task exception(s)"]);
    expect(r.metrics.exceptions).toBe(1);
    expect(summariseLocust({ stats: STATS(100, 0), exceptions: "Count,Message,Traceback,Nodes\n" }, 0).status).toBe("passed");
  });

  it("lists failures with their occurrences, and measures the run from the history", () => {
    const failures = 'Method,Name,Error,Occurrences\nGET,/api/accounts,"HTTPError(\'500 Server Error, retry\')",3\n';
    const history = "Timestamp,User Count,Type,Name\n1700000000,5,,Aggregated\n1700000030,5,,Aggregated\n";
    const r = summariseLocust({ stats: STATS(10, 3), failures, history }, 1);
    expect(r.failures).toEqual([{ name: "GET /api/accounts", message: "HTTPError('500 Server Error, retry') (x3)" }]);
    expect(r.duration_ms).toBe(30000);
  });

  it("treats a run with no requests as passing (like Locust's exit code) and rejects a non-stats file", () => {
    expect(summariseLocust({ stats: STATS(0, 0) }, 0).status).toBe("passed");
    expect(() => summariseLocust({ stats: "a,b\n1,2\n" }, 0)).toThrow(/Aggregated/);
  });
});
