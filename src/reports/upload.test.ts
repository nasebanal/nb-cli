import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MAX_CASES, buildReportUploadCommand, checkApiVersion, checkSuite, parseMetrics, parseReport, toCases } from "./upload.js";

const JUNIT = `<testsuites><testsuite name="s"><testcase classname="c" name="a" time="1.5"/><testcase classname="c" name="b"><failure message="nope"/></testcase></testsuite></testsuites>`;
const LOCUST_STATS =
  "Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,95%,99%\n" +
  ",Aggregated,200,0,10,12,2,90,50,20,0,10,30,60\n";

let dir: string;
let calls: { method: string; url: URL; body: any }[];
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-upload-"));
  calls = [];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
  vi.stubEnv("NB_BASE_URL", "http://api.test");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITLAB_CI", "");
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fake Assurance API: `existing` is the project the name lookup finds (if any). */
function stubApi(existing: { id: string } | null, opts: { conflictOnCreate?: boolean } = {}) {
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init.method), url, body });
      const json = (status: number, data: unknown) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (init.method === "GET") {
        const hit = existing ?? (created ? { id: "raced" } : null);
        return json(200, { success: true, data: { data: hit ? [hit] : [], total: hit ? 1 : 0, limit: 20 } });
      }
      if (url.pathname === "/api/v1/projects") {
        if (opts.conflictOnCreate) {
          created = true;
          return json(409, { success: false, error: { code: "CONFLICT", message: "exists" } });
        }
        return json(201, { success: true, data: { id: "new1" } });
      }
      return json(201, { success: true, data: { run_id: "run1", suite_id: "suite1", replaced: false } });
    }),
  );
}

async function run(args: string[]) {
  const program = new Command().exitOverride().option("--env <env>").option("--token <token>");
  const assurance = program.command("assurance");
  assurance.command("report").addCommand(buildReportUploadCommand());
  await program.parseAsync(["node", "nb", "--token", "tkn", "assurance", "report", "upload", ...args]);
}

const junitFile = () => {
  const f = join(dir, "junit.xml");
  writeFileSync(f, JUNIT);
  return f;
};

