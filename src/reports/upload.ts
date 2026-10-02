/**
 * `nb assurance report upload` - read a test report on the CI runner, reduce it
 * to the normalised summary, and report it to a NASEBANAL Assurance project.
 *
 * The same command runs in a pipeline and on a laptop (nb-quickstarts' `make
 * <tool>:report-upload` calls it): it takes its run key, commit, branch and
 * project from the CI environment when there is one, and authenticates with
 * `NB_TOKEN` (a PAT or service-account token) so no browser is needed.
 *
 * The parsing happens here, not on the server: the server stays small, parsers
 * are testable offline, and what is uploaded is a few hundred bytes of summary
 * instead of a megabyte of report.
 */
import { Command } from "commander";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { request, resolveBaseUrl, ApiError } from "../http.js";
import { loadSpec } from "../spec/loader.js";
import { printJson } from "../output.js";
import { detectCi, type CiInfo } from "./ci.js";
import { parseJunit, type SuiteFailure } from "./junit.js";
import { summariseLocust } from "./locust.js";

export const SUITE_KINDS = ["unit", "e2e", "load", "contract", "security"] as const;
export type SuiteKind = (typeof SUITE_KINDS)[number];
export type ReportFormat = "junit" | "locust";

/**
 * The tools Assurance accepts, per kind of suite. The CLI filters here, on the CI
 * runner, so only reports that match are ever sent; the API enforces the same list
 * (nb-assurance-api `ALLOWED_TOOLS`) because the CLI is not the only possible client.
 * Keep the two in step with the `tool` enum in nb-api-specs' assurance package.
 */
export const ALLOWED_TOOLS: Record<SuiteKind, readonly string[]> = {
  unit: ["vitest", "pytest"],
  e2e: ["playwright"],
  contract: ["specmatic"],
  security: ["zap"],
  load: ["locust"],
};

/** Tools whose report is not JUnit XML. Every other allowed tool writes JUnit. */
const NON_JUNIT_TOOLS: Record<string, ReportFormat> = { locust: "locust" };

/**
 * Check a kind / tool / format combination before anything is parsed or sent.
 * Returns the normalised (lower-case) tool name; throws a message naming what is supported.
 */
export function checkSuite(kind: SuiteKind, tool: string, format: ReportFormat): string {
  const name = tool.trim().toLowerCase();
  if (!ALLOWED_TOOLS[kind].includes(name)) {
    throw new Error(`Tool '${tool}' is not supported for kind '${kind}'. Supported: ${ALLOWED_TOOLS[kind].join(", ")}`);
  }
  const expected = NON_JUNIT_TOOLS[name] ?? "junit";
  if (format !== expected) {
    throw new Error(`Tool '${name}' reports in ${expected} format, but --format is ${format}`);
  }
  return name;
}

const MAX_FAILURES = 20;

export interface SuitePayload {
  kind: SuiteKind;
  tool: string;
  name?: string;
  status: "passed" | "failed";
  tests?: { total: number; passed: number; failed: number; skipped?: number };
  duration_ms?: number;
  metrics?: Record<string, number>;
  failures?: { name: string; message?: string }[];
}

export interface ReportPayload {
  run: { key: string; commit_sha?: string; branch?: string; ci_url?: string };
  suite: SuitePayload;
}

