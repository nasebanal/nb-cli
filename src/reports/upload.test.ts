import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MAX_CASES, buildReportUploadCommand, checkApiVersion, checkProjectId, checkSpecEnvironment, checkSpecId, checkProvider, checkReportPath, checkSuite, parseMetrics, parseReport, prepareAttachment, toCases } from "./upload.js";

const JUNIT = `<testsuites><testsuite name="s"><testcase classname="c" name="a" time="1.5"/><testcase classname="c" name="b"><failure message="nope"/></testcase></testsuite></testsuites>`;
const LOCUST_STATS =
  "Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,95%,99%\n" +
  ",Aggregated,200,0,10,12,2,90,50,20,0,10,30,60\n";

let dir: string;
let calls: { method: string; url: URL; body: any; bytes?: Uint8Array; contentType?: string; org?: string }[];
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
  vi.stubEnv("NB_API_VERSION", "");
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fake Assurance API: `existing` is the project the name lookup finds (if any). */
function stubApi(existing: { id: string; spec_id?: string | null; spec_environment?: string | null } | null, opts: { conflictOnCreate?: boolean; resultsStatus?: number; attachmentStatus?: number } = {}) {
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      const isAttach = url.pathname.endsWith("/attachment");
      const body = init.body && !isAttach ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: String(init.method),
        url,
        body,
        ...(isAttach ? { bytes: init.body as Uint8Array, contentType: (init.headers as Record<string, string>)["Content-Type"] } : {}),
      });
      const json = (status: number, data: unknown) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (init.method === "GET" && url.pathname !== "/api/v1/projects") {
        return json(200, { success: true, data: existing ?? { id: "unknown" } });
      }
      if (init.method === "PATCH") return json(200, { success: true, data: { id: "patched" } });
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
      if (isAttach) {
        if (opts.attachmentStatus && opts.attachmentStatus >= 400) {
          return json(opts.attachmentStatus, { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "An attachment can be at most 20971520 bytes" } });
        }
        return json(201, { success: true, data: { suite_id: "suite1", name: "x", size_bytes: 1 } });
      }
      if (opts.resultsStatus && opts.resultsStatus >= 400) {
        return json(opts.resultsStatus, { success: false, error: { code: "NOT_FOUND", message: "Project not found" } });
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
      provider: "github",
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

  it("--api-version labels the result and leaves the components alone: the version is part of the identity next to them", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "contract", "--tool", "specmatic"];
    await run([...base, "--file", junitFile(), "--api-version", "v2", "--component", "backend-provider"]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ api_version: "v2", components: ["backend-provider"] });
    stdout.length = 0;
    await run([...base, "--file", junitFile(), "--api-version", "v2"]);
    const noComponent = JSON.parse(stdout.join("")).payload.suite;
    expect(noComponent.api_version).toBe("v2");
    expect(noComponent.components).toBeUndefined();
    stdout.length = 0;
    // no version: nothing is added, the result holds for every version
    await run([...base, "--file", junitFile()]);
    expect(JSON.parse(stdout.join("")).payload.suite.api_version).toBeUndefined();
  });

  it("NB_API_VERSION is the default for --api-version; the flag wins, and an empty variable is none", async () => {
    stubApi(null);
    const args = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "contract", "--tool", "specmatic", "--file", junitFile()];
    vi.stubEnv("NB_API_VERSION", "v3");
    await run(args);
    expect(JSON.parse(stdout.join("")).payload.suite.api_version).toBe("v3");
    stdout.length = 0;
    await run([...args, "--api-version", "v4"]);
    expect(JSON.parse(stdout.join("")).payload.suite.api_version).toBe("v4");
    stdout.length = 0;
    vi.stubEnv("NB_API_VERSION", "");
    await run(args);
    expect(JSON.parse(stdout.join("")).payload.suite.api_version).toBeUndefined();
    vi.stubEnv("NB_API_VERSION", "v 1");
    await expect(run(args)).rejects.toThrow(/NB_API_VERSION 'v 1' is not a version label/);
  });

  it("--component is repeatable: a result may be about several components", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "e2e", "--tool", "playwright", "--file", junitFile()];
    await run([...base, "--component", "frontend", "--component", " backend ", "--component", "Frontend"]);
    expect(JSON.parse(stdout.join("")).payload.suite.components).toEqual(["frontend", "backend"]); // trimmed, no duplicate ignoring case
    stdout.length = 0;
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.components).toBeUndefined(); // the API names it `default`
  });

  it("--label tells apart two scans of one tool: sent trimmed, left out when not given, refused when empty or too long", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "security", "--tool", "zap", "--file", junitFile(), "--component", "frontend"];
    await run([...base, "--label", " full-scan "]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ components: ["frontend"], label: "full-scan" });
    stdout.length = 0;
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.label).toBeUndefined();
    await expect(run([...base, "--label", "  "])).rejects.toThrow(/must not be empty/);
    await expect(run([...base, "--label", "x".repeat(101)])).rejects.toThrow(/100 characters or fewer/);
  });

  it("--tool-version records the version of the tool: sent trimmed, left out when not given, refused when empty or too long", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "unit", "--tool", "pytest", "--file", junitFile()];
    await run([...base, "--tool-version", " 9.1.0 "]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ tool: "pytest", tool_version: "9.1.0" });
    stdout.length = 0;
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.tool_version).toBeUndefined();
    await expect(run([...base, "--tool-version", " "])).rejects.toThrow(/must not be empty/);
    await expect(run([...base, "--tool-version", "x".repeat(51)])).rejects.toThrow(/50 characters or fewer/);
  });

  it("--component refuses an empty or too long name and more than 20, and --suite is gone", async () => {
    stubApi(null);
    const base = ["--project", "demo", "--run-key", "k", "--dry-run", "--kind", "unit", "--tool", "vitest", "--file", junitFile()];
    await expect(run([...base, "--component", "  "])).rejects.toThrow(/must not be empty/);
    await expect(run([...base, "--component", "x".repeat(101)])).rejects.toThrow(/100 characters or fewer/);
    const many = Array.from({ length: 21 }, (_, i) => ["--component", `c${i}`]).flat();
    await expect(run([...base, ...many])).rejects.toThrow(/At most 20/);
    const flags = buildReportUploadCommand().options.map((o) => o.long);
    expect(flags).toContain("--component");
    expect(flags).not.toContain("--suite");
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

describe("sending to a project by id", () => {
  const base = () => ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k"];

  it("--project-id skips the lookup and the creation, and posts straight to that project", async () => {
    stubApi(null);
    await run([...base(), "--project-id", "p1abc", "--project", "renamed"]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /api/v1/projects/p1abc/results"]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ project_id: "p1abc", project_created: false });
    expect(stderr.join("")).toContain("--project is ignored");
    expect(stderr.join("")).toContain("id p1abc");
    expect(stderr.join("")).not.toContain("Pin it"); // already pinned: no nudge
  });

  it("reads NB_ASSURANCE_PROJECT_ID, and needs no project name then", async () => {
    stubApi(null);
    vi.stubEnv("NB_ASSURANCE_PROJECT_ID", "envproj");
    await run(base());
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/projects/envproj/results"]);
  });

  it("the flag wins over the environment", async () => {
    stubApi(null);
    vi.stubEnv("NB_ASSURANCE_PROJECT_ID", "envproj");
    await run([...base(), "--project-id", "flagproj"]);
    expect(calls[0].url.pathname).toBe("/api/v1/projects/flagproj/results");
  });

  it("an unknown id is an error naming the id, never a new project", async () => {
    stubApi(null, { resultsStatus: 404 });
    await expect(run([...base(), "--project-id", "nope"])).rejects.toThrow(/No project with id 'nope'/);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toEqual(["POST /api/v1/projects/nope/results"]);
  });

  it("other API errors with an id are passed on as they are", async () => {
    stubApi(null, { resultsStatus: 400 });
    await expect(run([...base(), "--project-id", "p1"])).rejects.not.toThrow(/No project with id/);
  });

  it("refuses an id that cannot be one, before anything is sent", async () => {
    stubApi(null);
    await expect(run([...base(), "--project-id", "../x"])).rejects.toThrow(/not a project id/);
    expect(calls).toHaveLength(0);
  });

  it("an upload by name tells how to pin the project, and prints the id", async () => {
    stubApi({ id: "p9" });
    await run([...base(), "--project", "demo"]);
    expect(stderr.join("")).toContain("--project-id p9");
    expect(stderr.join("")).toContain("NB_ASSURANCE_PROJECT_ID=p9");
  });

  it("--dry-run shows the id it would use", async () => {
    stubApi(null);
    await run([...base(), "--project-id", "p1", "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ project_id: "p1" });
  });

  it("writes project_id to GITHUB_OUTPUT when Actions provides one", async () => {
    stubApi({ id: "p9" });
    const out = join(dir, "gh-output");
    writeFileSync(out, "");
    vi.stubEnv("GITHUB_OUTPUT", out);
    await run([...base(), "--project", "demo"]);
    expect(readFileSync(out, "utf8")).toBe("project_id=p9\n");
  });

  it("does not fail the upload when GITHUB_OUTPUT cannot be written", async () => {
    stubApi({ id: "p9" });
    vi.stubEnv("GITHUB_OUTPUT", join(dir, "no-such-dir", "out"));
    await run([...base(), "--project", "demo"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/projects/p9/results");
  });

  it("checkProjectId trims, treats empty as none, and refuses what is not an id", () => {
    expect(checkProjectId(" abc123 ")).toBe("abc123");
    expect(checkProjectId("")).toBeUndefined();
    expect(checkProjectId(undefined)).toBeUndefined();
    expect(() => checkProjectId("a b")).toThrow();
    expect(() => checkProjectId("a/b")).toThrow();
    expect(() => checkProjectId("x".repeat(65))).toThrow();
  });
});

describe("the link to the report in the repository", () => {
  const base = () => ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--project", "demo", "--run-key", "k"];

  it("--provider is sent, and refused when it is not github, gitlab or other", async () => {
    stubApi({ id: "p1" });
    await run([...base(), "--provider", "GitLab"]);
    expect(calls.at(-1)!.body.run.provider).toBe("gitlab");
    expect(() => checkProvider("bitbucket")).toThrow(/github \| gitlab \| other/);
  });

  it("the provider comes from the CI, and is left out locally", async () => {
    stubApi({ id: "p1" });
    await run(base());
    expect(calls.at(-1)!.body.run).not.toHaveProperty("provider");

    calls = [];
    vi.stubEnv("GITLAB_CI", "true");
    vi.stubEnv("CI_PROJECT_PATH", "g/app");
    vi.stubEnv("CI_PIPELINE_ID", "5");
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest"]);
    expect(calls.at(-1)!.body.run.provider).toBe("gitlab");
  });

  it("--report-path is sent as given, and refused when it climbs out of the repository", async () => {
    stubApi({ id: "p1" });
    await run([...base(), "--report-path", "reports/junit.xml"]);
    expect(calls.at(-1)!.body.suite.report_path).toBe("reports/junit.xml");
    for (const bad of ["", "/etc/x", "../x.xml", "a//b", "a\\b"]) expect(() => checkReportPath(bad)).toThrow();
  });

  it("a report that is not committed gets no path", async () => {
    stubApi({ id: "p1" });
    await run(base()); // junit.xml was just written into a temp dir that is no repository
    expect(calls.at(-1)!.body.suite).not.toHaveProperty("report_path");
  });

  it("a report committed at the reported commit gets its path relative to the repository root", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    execFileSync("mkdir", ["-p", join(dir, "reports")]);
    writeFileSync(join(dir, "reports", "junit.xml"), JUNIT);
    git("add", ".");
    git("commit", "-q", "-m", "report");
    const sha = git("rev-parse", "HEAD");
    stubApi({ id: "p1" });
    await run(["--file", join(dir, "reports", "junit.xml"), "--kind", "unit", "--tool", "vitest", "--project", "demo", "--run-key", "k", "--commit", sha]);
    expect(calls.at(-1)!.body.suite.report_path).toBe("reports/junit.xml");

    // the same file, edited after the commit: the link would not show what was reported
    calls = [];
    writeFileSync(join(dir, "reports", "junit.xml"), JUNIT + " ");
    await run(["--file", join(dir, "reports", "junit.xml"), "--kind", "unit", "--tool", "vitest", "--project", "demo", "--run-key", "k", "--commit", sha]);
    expect(calls.at(-1)!.body.suite).not.toHaveProperty("report_path");
  });
});

describe("--attach: keeping the tool's own report with the result", () => {
  const base = () => ["--file", junitFile(), "--kind", "e2e", "--tool", "playwright", "--project", "demo", "--run-key", "k"];

  it("sends a file as it is, after the result, to the suite that result made", async () => {
    stubApi({ id: "p9" });
    const report = join(dir, "report.html");
    writeFileSync(report, "<html>the report</html>");
    await run([...base(), "--attach", report]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /api/v1/projects?name=demo",
      "POST /api/v1/projects/p9/results",
      "PUT /api/v1/projects/p9/runs/run1/suites/suite1/attachment?name=report.html",
    ]);
    const put = calls.at(-1)!;
    expect(Buffer.from(put.bytes!).toString()).toBe("<html>the report</html>");
    expect(put.contentType).toBe("application/octet-stream");
    expect(JSON.parse(stdout.join(""))).toMatchObject({ project_id: "p9", attachment: { name: "report.html", size_bytes: 23 } });
    expect(stderr.join("")).toContain("attached report.html");
  });

  it("zips a folder, named after it, and says it is a zip", async () => {
    stubApi({ id: "p9" });
    const folder = join(dir, "playwright-report");
    mkdirSync(join(folder, "data"), { recursive: true });
    writeFileSync(join(folder, "index.html"), "<html>site</html>");
    writeFileSync(join(folder, "data", "t.json"), "{}");
    await run([...base(), "--attach", folder + "/"]);
    const put = calls.at(-1)!;
    expect(put.url.searchParams.get("name")).toBe("playwright-report.zip");
    expect(put.contentType).toBe("application/zip");
    expect(Buffer.from(put.bytes!).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it("attaches nothing unless asked", async () => {
    stubApi({ id: "p9" });
    await run(base());
    expect(calls.some((c) => c.url.pathname.endsWith("/attachment"))).toBe(false);
    expect(JSON.parse(stdout.join(""))).not.toHaveProperty("attachment");
  });

  it("refuses a missing, empty or oversized attachment before anything is sent", async () => {
    stubApi({ id: "p9" });
    await expect(run([...base(), "--attach", join(dir, "nope")])).rejects.toThrow(/not found/);
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "");
    await expect(run([...base(), "--attach", empty])).rejects.toThrow(/is empty/);
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(100));
    expect(() => prepareAttachment(big, 50)).toThrow(/more than the/);
    expect(calls).toHaveLength(0);
  });

  it("keeps the result when the attachment is refused, and says so with the server's reason", async () => {
    stubApi({ id: "p9" }, { attachmentStatus: 413 });
    const report = join(dir, "report.html");
    writeFileSync(report, "x");
    await expect(run([...base(), "--attach", report])).rejects.toThrow(/The result was reported, but the attached report was not kept: An attachment can be at most/);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toContain("POST /api/v1/projects/p9/results");
  });

  it("--dry-run reads and measures it, and sends nothing", async () => {
    stubApi({ id: "p9" });
    const report = join(dir, "report.html");
    writeFileSync(report, "hello");
    await run([...base(), "--attach", report, "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ attachment: { name: "report.html", size_bytes: 5 } });
  });
});

describe("--spec-id: tying the project to an API of the catalog", () => {
  const base = () => ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--project", "demo", "--run-key", "k"];
  const patches = () => calls.filter((c) => c.method === "PATCH");

  it("creates a new project already linked, with no second call", async () => {
    stubApi(null);
    await run([...base(), "--spec-id", "spec_1", "--spec-environment", "production"]);
    expect(calls.find((c) => c.method === "POST" && c.url.pathname === "/api/v1/projects")!.body).toMatchObject({ name: "demo", spec_id: "spec_1", spec_environment: "production" });
    expect(patches()).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ project_created: true, spec: { id: "spec_1", environment: "production", changed: true, was: null } });
    expect(stderr.join("")).toContain("catalog spec_1 (production) (linked)");
  });

  it("links an existing project that has no link yet, after the result is in", async () => {
    stubApi({ id: "p9", spec_id: null, spec_environment: null });
    await run([...base(), "--spec-id", "spec_1"]);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toEqual(["GET /api/v1/projects", "POST /api/v1/projects/p9/results", "PATCH /api/v1/projects/p9"]);
    expect(patches()[0].body).toEqual({ spec_id: "spec_1" });
    expect(stderr.join("")).toContain("catalog spec_1 (linked)");
  });

  it("writes nothing when the project is already linked to it: a pipeline on every commit leaves it alone", async () => {
    stubApi({ id: "p9", spec_id: "spec_1", spec_environment: "production" });
    await run([...base(), "--spec-id", "spec_1", "--spec-environment", "production"]);
    expect(patches()).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec: { id: "spec_1", environment: "production", changed: false, was: "spec_1" } });
    expect(stderr.join("")).toContain("(already linked)");
  });

  it("leaves the environment alone when none is given and the spec is the same", async () => {
    stubApi({ id: "p9", spec_id: "spec_1", spec_environment: "staging" });
    await run([...base(), "--spec-id", "spec_1"]);
    expect(patches()).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec: { environment: "staging", changed: false } });
  });

  it("changes only the environment when the spec is the same and the environment differs", async () => {
    stubApi({ id: "p9", spec_id: "spec_1", spec_environment: "staging" });
    await run([...base(), "--spec-id", "spec_1", "--spec-environment", "production"]);
    expect(patches()[0].body).toEqual({ spec_environment: "production" });
  });

  it("points the project at another spec, and says what it was", async () => {
    stubApi({ id: "p9", spec_id: "old_spec", spec_environment: "production" });
    await run([...base(), "--spec-id", "new_spec"]);
    expect(patches()[0].body).toEqual({ spec_id: "new_spec" });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec: { id: "new_spec", environment: null, changed: true, was: "old_spec" } });
    expect(stderr.join("")).toContain("(changed from old_spec)");
  });

  it("with --project-id it reads the project once to compare, then writes only a difference", async () => {
    stubApi({ id: "p9", spec_id: "spec_1", spec_environment: null });
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k", "--project-id", "p9", "--spec-id", "spec_1"]);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toEqual(["POST /api/v1/projects/p9/results", "GET /api/v1/projects/p9"]);
    expect(patches()).toHaveLength(0);
  });

  it("without --spec-id nothing about the catalog is read or written", async () => {
    stubApi({ id: "p9", spec_id: "spec_1", spec_environment: null });
    await run(base());
    expect(patches()).toHaveLength(0);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toEqual(["GET /api/v1/projects", "POST /api/v1/projects/p9/results"]);
    expect(JSON.parse(stdout.join(""))).not.toHaveProperty("spec");
  });

  it("refuses an environment without a spec, and ids that cannot be one, before anything is sent", async () => {
    stubApi(null);
    await expect(run([...base(), "--spec-environment", "production"])).rejects.toThrow(/needs --spec-id/);
    await expect(run([...base(), "--spec-id", "../x"])).rejects.toThrow(/not a catalog spec id/);
    await expect(run([...base(), "--spec-id", "spec_1", "--spec-environment", " "])).rejects.toThrow(/1 to 40/);
    await expect(run([...base(), "--spec-id", "spec_1", "--spec-environment", "x".repeat(41)])).rejects.toThrow(/1 to 40/);
    expect(calls).toHaveLength(0);
  });

  it("--dry-run shows the link it would make and writes nothing", async () => {
    stubApi(null);
    await run([...base(), "--spec-id", "spec_1", "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec: { id: "spec_1" } });
  });

  it("keeps the result when the link is refused, and says so with the server's reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        if (init.method === "GET") return json(200, { success: true, data: { data: [{ id: "p9", spec_id: null, spec_environment: null }], total: 1, limit: 20 } });
        if (init.method === "PATCH") return json(400, { success: false, error: { code: "VALIDATION_ERROR", message: "spec_id is not a valid id" } });
        return json(201, { success: true, data: { run_id: "run1", suite_id: "suite1", replaced: false } });
      }),
    );
    await expect(run([...base(), "--spec-id", "spec_1"])).rejects.toThrow(/The result was reported, but the project could not be linked to the catalog: spec_id is not a valid id/);
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toContain("POST /api/v1/projects/p9/results");
  });

  it("checkSpecId and checkSpecEnvironment trim, and refuse what is not one", () => {
    expect(checkSpecId(" abc_1-2 ")).toBe("abc_1-2");
    expect(() => checkSpecId("a b")).toThrow();
    expect(() => checkSpecId("")).toThrow();
    expect(checkSpecEnvironment(" production ")).toBe("production");
  });
});