describe("cases in the payload", () => {
  it("sends the per-test cases of a JUnit report", () => {
    const { suite } = parseReport({ format: "junit", kind: "unit", tool: "vitest", maxFailRatio: 0, file: junitFile() });
    expect(suite.cases).toEqual([
      { name: "c > a", status: "passed", duration_ms: 1500 },
      { name: "c > b", status: "failed", message: "nope" },
    ]);
  });

  it("sends none for Locust", () => {
    const f = join(dir, "locust_stats.csv");
    writeFileSync(f, LOCUST_STATS);
    const { suite } = parseReport({ format: "locust", kind: "load", tool: "locust", maxFailRatio: 0, file: f });
    expect(suite.cases).toBeUndefined();
  });

  it("over the limit keeps failed and skipped tests first, in original order", () => {
    const list = Array.from({ length: MAX_CASES + 10 }, (_, i) => ({
      name: `t${i}`,
      status: (i === MAX_CASES + 5 ? "failed" : i === 3 ? "skipped" : "passed") as "passed" | "failed" | "skipped",
      duration_ms: null,
      message: null,
    }));
    const out = toCases(list)!;
    expect(out).toHaveLength(MAX_CASES);
    expect(out.map((c) => c.name)).toContain(`t${MAX_CASES + 5}`);
    expect(out.map((c) => c.name)).toContain("t3");
    expect(out.map((c) => c.name)).not.toContain(`t${MAX_CASES + 9}`);
    const idx = out.map((c) => Number(c.name.slice(1)));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("clips each message and stops adding message text past the total budget", () => {
    const list = Array.from({ length: 700 }, (_, i) => ({
      name: `t${i}`,
      status: "failed" as const,
      duration_ms: null,
      message: "y".repeat(5000),
    }));
    const out = toCases(list)!;
    expect(out).toHaveLength(700);
    expect(out[0].message!.length).toBe(2000);
    const total = out.reduce((n, c) => n + (c.message?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(1_000_000);
    expect(out[699].message).toBeUndefined();
    expect(out[699].status).toBe("failed");
  });

  it("returns nothing for an empty list", () => {
    expect(toCases([])).toBeUndefined();
  });
});

describe("parseReport", () => {
  it("derives status and counts from JUnit, and clips to the API's caps", () => {
    const long = "x".repeat(900);
    const f = join(dir, "long.xml");
    writeFileSync(f, `<testsuite>${Array.from({ length: 30 }, (_, i) => `<testcase name="t${i}${long}"><failure message="${long}"/></testcase>`).join("")}</testsuite>`);
    const { suite } = parseReport({ format: "junit", kind: "unit", tool: "vitest", maxFailRatio: 0, file: f });
    expect(suite.status).toBe("failed");
    expect(suite.tests).toEqual({ total: 30, passed: 0, failed: 30, skipped: 0 });
    expect(suite.failures).toHaveLength(20);
    expect(suite.failures![0].name.length).toBeLessThanOrEqual(300);
    expect(suite.failures![0].message!.length).toBeLessThanOrEqual(500);
  });

  it("lets --status override the derived verdict", () => {
    const { suite } = parseReport({ format: "junit", kind: "unit", tool: "pytest", status: "passed", maxFailRatio: 0, file: junitFile() });
    expect(suite.status).toBe("passed");
  });

  it("reads Locust siblings next to the stats file", () => {
    writeFileSync(join(dir, "locust_stats.csv"), LOCUST_STATS);
    writeFileSync(join(dir, "locust_failures.csv"), "Method,Name,Error,Occurrences\n");
    writeFileSync(join(dir, "locust_exceptions.csv"), "Count,Message,Traceback,Nodes\n1,boom,t,w\n");
    const { suite } = parseReport({ format: "locust", kind: "load", tool: "locust", maxFailRatio: 0, file: join(dir, "locust_stats.csv") });
    expect(suite.status).toBe("failed"); // the unhandled exception
    expect(suite.metrics).toMatchObject({ requests: 200, p95_ms: 30, exceptions: 1 });
  });
});

describe("nb assurance report upload", () => {
  it("creates the project when missing, then reports the result with CI details", async () => {
    stubApi(null);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "nasebanal/nb-target-api");
    vi.stubEnv("GITHUB_RUN_ID", "555");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1"); // set by Actions itself (2 on a re-run); pin it so the key is stable
    vi.stubEnv("GITHUB_SHA", "abc123");
    vi.stubEnv("GITHUB_REF_NAME", "main");
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest"]);

    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /api/v1/projects?name=nasebanal%2Fnb-target-api",
      "POST /api/v1/projects",
      "POST /api/v1/projects/new1/results",
    ]);
    expect(calls[1].body).toEqual({ name: "nasebanal/nb-target-api", repo: "nasebanal/nb-target-api" });
    expect(calls[2].body.run).toEqual({
      key: "555-1",
      commit_sha: "abc123",
      branch: "main",
      ci_url: "https://github.com/nasebanal/nb-target-api/actions/runs/555",
    });
    expect(calls[2].body.suite).toMatchObject({ kind: "unit", tool: "vitest", status: "failed", tests: { total: 2, passed: 1, failed: 1, skipped: 0 }, duration_ms: 1500 });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ project_id: "new1", project_created: true, run_id: "run1", replaced: false });
    expect(stderr.join("")).toContain("(created)");
    expect(process.exitCode).toBeUndefined();
  });

  it("uses the project that already exists and sends the bearer token", async () => {
    stubApi({ id: "p9" });
    await run(["--file", junitFile(), "--kind", "e2e", "--tool", "playwright", "--project", "demo", "--run-key", "k1"]);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toEqual(["GET /api/v1/projects", "POST /api/v1/projects/p9/results"]);
    expect(calls[0].url.searchParams.get("name")).toBe("demo");
    const headers = (fetch as unknown as { mock: { calls: [URL, RequestInit][] } }).mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tkn");
  });

  it("recovers when another job creates the project first (409)", async () => {
    stubApi(null, { conflictOnCreate: true });
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "pytest", "--project", "demo", "--run-key", "k"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/projects/raced/results");
  });

  it("refuses to create a missing project with --no-create-project", async () => {
    stubApi(null);
    await expect(run(["--file", junitFile(), "--kind", "unit", "--tool", "pytest", "--project", "demo", "--run-key", "k", "--no-create-project"])).rejects.toThrow(/No project named 'demo'/);
    expect(calls).toHaveLength(1);
  });

  it("uploads a Locust directory as a load suite, with the allowed failure ratio from the environment", async () => {
    stubApi({ id: "p1" });
    writeFileSync(join(dir, "locust_stats.csv"), LOCUST_STATS.replace(",200,0,", ",200,4,"));
    vi.stubEnv("LOCUST_MAX_FAIL_RATIO", "0.05");
    await run(["--dir", dir, "--project", "demo", "--run-key", "k"]);
    expect(calls.at(-1)!.body.suite).toMatchObject({ kind: "load", tool: "locust", status: "passed", tests: { total: 200, passed: 196, failed: 4 } });
  });

  it("--dry-run prints the payload and calls nothing", async () => {
    stubApi(null);
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--project", "demo", "--run-key", "k", "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join("")).payload.run.key).toBe("k");
  });

  it("--coverage-report adds the Specmatic API coverage as the coverage_pct metric, and only for specmatic", async () => {
    stubApi(null);
    const cov = join(dir, "report.json");
    writeFileSync(cov, JSON.stringify({ results: { summary: { extra: { executionDetails: [{ coverageMetrics: { coveredOperations: 19, totalOperationsWithFilters: 21 } }] } } } }));
    const base = ["--project", "demo", "--run-key", "k", "--dry-run"];
    await run([...base, "--file", junitFile(), "--kind", "contract", "--tool", "specmatic", "--coverage-report", cov]);
    expect(JSON.parse(stdout.join("")).payload.suite.metrics).toEqual({ coverage_pct: 90.5 });
    expect(stderr.join("")).toContain("API coverage 90.5% (19/21 operations)");
    await expect(run([...base, "--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--coverage-report", cov])).rejects.toThrow(/only for --kind contract --tool specmatic/);
    await expect(run([...base, "--file", junitFile(), "--kind", "contract", "--tool", "specmatic", "--coverage-report", join(dir, "nope.json")])).rejects.toThrow(/File not found/);
  });

  it("--api-version labels the result and leaves the suite name alone: the version is part of the identity, not of the name", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "contract", "--tool", "specmatic"];
    await run([...base, "--file", junitFile(), "--api-version", "v2", "--suite", "backend-provider"]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ api_version: "v2", name: "backend-provider" });
    stdout.length = 0;
    await run([...base, "--file", junitFile(), "--api-version", "v2"]);
    const noName = JSON.parse(stdout.join("")).payload.suite;
    expect(noName.api_version).toBe("v2");
    expect(noName.name).toBeUndefined();
    stdout.length = 0;
    // no version: nothing is added, the result holds for every version
    await run([...base, "--file", junitFile()]);
    expect(JSON.parse(stdout.join("")).payload.suite.api_version).toBeUndefined();
  });

  it("--metric adds numbers to the suite, on top of what the report gave, and several can be repeated", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "security", "--tool", "zap", "--file", junitFile()];
    await run([...base, "--metric", "high=0", "--metric", "medium=3", "--metric", "low=2"]);
    expect(JSON.parse(stdout.join("")).payload.suite.metrics).toEqual({ high: 0, medium: 3, low: 2 });
    expect(stderr.join("")).toContain("metrics high=0 medium=3 low=2");
    stdout.length = 0;
    await run([...base]);
    expect(JSON.parse(stdout.join("")).payload.suite.metrics).toBeUndefined();
  });

  it("refuses a malformed --metric before anything is sent", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--kind", "security", "--tool", "zap", "--file", junitFile()];
    for (const bad of ["high", "high=", "High=1", "high=abc", "1high=2", "=3"]) {
      await expect(run([...base, "--metric", bad])).rejects.toThrow(/--metric/);
    }
    expect(calls).toHaveLength(0);
    expect(parseMetrics(["a_b=1.5", "c=-2"])).toEqual({ a_b: 1.5, c: -2 });
    expect(() => parseMetrics(Array.from({ length: 21 }, (_, i) => `k${i}=1`))).toThrow(/At most 20/);
  });

  it("refuses a version that is not a label before anything is sent", async () => {
    stubApi(null);
    await expect(run(["--project", "demo", "--run-key", "k", "--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--api-version", "v 1"])).rejects.toThrow(/not a version label/);
    expect(calls).toHaveLength(0);
    expect(checkApiVersion(" v1 ")).toBe("v1");
    expect(() => checkApiVersion("x".repeat(33))).toThrow();
  });

  it("explains missing or invalid inputs", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k"];
    await expect(run([...base])).rejects.toThrow(/--file/);
    await expect(run([...base, "--file", join(dir, "nope.xml"), "--kind", "unit", "--tool", "x"])).rejects.toThrow(/File not found/);
    await expect(run([...base, "--file", junitFile(), "--tool", "x"])).rejects.toThrow(/--kind is required/);
    await expect(run([...base, "--file", junitFile(), "--kind", "unit"])).rejects.toThrow(/--tool is required/);
    await expect(run([...base, "--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--status", "ok"])).rejects.toThrow(/--status/);
    await expect(run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k"])).rejects.toThrow(/project name/);
    const txt = join(dir, "r.txt");
    writeFileSync(txt, "x");
    await expect(run([...base, "--file", txt, "--kind", "unit", "--tool", "x"])).rejects.toThrow(/--format/);
    expect(calls).toHaveLength(0);
  });
});

