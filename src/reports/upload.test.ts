import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MAX_CASES, buildReportUploadCommand, checkRepoUrl, checkSpecId, specRefOf, checkProvider, checkReportPath, checkSuite, parseMetrics, parseReport, prepareAttachment, toCases } from "./upload.js";

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
  vi.stubEnv("NB_BASE_URL", "");
  vi.stubEnv("NB_ASSURANCE_BASE_URL", "http://api.test");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITLAB_CI", "");
  vi.stubEnv("NB_API_VERSION", "");
  // The id of the spec a pipeline reports to, as its variable carries it; the catalog is another host.
  vi.stubEnv("NB_SPEC_ID", "sp1");
  vi.stubEnv("NB_REPOSITORY_ID", "");
  vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
  vi.stubEnv("NB_SPECS_ORG", "");
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface CatalogRepo { id: string; provider: string; name: string; component?: string }
interface CatalogSpec { id: string; name: string; repository_id: string | null; group_id?: string | null }

/**
 * A fake Assurance API (api.test) and catalog (specs.test). The first argument is ignored (older tests passed a project to
 * find). The catalog holds `repositories` and `specs` (by default one spec, `sp1` "Target API", tied to repository `rp1`):
 * results go to `POST /api/v1/specs/{id}/results` with the repository the spec is tied to in the body.
 */
function stubApi(
  _unused?: unknown,
  opts: { resultsStatus?: number; resultsError?: { code: string; message: string }; attachmentStatus?: number; repositories?: CatalogRepo[]; specs?: CatalogSpec[]; groups?: { id: string; name: string }[] } = {},
) {
  const repositories = opts.repositories ?? [{ id: "rp1", provider: "github", name: "nasebanal/nb-target-api", component: "" }];
  const specs = opts.specs ?? [{ id: "sp1", name: "Target API", repository_id: "rp1" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      const isAttach = url.pathname.endsWith("/attachment");
      const body = init.body && !isAttach ? JSON.parse(String(init.body)) : undefined;
      const headers = init.headers as Record<string, string>;
      calls.push({
        method: String(init.method),
        url,
        body,
        org: headers["X-Active-Organization-Id"],
        ...(isAttach ? { bytes: init.body as Uint8Array, contentType: headers["Content-Type"] } : {}),
      });
      const json = (status: number, data: unknown) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url.host === "specs.test") {
        const path = url.pathname;
        if (path === "/api/v1/repositories") return json(200, { success: true, data: { data: repositories, total: repositories.length, limit: 100 } });
        if (path === "/api/v1/specs") return json(200, { success: true, data: { data: specs, total: specs.length, limit: 100 } });
        if (path === "/api/v1/groups") return json(200, { success: true, data: { data: opts.groups ?? [], total: 0, limit: 10 } });
        const one = /^\/api\/v1\/(specs|repositories)\/([^/]+)$/.exec(path);
        const row = one ? (one[1] === "specs" ? specs : repositories).find((x) => x.id === one[2]) : undefined;
        return row ? json(200, { success: true, data: row }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "not found" } });
      }
      if (isAttach) {
        if (opts.attachmentStatus && opts.attachmentStatus >= 400) {
          return json(opts.attachmentStatus, { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "An attachment can be at most 20971520 bytes" } });
        }
        return json(201, { success: true, data: { suite_id: "suite1", name: "x", size_bytes: 1 } });
      }
      if (opts.resultsStatus && opts.resultsStatus >= 400) {
        return json(opts.resultsStatus, { success: false, error: opts.resultsError ?? { code: "NOT_FOUND", message: "Spec not found" } });
      }
      return json(201, { success: true, data: { run_id: "run1", suite_id: "suite1", replaced: false } });
    }),
  );
}