/** What a parsed report contributes to the payload, plus a note for the terminal. */
export interface ParsedReport {
  suite: SuitePayload;
  note: string;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

function toFailures(list: SuiteFailure[]): SuitePayload["failures"] {
  const out = list.slice(0, MAX_FAILURES).map((f) => ({
    name: clip(f.name, 300),
    ...(f.message ? { message: clip(f.message, 500) } : {}),
  }));
  return out.length > 0 ? out : undefined;
}

export interface ParseOptions {
  format: ReportFormat;
  kind: SuiteKind;
  tool: string;
  suiteName?: string;
  /** Forced pass/fail; otherwise derived from the report. */
  status?: "passed" | "failed";
  maxFailRatio: number;
  file: string;
}

/** The sibling file Locust wrote next to `<prefix>_stats.csv`, if there is one. */
function locustSibling(statsFile: string, suffix: string): string | undefined {
  const path = statsFile.replace(/_stats\.csv$/, suffix);
  return path !== statsFile && existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function parseReport(opts: ParseOptions): ParsedReport {
  const text = readFileSync(opts.file, "utf8");
  const base = { kind: opts.kind, tool: opts.tool, ...(opts.suiteName ? { name: opts.suiteName } : {}) };

  if (opts.format === "junit") {
    const j = parseJunit(text);
    const status = opts.status ?? (j.failed === 0 ? "passed" : "failed");
    return {
      note: `${j.total} tests, ${j.failed} failed, ${j.skipped} skipped`,
      suite: {
        ...base,
        status,
        tests: { total: j.total, passed: j.passed, failed: j.failed, skipped: j.skipped },
        ...(j.duration_ms !== null ? { duration_ms: j.duration_ms } : {}),
        ...(toFailures(j.failures) ? { failures: toFailures(j.failures) } : {}),
      },
    };
  }

  const l = summariseLocust(
    {
      stats: text,
      failures: locustSibling(opts.file, "_failures.csv"),
      exceptions: locustSibling(opts.file, "_exceptions.csv"),
      history: locustSibling(opts.file, "_stats_history.csv"),
    },
    opts.maxFailRatio,
  );
  return {
    note: `${l.total} requests, ${l.failed} failed${l.reasons.length ? ` (${l.reasons.join("; ")})` : ""}`,
    suite: {
      ...base,
      status: opts.status ?? l.status,
      tests: { total: l.total, passed: l.passed, failed: l.failed },
      ...(l.duration_ms !== null ? { duration_ms: l.duration_ms } : {}),
      metrics: l.metrics,
      ...(toFailures(l.failures) ? { failures: toFailures(l.failures) } : {}),
    },
  };
}

interface Connection {
  baseUrl: string;
  token: string | undefined;
}

type Envelope<T> = { success: boolean; data: T };

/** Find the project by name, or create it (unless told not to). Returns its id. */
export async function ensureProject(
  conn: Connection,
  name: string,
  repo: string | null,
  create: boolean,
): Promise<{ id: string; created: boolean }> {
  const find = async () => {
    const res = await request({ ...conn, method: "GET", path: "/api/v1/projects", query: { name } });
    const list = (res.data as Envelope<{ data: { id: string }[] }>).data.data;
    return list[0]?.id ?? null;
  };

  const existing = await find();
  if (existing) return { id: existing, created: false };
  if (!create) {
    throw new Error(`No project named '${name}' (create it first, or drop --no-create-project).`);
  }
  try {
    const res = await request({
      ...conn,
      method: "POST",
      path: "/api/v1/projects",
      body: { name, ...(repo ? { repo } : {}) },
    });
    return { id: (res.data as Envelope<{ id: string }>).data.id, created: true };
  } catch (err) {
    // Another job of the same pipeline created it between our lookup and our create.
    if (err instanceof ApiError && err.status === 409) {
      const raced = await find();
      if (raced) return { id: raced, created: false };
    }
    throw err;
  }
}

export interface UploadParams {
  conn: Connection;
  project: string;
  repo: string | null;
  createProject: boolean;
  payload: ReportPayload;
}

export interface UploadResult {
  project_id: string;
  project_created: boolean;
  run_id: string;
  suite_id: string;
  replaced: boolean;
}

export async function uploadReport(p: UploadParams): Promise<UploadResult> {
  const project = await ensureProject(p.conn, p.project, p.repo, p.createProject);
  const res = await request({
    ...p.conn,
    method: "POST",
    path: `/api/v1/projects/${encodeURIComponent(project.id)}/results`,
    body: p.payload,
  });
  const data = (res.data as Envelope<{ run_id: string; suite_id: string; replaced: boolean }>).data;
  return { project_id: project.id, project_created: project.created, ...data };
}

function fail(message: string): never {
  throw new Error(message);
}

/** `--dir`: the newest-looking `*_stats.csv` (Locust writes `<prefix>_stats.csv` per run). */
function statsFileIn(dir: string): string {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith("_stats.csv")) : [];
  if (files.length === 0) fail(`No *_stats.csv file in ${dir}`);
  return join(dir, files.sort()[files.length - 1]);
}

interface UploadOptions {
  file?: string;
  dir?: string;
  format?: string;
  kind?: string;
  tool?: string;
  suite?: string;
  project?: string;
  repo?: string;
  runKey?: string;
  commit?: string;
  branch?: string;
  ciUrl?: string;
  status?: string;
  maxFailRatio?: string;
  createProject: boolean;
  dryRun?: boolean;
  env?: string;
  token?: string;
}

function resolveFormat(opts: UploadOptions, file: string): ReportFormat {
  if (opts.format !== undefined) {
    if (opts.format !== "junit" && opts.format !== "locust") fail("--format must be junit or locust");
    return opts.format;
  }
  if (opts.dir !== undefined || file.endsWith(".csv")) return "locust";
  if (file.endsWith(".xml")) return "junit";
  return fail("Cannot tell the report format from the file name; pass --format junit|locust");
}

export function buildReportUploadCommand(): Command {
  return new Command("upload")
    .description("Report a test result file (JUnit XML or Locust CSV) to an Assurance project")
    .option("--file <path>", "the report file (JUnit XML, or Locust *_stats.csv)")
    .option("--dir <dir>", "a Locust output directory (uses its *_stats.csv)")
    .option("--format <format>", "junit | locust (default: from the file name)")
    .option("--kind <kind>", `what the suite proves: ${SUITE_KINDS.join(" | ")} (locust: load)`)
    .option("--tool <name>", "the producing tool, e.g. vitest, pytest, playwright, specmatic (locust: locust)")
    .option("--suite <name>", "tells apart several suites of one kind in a run (e.g. api, web)")
    .option("--project <name>", "project name (CI: the repository); found, or created if missing")
    .option("--repo <repo>", "repository recorded on a newly created project (CI: detected)")
    .option("--run-key <key>", "identity of the pipeline run (CI: detected); all jobs of a run share it")
    .option("--commit <sha>", "commit SHA (CI: detected)")
    .option("--branch <name>", "branch (CI: detected)")
    .option("--ci-url <url>", "link to the CI run (CI: detected)")
    .option("--status <status>", "passed | failed; default is derived from the report")
    .option("--max-fail-ratio <ratio>", "locust: allowed failure ratio 0..1 (default: $LOCUST_MAX_FAIL_RATIO or 0)")
    .option("--no-create-project", "fail instead of creating the project when it does not exist")
    .option("--dry-run", "print what would be sent and exit without calling the API")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as UploadOptions;

      const file = opts.file ?? (opts.dir !== undefined ? statsFileIn(opts.dir) : fail("Pass --file <path> (or --dir for Locust)"));
      if (!existsSync(file)) fail(`File not found: ${file}`);
      const format = resolveFormat(opts, file);

      const kind = (opts.kind ?? (format === "locust" ? "load" : undefined)) as SuiteKind | undefined;
      if (!kind || !(SUITE_KINDS as readonly string[]).includes(kind)) fail(`--kind is required: ${SUITE_KINDS.join(" | ")}`);
      const tool = opts.tool ?? (format === "locust" ? "locust" : undefined);
      if (!tool) fail("--tool is required for JUnit reports (e.g. --tool pytest)");
      const checkedTool = checkSuite(kind, tool, format);
      if (opts.status !== undefined && opts.status !== "passed" && opts.status !== "failed") fail("--status must be passed or failed");

      const ratioRaw = opts.maxFailRatio ?? process.env.LOCUST_MAX_FAIL_RATIO ?? "0";
      const maxFailRatio = Number(ratioRaw);
      if (!Number.isFinite(maxFailRatio) || maxFailRatio < 0 || maxFailRatio > 1) fail("--max-fail-ratio must be a number between 0 and 1");

      const parsed = parseReport({
        format,
        kind,
        tool: checkedTool,
        suiteName: opts.suite,
        status: opts.status as "passed" | "failed" | undefined,
        maxFailRatio,
        file,
      });

      const ci: CiInfo = detectCi(process.env);
      const runKey = opts.runKey ?? ci.runKey ?? fail("Cannot determine the run key; pass --run-key");
      const project = opts.project ?? ci.project ?? fail("Cannot determine the project name; pass --project <name>");
      const commit = opts.commit ?? ci.commitSha;
      const branch = opts.branch ?? ci.branch;
      const ciUrl = opts.ciUrl ?? ci.ciUrl;

      const payload: ReportPayload = {
        run: {
          key: runKey,
          ...(commit ? { commit_sha: commit } : {}),
          ...(branch ? { branch } : {}),
          ...(ciUrl ? { ci_url: ciUrl } : {}),
        },
        suite: parsed.suite,
      };
      const repo = opts.repo ?? ci.repo;

      if (opts.dryRun) {
        printJson({ project, repo, payload });
        process.stderr.write(`(dry run) ${basename(dirname(file)) || "."}/${basename(file)}: ${parsed.note}\n`);
        return;
      }

      const env = (opts.env as Environment | undefined) || resolveEnv();
      const override = process.env.NB_BASE_URL?.replace(/\/$/, "");
      const baseUrl = override ?? resolveBaseUrl(loadSpec("assurance.yaml").servers, env);
      const token = opts.token || (await resolveAccessToken());

      const result = await uploadReport({
        conn: { baseUrl, token },
        project,
        repo,
        createProject: opts.createProject,
        payload,
      });
      printJson(result);
      process.stderr.write(
        `✓ ${kind}/${checkedTool} ${payload.suite.status}: ${parsed.note} -> project '${project}'` +
          `${result.project_created ? " (created)" : ""}, run '${runKey}'${result.replaced ? " (replaced)" : ""}\n`,
      );
    });
}