describe("--spec-file: the catalog, the project and the result in one command", () => {
  const DOC = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 1.0.0\npaths: {}\n";
  const base = () => ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--project", "demo", "--run-key", "k"];

  /** Two services behind one fetch: the catalog (specs.test) and Assurance (api.test). */
  function both(opts: { catalogSpecs?: { id: string; name: string; group_id: string | null; latest_version: number; hash?: string }[]; catalogFail?: boolean; project?: { id: string; spec_id?: string | null; spec_environment?: string | null } | null } = {}) {
    vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const url = new URL(String(input));
        const method = String(init.method);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body, org: (init.headers as Record<string, string>)["X-Active-Organization-Id"] });
        const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        if (url.host === "specs.test") {
          if (opts.catalogFail) return json(409, { success: false, error: { code: "LIMIT_REACHED", message: "A personal account can hold 3 specs" } });
          const specs = opts.catalogSpecs ?? [];
          if (method === "GET" && url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: specs, total: specs.length, limit: 3 } });
          const versions = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)\/versions$/);
          if (versions && method === "GET") {
            const hit = specs.find((s) => s.id === versions[1])!;
            return json(200, { success: true, data: { data: [{ version: hit.latest_version, content_hash: hit.hash }], total: 1 } });
          }
          if (method === "GET" && url.pathname === "/api/v1/groups") return json(200, { success: true, data: { data: [], total: 0, limit: 10 } });
          if (method === "POST" && url.pathname === "/api/v1/groups") return json(201, { success: true, data: { id: "g-new", name: body.name } });
          if (method === "POST" && url.pathname === "/api/v1/specs") return json(201, { success: true, data: { id: "spec9", name: body.name, group_id: body.group_id ?? null } });
          return json(500, { success: false, error: { code: "X", message: `${method} ${url.pathname}` } });
        }
        if (method === "GET") {
          const hit = opts.project === undefined ? null : opts.project;
          return json(200, { success: true, data: { data: hit ? [hit] : [], total: hit ? 1 : 0, limit: 20 } });
        }
        if (method === "PATCH") return json(200, { success: true, data: { id: "patched" } });
        if (url.pathname === "/api/v1/projects") return json(201, { success: true, data: { id: "new1" } });
        return json(201, { success: true, data: { run_id: "run1", suite_id: "suite1", replaced: false } });
      }),
    );
  }
  const specFile = () => {
    const f = join(dir, "openapi.yaml");
    writeFileSync(f, DOC);
    return f;
  };
  const at = () => calls.map((c) => `${c.url.host} ${c.method} ${c.url.pathname}`);

  it("registers the spec, creates the project already tied to it, and reports the result", async () => {
    both();
    await run([...base(), "--spec-file", specFile(), "--spec-environment", "production"]);
    expect(at()).toEqual([
      "specs.test GET /api/v1/specs",
      "specs.test POST /api/v1/specs",
      "api.test GET /api/v1/projects",
      "api.test POST /api/v1/projects",
      "api.test POST /api/v1/projects/new1/results",
    ]);
    expect(calls[1].body).toMatchObject({ name: "Billing API", content: DOC });
    expect(calls[3].body).toMatchObject({ name: "demo", spec_id: "spec9", spec_environment: "production" });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ project_created: true, catalog: { id: "spec9", action: "created" }, spec: { id: "spec9", changed: true } });
    expect(stderr.join("")).toContain("spec Billing API v1 (created)");
  });

  it("changes nothing in the catalog or the project when the file and the link are already right", async () => {
    both({ catalogSpecs: [{ id: "spec9", name: "Billing API", group_id: null, latest_version: 4, hash: hashOf(DOC) }], project: { id: "p9", spec_id: "spec9", spec_environment: null } });
    await run([...base(), "--spec-file", specFile()]);
    expect(calls.filter((c) => c.method === "POST" || c.method === "PATCH").map((c) => c.url.pathname)).toEqual(["/api/v1/projects/p9/results"]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ catalog: { action: "unchanged", version: 4 }, spec: { changed: false } });
  });

  it("reports the result even when the catalog refuses, then fails the command with the reason", async () => {
    both({ catalogFail: true });
    await expect(run([...base(), "--spec-file", specFile()])).rejects.toThrow(/The result was reported, but the spec could not be registered in the catalog \(the project is not tied to it\): .*A personal account can hold 3 specs/);
    expect(calls.map((c) => `${c.url.host} ${c.method} ${c.url.pathname}`)).toContain("api.test POST /api/v1/projects/new1/results");
    expect(calls.find((c) => c.method === "POST" && c.url.pathname === "/api/v1/projects")!.body).not.toHaveProperty("spec_id");
  });

  it("passes the name, the group (made when missing) and the organization on to the catalog, and nothing of it to Assurance", async () => {
    both();
    await run([...base(), "--spec-file", specFile(), "--spec-name", "Mine", "--spec-group", "Billing", "--spec-org", "7"]);
    const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/v1/specs")!;
    expect(create.body).toMatchObject({ name: "Mine", group_id: "g-new" });
    expect(calls.filter((c) => c.url.host === "specs.test").every((c) => c.org === "7")).toBe(true);
    expect(calls.filter((c) => c.url.host === "api.test").every((c) => c.org === undefined)).toBe(true); // Assurance has no organization header from the CLI
  });

  it("refuses contradictory or orphaned options before anything is sent", async () => {
    both();
    await expect(run([...base(), "--spec-file", specFile(), "--spec-id", "x"])).rejects.toThrow(/exclusive/);
    await expect(run([...base(), "--spec-name", "N"])).rejects.toThrow(/--spec-name needs --spec-file/);
    await expect(run([...base(), "--spec-group", "G"])).rejects.toThrow(/--spec-group needs --spec-file/);
    await expect(run([...base(), "--spec-org", "7"])).rejects.toThrow(/--spec-org needs --spec-file/);
    await expect(run([...base(), "--spec-environment", "production"])).rejects.toThrow(/needs --spec-id or --spec-file/);
    await expect(run([...base(), "--spec-file", join(dir, "missing.yaml")])).rejects.toThrow(/not found/);
    await expect(run([...base(), "--spec-file", specFile(), "--spec-org", "acme"])).rejects.toThrow(/organization id/);
    expect(calls).toHaveLength(0);
  });

  it("--dry-run reads the file and says what it would register, and calls nothing", async () => {
    both();
    await run([...base(), "--spec-file", specFile(), "--spec-group", "Billing", "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec_file: { name: "Billing API", group: "Billing", content_hash: hashOf(DOC) } });
  });

  it("writes the spec id for the next step of a GitHub Actions job, next to the project id", async () => {
    both();
    const out = join(dir, "gh-output");
    writeFileSync(out, "");
    vi.stubEnv("GITHUB_OUTPUT", out);
    await run([...base(), "--spec-file", specFile()]);
    expect(readFileSync(out, "utf8")).toBe("project_id=new1\nspec_id=spec9\n");
  });
});

import { createHash } from "node:crypto";
const hashOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