async function run(args: string[]) {
  const program = new Command().exitOverride().option("--env <env>").option("--token <token>");
  // A usage error must throw (not exit the process) in every command of the tree.
  const assurance = program.command("assurance").exitOverride();
  assurance.command("report").exitOverride().addCommand(buildReportUploadCommand().exitOverride());
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
  it("reports the result to the spec whose id the pipeline carries, with the repository it is tied to and the CI details", async () => {
    stubApi();
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "nasebanal/nb-target-api");
    vi.stubEnv("GITHUB_RUN_ID", "555");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1"); // set by Actions itself (2 on a re-run); pin it so the key is stable
    vi.stubEnv("GITHUB_SHA", "abc123");
    vi.stubEnv("GITHUB_REF_NAME", "main");
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest"]);

    // The catalog is read (the spec, then the repository it is tied to), nothing is created, and the result goes to the spec.
    expect(calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual(["GET specs.test/api/v1/specs/sp1", "GET specs.test/api/v1/repositories/rp1", "POST api.test/api/v1/specs/sp1/results"]);
    expect(calls[2].body.repository_id).toBe("rp1");
    expect(calls[2].body.run).toEqual({
      key: "555-1",
      commit_sha: "abc123",
      branch: "main",
      ci_url: "https://github.com/nasebanal/nb-target-api/actions/runs/555",
      provider: "github",
      repo_url: "https://github.com/nasebanal/nb-target-api",
    });
    expect(calls[2].body.suite).toMatchObject({ kind: "unit", tool: "vitest", status: "failed", tests: { total: 2, passed: 1, failed: 1, skipped: 0 }, duration_ms: 1500 });
    expect(JSON.parse(stdout.join(""))).toEqual({ spec_id: "sp1", repository_id: "rp1", run_id: "run1", suite_id: "suite1", replaced: false });
    expect(process.exitCode).toBeUndefined();
  });

  it("sends the bearer token", async () => {
    stubApi();
    await run(["--file", junitFile(), "--kind", "e2e", "--tool", "playwright", "--run-key", "k1"]);
    const headers = (fetch as unknown as { mock: { calls: [URL, RequestInit][] } }).mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tkn");
  });

  it("uploads a Locust directory as a load suite, with the allowed failure ratio from the environment", async () => {
    stubApi({ id: "p1" });
    writeFileSync(join(dir, "locust_stats.csv"), LOCUST_STATS.replace(",200,0,", ",200,4,"));
    vi.stubEnv("LOCUST_MAX_FAIL_RATIO", "0.05");
    await run(["--dir", dir, "--spec-id", "sp1", "--run-key", "k"]);
    expect(calls.at(-1)!.body.suite).toMatchObject({ kind: "load", tool: "locust", status: "passed", tests: { total: 200, passed: 196, failed: 4 } });
  });

  it("--dry-run prints the payload and calls nothing", async () => {
    stubApi(null);
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--spec-id", "sp1", "--run-key", "k", "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join("")).payload.run.key).toBe("k");
  });

  it("--coverage-report adds the Specmatic API coverage as the coverage_pct metric, and only for specmatic", async () => {
    stubApi(null);
    const cov = join(dir, "report.json");
    writeFileSync(cov, JSON.stringify({ results: { summary: { extra: { executionDetails: [{ coverageMetrics: { coveredOperations: 19, totalOperationsWithFilters: 21 } }] } } } }));
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run"];
    await run([...base, "--file", junitFile(), "--kind", "contract", "--tool", "specmatic", "--coverage-report", cov]);
    expect(JSON.parse(stdout.join("")).payload.suite.metrics).toEqual({ coverage_pct: 90.5 });
    expect(stderr.join("")).toContain("API coverage 90.5% (19/21 operations)");
    await expect(run([...base, "--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--coverage-report", cov])).rejects.toThrow(/only for --kind contract --tool specmatic/);
    await expect(run([...base, "--file", junitFile(), "--kind", "contract", "--tool", "specmatic", "--coverage-report", join(dir, "nope.json")])).rejects.toThrow(/File not found/);
  });

  it("a result has no API version of its own: nothing api_version is sent, and the retired NB_API_VERSION is ignored with a warning", async () => {
    stubApi(null);
    const args = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "contract", "--tool", "specmatic", "--file", junitFile()];
    await run(args);
    expect(JSON.parse(stdout.join("")).payload.suite).not.toHaveProperty("api_version");
    expect(stderr.join("")).not.toContain("NB_API_VERSION");
    stdout.length = 0;
    vi.stubEnv("NB_API_VERSION", "v3");
    await run(args);
    expect(JSON.parse(stdout.join("")).payload.suite).not.toHaveProperty("api_version");
    expect(stderr.join("")).toMatch(/NB_API_VERSION is retired and ignored/);
  });

  it("--label tells apart two scans of one tool: sent trimmed, left out when not given, refused when empty or too long", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "security", "--tool", "zap", "--file", junitFile()];
    await run([...base, "--label", " full-scan "]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ label: "full-scan" });
    stdout.length = 0;
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.label).toBeUndefined();
    await expect(run([...base, "--label", "  "])).rejects.toThrow(/must not be empty/);
    await expect(run([...base, "--label", "x".repeat(101)])).rejects.toThrow(/100 characters or fewer/);
  });

  it("--tool-version records the version of the tool: sent trimmed, left out when not given, refused when empty or too long", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "unit", "--tool", "pytest", "--file", junitFile()];
    await run([...base, "--tool-version", " 9.1.0 "]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ tool: "pytest", tool_version: "9.1.0" });
    stdout.length = 0;
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.tool_version).toBeUndefined();
    await expect(run([...base, "--tool-version", " "])).rejects.toThrow(/must not be empty/);
    await expect(run([...base, "--tool-version", "x".repeat(51)])).rejects.toThrow(/50 characters or fewer/);
  });

  it("--spec-hash records the contract the result was produced against: sent as spec_hash (lower-cased), left out when not given, refused unless 64 hex characters", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "contract", "--tool", "specmatic", "--file", junitFile()];
    const hash = "f2c098a7c93707864edb109c0839bdfe6f34d002c0322fe11bfc400fb4a782ff";
    await run([...base, "--spec-hash", ` ${hash.toUpperCase()} `]);
    expect(JSON.parse(stdout.join("")).payload.suite).toMatchObject({ tool: "specmatic", spec_hash: hash });
    stdout.length = 0;
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.spec_hash).toBeUndefined();
    await expect(run([...base, "--spec-hash", hash.slice(1)])).rejects.toThrow(/64 characters/);
    await expect(run([...base, "--spec-hash", `${hash.slice(1)}g`])).rejects.toThrow(/64 characters/);
    await expect(run([...base, "--spec-hash", " "])).rejects.toThrow(/64 characters/);
  });

  it("--contract-file sends the SHA-256 of the document, the one the catalog keeps as content_hash; it is exclusive with --spec-hash", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "contract", "--tool", "specmatic", "--file", junitFile()];
    const contract = join(dir, "spec.yaml");
    const text = "openapi: 3.0.3\ninfo:\n  title: Demo\n  version: 1.0.0\npaths: {}\n";
    writeFileSync(contract, text);
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    await run([...base, "--contract-file", contract]);
    expect(JSON.parse(stdout.join("")).payload.suite.spec_hash).toBe(expected);
    await expect(run([...base, "--contract-file", join(dir, "nope.yaml")])).rejects.toThrow(/--contract-file: not found/);
    await expect(run([...base, "--contract-file", contract, "--spec-hash", expected])).rejects.toThrow(/exclusive/);
  });

  it("a result no longer has components of its own: the component is part of the repository's key (--component is that)", async () => {
    stubApi(null);
    const flags = buildReportUploadCommand().options.map((o) => o.long);
    expect(flags).toContain("--component");
    expect(flags).not.toContain("--suite");
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "unit", "--tool", "vitest", "--file", junitFile()];
    await run(base);
    expect(JSON.parse(stdout.join("")).payload.suite.components).toBeUndefined();
  });

  it("--metric adds numbers to the suite, on top of what the report gave, and several can be repeated", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k", "--dry-run", "--kind", "security", "--tool", "zap", "--file", junitFile()];
    await run([...base, "--metric", "high=0", "--metric", "medium=3", "--metric", "low=2"]);
    expect(JSON.parse(stdout.join("")).payload.suite.metrics).toEqual({ high: 0, medium: 3, low: 2 });
    expect(stderr.join("")).toContain("metrics high=0 medium=3 low=2");
    stdout.length = 0;
    await run([...base]);
    expect(JSON.parse(stdout.join("")).payload.suite.metrics).toBeUndefined();
  });

  it("refuses a malformed --metric before anything is sent", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k", "--kind", "security", "--tool", "zap", "--file", junitFile()];
    for (const bad of ["high", "high=", "High=1", "high=abc", "1high=2", "=3"]) {
      await expect(run([...base, "--metric", bad])).rejects.toThrow(/--metric/);
    }
    expect(calls).toHaveLength(0);
    expect(parseMetrics(["a_b=1.5", "c=-2"])).toEqual({ a_b: 1.5, c: -2 });
    expect(() => parseMetrics(Array.from({ length: 21 }, (_, i) => `k${i}=1`))).toThrow(/At most 20/);
  });

  it("--api-version is part of the spec's key (not a result label): a bad one is refused before anything is sent, and it cannot be combined with --spec-id", async () => {
    stubApi(null);
    await expect(run(["--repository", "acme/api", "--spec", "Account API", "--api-version", "v 1", "--run-key", "k", "--file", junitFile(), "--kind", "unit", "--tool", "vitest"])).rejects.toThrow(/--api-version 'v 1' must be a version label/);
    await expect(run(["--spec-id", "sp1", "--api-version", "v1", "--run-key", "k", "--file", junitFile(), "--kind", "unit", "--tool", "vitest"])).rejects.toThrow(/do not combine/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("explains missing or invalid inputs", async () => {
    stubApi(null);
    const base = ["--spec-id", "sp1", "--run-key", "k"];
    await expect(run([...base])).rejects.toThrow(/--file/);
    await expect(run([...base, "--file", join(dir, "nope.xml"), "--kind", "unit", "--tool", "x"])).rejects.toThrow(/File not found/);
    await expect(run([...base, "--file", junitFile(), "--tool", "x"])).rejects.toThrow(/--kind is required/);
    await expect(run([...base, "--file", junitFile(), "--kind", "unit"])).rejects.toThrow(/--tool is required/);
    await expect(run([...base, "--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--status", "ok"])).rejects.toThrow(/--status/);
    vi.stubEnv("NB_SPEC_ID", "");
    await expect(run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k"])).rejects.toThrow(/Say which spec/);
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
    await expect(run(["--file", junitFile(), "--kind", "unit", "--tool", "not a label", "--spec-id", "sp1", "--run-key", "k"])).rejects.toThrow(/not a label/);
    expect(calls).toHaveLength(0);
  });

  it("sends a tool the platform has never heard of, with its cases", async () => {
    stubApi(null);
    await run(["--file", junitFile(), "--kind", "security", "--tool", "trivy", "--spec-id", "sp1", "--run-key", "k", "--dry-run"]);
    const suite = JSON.parse(stdout.join("")).payload.suite;
    expect(suite).toMatchObject({ kind: "security", tool: "trivy" });
    expect(suite.cases).toHaveLength(2);
  });
});

describe("the spec to report to", () => {
  const base = () => ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k"];

  it("--spec-id reads the spec and its repository from the catalog and posts to the spec, naming both in the result", async () => {
    stubApi();
    await run([...base(), "--spec-id", "sp1"]);
    expect(calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual(["GET specs.test/api/v1/specs/sp1", "GET specs.test/api/v1/repositories/rp1", "POST api.test/api/v1/specs/sp1/results"]);
    expect(calls[2].body.repository_id).toBe("rp1");
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec_id: "sp1", repository_id: "rp1" });
    expect(stderr.join("")).toContain("spec Target API (github nasebanal/nb-target-api), id sp1");
  });

  it("reads NB_SPEC_ID, and the flag wins over it", async () => {
    stubApi({}, { specs: [{ id: "envspec", name: "E", repository_id: "rp1" }, { id: "flagspec", name: "F", repository_id: "rp1" }] });
    vi.stubEnv("NB_SPEC_ID", "envspec");
    await run(base());
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/envspec/results");
    calls.length = 0;
    await run([...base(), "--spec-id", "flagspec"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/flagspec/results");
  });

  it("by names: --repository, an optional --component and --spec are checked against each other and resolve to the spec", async () => {
    stubApi(null, {
      repositories: [
        { id: "r-whole", provider: "github", name: "Acme/Billing", component: "" },
        { id: "r-web", provider: "github", name: "Acme/Billing", component: "web" },
      ],
      specs: [{ id: "s-api", name: "Billing API", repository_id: "r-whole" }, { id: "s-web", name: "Billing Web", repository_id: "r-web" }],
    });
    await run([...base(), "--repository", "acme/billing", "--spec", "billing api"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/s-api/results");
    expect(calls.at(-1)!.body.repository_id).toBe("r-whole");
    calls.length = 0;
    await run([...base(), "--repository", "acme/billing", "--component", "web", "--spec", "Billing Web"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/s-web/results");
    expect(calls.at(-1)!.body.repository_id).toBe("r-web");
    // nothing is registered by a report
    expect(calls.every((c) => c.method === "GET" || c.url.pathname.endsWith("/results"))).toBe(true);
    // the spec belongs to another row: an error naming both
    await expect(run([...base(), "--repository", "acme/billing", "--component", "web", "--spec", "Billing API"])).rejects.toThrow(/No spec named 'Billing API' in no group \/ github Acme\/Billing \/ web.*exists in:/s);
  });

  it("a names ask wins over the id the variable carries, and a spec with no repository is refused", async () => {
    stubApi(null, { repositories: [{ id: "r1", provider: "github", name: "acme/api", component: "" }], specs: [{ id: "s1", name: "Api", repository_id: "r1" }, { id: "s2", name: "Loose", repository_id: null }] });
    vi.stubEnv("NB_SPEC_ID", "sp-other");
    await run([...base(), "--repository", "acme/api", "--spec", "Api"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/s1/results");
    calls.length = 0;
    await expect(run([...base(), "--spec-id", "s2"])).rejects.toThrow(/tied to no repository/);
    expect(calls.some((c) => c.url.host === "api.test")).toBe(false);
  });

  it("refuses to run with neither, saying how, before anything is sent; the retired NB_REPOSITORY_ID gets its own message", async () => {
    stubApi();
    vi.stubEnv("NB_SPEC_ID", "");
    await expect(run(base())).rejects.toThrow(/Say which spec/);
    vi.stubEnv("NB_REPOSITORY_ID", "oldrepo");
    await expect(run(base())).rejects.toThrow(/NB_REPOSITORY_ID is retired.*NB_SPEC_ID/);
    // with the new target given, the old variable is just ignored
    await run([...base(), "--spec-id", "sp1"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/sp1/results");
  });

  it("refuses an id and names together, half the names, a provider without a name and an id that cannot be one, before anything is sent", async () => {
    stubApi();
    await expect(run([...base(), "--spec-id", "a1", "--repository", "a/b", "--spec", "x"])).rejects.toThrow(/do not combine/);
    await expect(run([...base(), "--repository", "a/b"])).rejects.toThrow(/--spec is required/);
    await expect(run([...base(), "--spec", "x"])).rejects.toThrow(/--repository is required/);
    await expect(run([...base(), "--repository-provider", "gitlab"])).rejects.toThrow(/needs --repository/);
    await expect(run([...base(), "--spec-id", "../x"])).rejects.toThrow(/not a spec id/);
    await expect(run([...base(), "--repository", "a/b", "--spec", "x", "--repository-provider", "svn"])).rejects.toThrow(/provider/);
    await expect(run([...base(), "--repository-id", "rp1"])).rejects.toThrow(/--repository-id is retired/);
    expect(calls).toHaveLength(0);
  });

  it("an id the catalog does not have is an error naming the id; Assurance's 404 and 422 are explained, other errors pass on", async () => {
    stubApi();
    await expect(run([...base(), "--spec-id", "nope"])).rejects.toThrow(/No spec with id 'nope'/);
    stubApi(null, { resultsStatus: 404 });
    await expect(run([...base(), "--spec-id", "sp1"])).rejects.toThrow(/No spec with id 'sp1'/);
    stubApi(null, { resultsStatus: 422, resultsError: { code: "REPOSITORY_MISMATCH", message: "the spec is tied to another repository" } });
    await expect(run([...base(), "--spec-id", "sp1"])).rejects.toThrow(/refused the result \(REPOSITORY_MISMATCH\)/);
    stubApi(null, { resultsStatus: 400 });
    await expect(run([...base(), "--spec-id", "sp1"])).rejects.not.toThrow(/No spec with id/);
  });

  it("--dry-run by id calls nothing; by names it only reads the catalog and shows the spec and the repository", async () => {
    stubApi();
    await run([...base(), "--spec-id", "sp1", "--dry-run"]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ spec_id: "sp1" });
    stdout.length = 0;
    await run([...base(), "--repository", "nasebanal/nb-target-api", "--spec", "Target API", "--dry-run"]);
    const shown = JSON.parse(stdout.join(""));
    expect(shown.spec).toEqual({ id: "sp1", name: "Target API" });
    expect(shown.repository.id).toBe("rp1");
    expect(shown.payload.repository_id).toBe("rp1");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("--org goes to the catalog and to Assurance as the active organization; `personal` is not sent to Assurance", async () => {
    stubApi();
    await run([...base(), "--org", "7"]);
    expect(calls.map((c) => c.org)).toEqual(["7", "7", "7"]);
    calls.length = 0;
    await run([...base(), "--org", "personal"]);
    expect(calls.at(-1)!.org).toBeUndefined();
    await expect(run([...base(), "--org", "acme"])).rejects.toThrow(/organization id/);
  });

  it("writes spec_id and repository_id to GITHUB_OUTPUT when Actions provides one, and does not fail when it cannot", async () => {
    stubApi();
    const out = join(dir, "gh-output");
    writeFileSync(out, "");
    vi.stubEnv("GITHUB_OUTPUT", out);
    await run([...base(), "--spec-id", "sp1"]);
    expect(readFileSync(out, "utf8")).toBe("spec_id=sp1\nrepository_id=rp1\n");
    vi.stubEnv("GITHUB_OUTPUT", join(dir, "no-such-dir", "out"));
    await run([...base(), "--spec-id", "sp1"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/sp1/results");
  });

  it("the old project options are gone", async () => {
    stubApi();
    for (const flag of [["--project", "demo"], ["--project-id", "p1"], ["--spec-file", "x.yaml"], ["--repo", "a/b"], ["--no-create-project"], ["--no-create"]]) {
      await expect(run([...base(), ...flag])).rejects.toThrow(/unknown option/);
    }
    expect(calls).toHaveLength(0);
  });

  it("checkSpecId trims, treats empty as none, and refuses what is not an id; specRefOf is the one place that decides", () => {
    expect(checkSpecId(" abc123 ")).toBe("abc123");
    expect(checkSpecId("")).toBeUndefined();
    expect(checkSpecId(undefined)).toBeUndefined();
    expect(() => checkSpecId("a b")).toThrow();
    expect(() => checkSpecId("a/b")).toThrow();
    expect(() => checkSpecId("x".repeat(65))).toThrow();
    expect(specRefOf({}, { NB_SPEC_ID: "e1" })).toEqual({ specId: "e1" });
    expect(specRefOf({ specId: "f1" }, { NB_SPEC_ID: "e1" })).toEqual({ specId: "f1" });
    expect(specRefOf({ repository: "a/b", spec: "S" }, { NB_SPEC_ID: "e1" })).toMatchObject({ repository: "a/b", spec: "S" });
  });
});

describe("environments: the group is part of the spec's key, and --all-specs", () => {
  const repo = { id: "rp1", provider: "github", name: "acme/api", component: "" };
  const groups = [{ id: "g-prod", name: "Production" }, { id: "g-stg", name: "Staging" }];
  const specs = [
    { id: "s-prod", name: "Account API", repository_id: "rp1", group_id: "g-prod" },
    { id: "s-stg", name: "Account API", repository_id: "rp1", group_id: "g-stg" },
  ];
  const base = () => ["--file", junitFile(), "--kind", "contract", "--tool", "specmatic", "--run-key", "k"];

  it("--group picks the spec of that environment; without it a name that exists only in groups is an error that lists them", async () => {
    stubApi(null, { repositories: [repo], specs, groups });
    await run([...base(), "--repository", "acme/api", "--group", "Staging", "--spec", "Account API"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/s-stg/results");
    await expect(run([...base(), "--repository", "acme/api", "--spec", "Account API"])).rejects.toThrow(/No spec named 'Account API' in no group.*group 'Production'.*group 'Staging'.*--group/s);
    await expect(run([...base(), "--spec-id", "s-prod", "--group", "Production"])).rejects.toThrow(/do not combine/);
  });

  it("--all-specs sends a source-level result to every spec of the repository, one line each", async () => {
    stubApi(null, { repositories: [repo], specs, groups });
    await run(["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k", "--repository", "acme/api", "--all-specs"]);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.pathname)).toEqual(["/api/v1/specs/s-prod/results", "/api/v1/specs/s-stg/results"]);
    expect(calls.filter((c) => c.method === "POST").every((c) => c.body.repository_id === "rp1")).toBe(true);
    expect(JSON.parse(stdout.join("")).results).toHaveLength(2);
    expect(stderr.join("").match(/-> spec /g)).toHaveLength(2);
  });

  it("--all-specs is refused for a result that is about one deployed environment, and combined with a spec", async () => {
    stubApi(null, { repositories: [repo], specs, groups });
    await expect(run([...base(), "--repository", "acme/api", "--all-specs"])).rejects.toThrow(/--all-specs is for results that belong to the source.*--kind contract/s);
    const unit = ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k"];
    await expect(run([...unit, "--all-specs"])).rejects.toThrow(/needs --repository/);
    await expect(run([...unit, "--repository", "acme/api", "--all-specs", "--spec", "Account API"])).rejects.toThrow(/do not combine/);
    expect(calls).toHaveLength(0);
  });

  it("--all-specs --dry-run lists the specs it would send to and writes nothing", async () => {
    stubApi(null, { repositories: [repo], specs, groups });
    await run(["--file", junitFile(), "--kind", "security", "--tool", "trivy", "--run-key", "k", "--repository", "acme/api", "--all-specs", "--dry-run"]);
    expect(JSON.parse(stdout.join("")).specs.map((x: { id: string }) => x.id)).toEqual(["s-prod", "s-stg"]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("API versions: one spec per API version, --api-version is part of the key", () => {
  const repo = { id: "rp1", provider: "github", name: "acme/api", component: "" };
  const groups = [{ id: "g-prod", name: "Production" }, { id: "g-stg", name: "Staging" }];
  const specs = [
    { id: "s-v1-prod", name: "Account API", repository_id: "rp1", group_id: "g-prod", api_version: "v1" },
    { id: "s-v2-prod", name: "Account API", repository_id: "rp1", group_id: "g-prod", api_version: "v2" },
    { id: "s-v1-stg", name: "Account API", repository_id: "rp1", group_id: "g-stg", api_version: "v1" },
  ];
  const base = () => ["--file", junitFile(), "--kind", "contract", "--tool", "specmatic", "--run-key", "k", "--repository", "acme/api", "--spec", "Account API"];

  it("--api-version picks the spec of that API version; left out, a name that exists at several is an error that lists them", async () => {
    stubApi(null, { repositories: [repo], specs, groups });
    await run([...base(), "--group", "Production", "--api-version", "v2"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/s-v2-prod/results");
    await expect(run([...base(), "--group", "Production"])).rejects.toThrow(/more than one API version.*v1, v2.*--api-version/s);
    // one API version only in that group: it is the one
    calls.length = 0;
    await run([...base(), "--group", "Staging"]);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/specs/s-v1-stg/results");
  });

  it("--all-specs feeds one API version only: a release branch does not feed the other; several versions need --api-version", async () => {
    stubApi(null, { repositories: [repo], specs, groups });
    const unit = ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--run-key", "k", "--repository", "acme/api", "--all-specs"];
    await expect(run(unit)).rejects.toThrow(/several API versions \(v1, v2\).*--api-version/s);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await run([...unit, "--api-version", "v1"]);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.pathname)).toEqual(["/api/v1/specs/s-v1-prod/results", "/api/v1/specs/s-v1-stg/results"]);
    await expect(run([...unit, "--api-version", "v3"])).rejects.toThrow(/No spec of github acme\/api is at API version 'v3'.*v1, v2/s);
  });
});

describe("the link to the report in the repository", () => {
  const base = () => ["--file", junitFile(), "--kind", "unit", "--tool", "vitest", "--spec-id", "sp1", "--run-key", "k"];

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
    expect(calls.find((c) => c.url.pathname.endsWith("/results"))!.body.run.provider).toBe("gitlab");
  });

  it("--repo-url is sent as given (without a trailing slash), and refused when it is not a plain http(s) address", async () => {
    stubApi({ id: "p1" });
    await run([...base(), "--repo-url", "https://gitlab.example.com/group/app/"]);
    expect(calls.find((c) => c.url.pathname.endsWith("/results"))!.body.run.repo_url).toBe("https://gitlab.example.com/group/app");
    for (const bad of ["javascript:alert(1)", "not a url", "https://u:p@h/a", "https://h/a?x=1", "https://h/a#f"]) expect(() => checkRepoUrl(bad)).toThrow(/--repo-url/);
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
    await run(["--file", join(dir, "reports", "junit.xml"), "--kind", "unit", "--tool", "vitest", "--spec-id", "sp1", "--run-key", "k", "--commit", sha]);
    expect(calls.at(-1)!.body.suite.report_path).toBe("reports/junit.xml");

    // the same file, edited after the commit: the link would not show what was reported
    calls = [];
    writeFileSync(join(dir, "reports", "junit.xml"), JUNIT + " ");
    await run(["--file", join(dir, "reports", "junit.xml"), "--kind", "unit", "--tool", "vitest", "--spec-id", "sp1", "--run-key", "k", "--commit", sha]);
    expect(calls.at(-1)!.body.suite).not.toHaveProperty("report_path");
  });
});

describe("--attach: keeping the tool's own report with the result", () => {
  const base = () => ["--file", junitFile(), "--kind", "e2e", "--tool", "playwright", "--spec-id", "sp1", "--run-key", "k"];

  it("sends a file as it is, after the result, to the suite that result made", async () => {
    stubApi({ id: "p9" });
    const report = join(dir, "report.html");
    writeFileSync(report, "<html>the report</html>");
    await run([...base(), "--attach", report]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /api/v1/specs/sp1",
      "GET /api/v1/repositories/rp1",
      "POST /api/v1/specs/sp1/results",
      "PUT /api/v1/specs/sp1/runs/run1/suites/suite1/attachment?name=report.html",
    ]);
    const put = calls.at(-1)!;
    expect(Buffer.from(put.bytes!).toString()).toBe("<html>the report</html>");
    expect(put.contentType).toBe("application/octet-stream");
    expect(JSON.parse(stdout.join(""))).toMatchObject({ repository_id: "rp1", attachment: { name: "report.html", size_bytes: 23 } });
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
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toContain("POST /api/v1/specs/sp1/results");
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