describe("checkSuite", () => {
  it("takes the tool as a lower-cased label, the known ones and any other", () => {
    for (const [kind, tool, format] of [["unit", "vitest", "junit"], ["unit", "pytest", "junit"], ["e2e", "playwright", "junit"], ["contract", "specmatic", "junit"], ["security", "zap", "junit"], ["load", "locust", "locust"], ["security", "trivy", "junit"], ["load", "k6", "junit"], ["e2e", "cypress", "junit"]] as const) {
      expect(checkSuite(kind, tool, format)).toBe(tool);
    }
    expect(checkSuite("unit", " Vitest ", "junit")).toBe("vitest");
  });

  it("rejects what is not a label", () => {
    for (const bad of ["", "two words", "-lead", "x".repeat(51), "a/b"]) expect(() => checkSuite("unit", bad, "junit"), bad).toThrow(/not a label/);
  });

  it("rejects a tool paired with the wrong report format", () => {
    expect(() => checkSuite("load", "locust", "junit")).toThrow(/locust format/);
    expect(() => checkSuite("unit", "vitest", "locust")).toThrow(/junit format/);
  });
});

describe("upload tool label", () => {
  it("fails before reading or sending anything when the tool is not a label", async () => {
    await expect(run(["--file", junitFile(), "--kind", "unit", "--tool", "not a label", "--project", "demo", "--run-key", "k"])).rejects.toThrow(/not a label/);
    expect(calls).toHaveLength(0);
  });

  it("sends a tool the platform has never heard of, with its cases", async () => {
    stubApi(null);
    await run(["--file", junitFile(), "--kind", "security", "--tool", "trivy", "--project", "demo", "--run-key", "k", "--dry-run"]);
    const suite = JSON.parse(stdout.join("")).payload.suite;
    expect(suite).toMatchObject({ kind: "security", tool: "trivy" });
    expect(suite.cases).toHaveLength(2);
  });
});
