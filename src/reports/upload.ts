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
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { request, resolveBaseUrl, ApiError } from "../http.js";
import { loadSpec } from "../spec/loader.js";
import { exportGithubOutput, printJson } from "../output.js";
import { detectCi, readReportPath, type CiInfo } from "./ci.js";
import { parseJunit, type JunitCase, type SuiteFailure } from "./junit.js";
import { summariseLocust } from "./locust.js";
import { parseSpecmaticCoverage } from "./specmatic.js";
import { MAX_ATTACHMENT_BYTES, zipDirectory } from "./zip.js";
import { checkOrg, ciNote, pushSpec, readSpecFile, specNameFor, hashText, specsBaseUrl, type PushResult } from "../specs/push.js";

export const SUITE_KINDS = ["unit", "e2e", "load", "contract", "security"] as const;
export type SuiteKind = (typeof SUITE_KINDS)[number];
export type ReportFormat = "junit" | "locust";
export const RUN_PROVIDERS = ["github", "gitlab", "other"] as const;
export type RunProvider = (typeof RUN_PROVIDERS)[number];

/** What the API's ids look like (12 letters and digits); anything else is a typo, not a project. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A spec's id in the API catalog (nb-specs-api): letters, digits, `_` and `-`, up to 64. */
const SPEC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SPEC_ENVIRONMENT = 40;

/** `--spec-id`: trimmed; it is never looked up here (the catalog is another service; a typo shows as "no spec" in the project). */
export function checkSpecId(raw: string): string {
  const v = raw.trim();
  if (!SPEC_ID_PATTERN.test(v)) throw new Error(`--spec-id '${raw}' is not a catalog spec id (letters, digits, '-' and '_', up to 64)`);
  return v;
}

/** `--spec-environment`: which environment of the API the project covers (production, staging, ...). */
export function checkSpecEnvironment(raw: string): string {
  const v = raw.trim();
  if (v === "" || v.length > MAX_SPEC_ENVIRONMENT) throw new Error(`--spec-environment must be 1 to ${MAX_SPEC_ENVIRONMENT} characters`);
  return v;
}

/** `--project-id` / `NB_ASSURANCE_PROJECT_ID`: trimmed; empty is none. */
export function checkProjectId(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!PROJECT_ID_PATTERN.test(v)) throw new Error(`--project-id '${raw}' is not a project id (letters, digits, '-' and '_'): copy it from the project's page or from a previous upload's output`);
  return v;
}

export function checkProvider(raw: string): RunProvider {
  const v = raw.trim().toLowerCase();
  if (!(RUN_PROVIDERS as readonly string[]).includes(v)) throw new Error(`--provider must be one of ${RUN_PROVIDERS.join(" | ")}`);
  return v as RunProvider;
}

/** `--repo-url`: an http(s) address without credentials, query or fragment, as the API accepts it. */
export function checkRepoUrl(v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("--repo-url must be an http(s) address, e.g. https://gitlab.example.com/group/app");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) {
    throw new Error("--repo-url must be an http(s) address without credentials, query or fragment");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** `--report-path`: a path relative to the repository root, as the API accepts it. */
export function checkReportPath(raw: string): string {
  const v = raw.trim();
  if (v === "" || v.length > 512 || v.startsWith("/") || v.includes("\\") || v.split("/").some((s) => s === ".." || s === "")) {
    throw new Error("--report-path must be a path relative to the repository root, e.g. reports/junit.xml");
  }
  return v;
}

/**
 * The tool is a label (nb-assurance-api `TOOL_PATTERN`): what a result means is carried by its kind and its
 * numbers, so any scanner or runner can be reported without a change here, as long as its report is
 * JUnit XML (or the numbers are given with --metric). Only the formats this CLI can read matter.
 */
const TOOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,49}$/;

/** Tools whose report is not JUnit XML; every other tool is read as JUnit. */
const NON_JUNIT_TOOLS: Record<string, ReportFormat> = { locust: "locust" };

/**
 * Check a kind / tool / format combination before anything is parsed or sent.
 * Returns the normalised (lower-case) tool label; throws a message naming what is wrong.
 */
export function checkSuite(kind: SuiteKind, tool: string, format: ReportFormat): string {
  const name = tool.trim().toLowerCase();
  if (!TOOL_PATTERN.test(name)) {
    throw new Error(`Tool '${tool}' is not a label: use lower-case letters, digits, '.', '_' and '-' (up to 50), e.g. vitest or trivy`);
  }
  const expected = NON_JUNIT_TOOLS[name] ?? "junit";
  if (format !== expected) {
    throw new Error(`Tool '${name}' reports in ${expected} format, but --format is ${format}`);
  }
  if (kind === "load" && name !== "locust" && format !== "junit") throw new Error("Only locust reports are read as CSV");
  return name;
}

/** The same label rule as the API (`utils/apiVersion.ts` in nb-assurance-api): checked here so a typo fails before anything is sent. */
const API_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const METRIC_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_METRICS = 20;

/** `--metric high=0 --metric medium=3`: extra numbers for the suite (the API keeps at most 20). */
export function parseMetrics(pairs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq).trim();
    const raw = eq < 0 ? "" : pair.slice(eq + 1).trim();
    const value = Number(raw);
    if (!METRIC_KEY.test(key) || raw === "" || !Number.isFinite(value)) {
      throw new Error(`--metric '${pair}' must be <key>=<number> with a snake_case key (e.g. high=0)`);
    }
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_METRICS) throw new Error(`At most ${MAX_METRICS} --metric values per suite`);
  return out;
}

export function checkApiVersion(label: string): string {
  const v = label.trim();
  if (!API_VERSION_PATTERN.test(v)) {
    throw new Error(`--api-version / NB_API_VERSION '${label}' is not a version label: use letters, digits, '.', '_' and '-' (up to 32), e.g. v1 or 2026-10`);
  }
  return v;
}

const MAX_FAILURES = 20;
/** Per-test cases: the API accepts this many (MAX_CASES), each message up to 2000 characters. */
export const MAX_CASES = 5000;
const MAX_CASE_MESSAGE = 2000;
/** Total failure text sent across all cases, so a suite where everything fails stays a modest upload. */
const MAX_CASE_MESSAGE_BUDGET = 1_000_000;

export interface SuitePayload {
  kind: SuiteKind;
  tool: string;
  /** The components the result is for (names; new ones are created in the project); absent = the component `default`. */
  components?: string[];
  /** Tells apart results that are otherwise the same (two scans of one tool); absent = none. */
  label?: string;
  /** The version of the tool that produced the report; informational. */
  tool_version?: string;
  /** The report file's path in the repository, relative to its root; only for a committed file. */
  report_path?: string;
  status: "passed" | "failed";
  tests?: { total: number; passed: number; failed: number; skipped?: number };
  duration_ms?: number;
  metrics?: Record<string, number>;
  /** The API version this result is for (v1, v2); absent = every version. */
  api_version?: string;
  failures?: { name: string; message?: string }[];
  cases?: { name: string; status: "passed" | "failed" | "skipped"; duration_ms?: number; message?: string }[];
}

export interface ReportPayload {
  run: { key: string; commit_sha?: string; branch?: string; ci_url?: string; provider?: RunProvider; repo_url?: string };
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

/**
 * The per-test cases to send. Over the limit, failed and skipped tests are kept first (they are
 * what people open the list for) and passed ones fill the rest, all in their original order.
 * Failure text is clipped per case and against a total budget; names and outcomes always stay.
 */
export function toCases(list: JunitCase[]): SuitePayload["cases"] {
  if (list.length === 0) return undefined;
  let keep = list.map((_, i) => i);
  if (list.length > MAX_CASES) {
    const notPassed = keep.filter((i) => list[i].status !== "passed");
    const passed = keep.filter((i) => list[i].status === "passed");
    keep = [...notPassed, ...passed].slice(0, MAX_CASES).sort((a, b) => a - b);
  }
  let budget = MAX_CASE_MESSAGE_BUDGET;
  return keep.map((i) => {
    const c = list[i];
    let message: string | undefined;
    if (c.message && budget > 0) {
      message = clip(c.message, Math.min(MAX_CASE_MESSAGE, budget));
      budget -= message.length;
    }
    return {
      name: clip(c.name, 300),
      status: c.status,
      ...(c.duration_ms !== null ? { duration_ms: c.duration_ms } : {}),
      ...(message ? { message } : {}),
    };
  });
}

export interface ParseOptions {
  format: ReportFormat;
  kind: SuiteKind;
  tool: string;
  /** The components the result is for; none = the API's `default`. */
  components?: string[];
  /** Tells apart results that are otherwise the same. */
  label?: string;
  /** The version of the tool that produced the report. */
  toolVersion?: string;
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
  const base = {
    kind: opts.kind,
    tool: opts.tool,
    ...(opts.components && opts.components.length > 0 ? { components: opts.components } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.toolVersion ? { tool_version: opts.toolVersion } : {}),
  };

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
        ...(toCases(j.cases) ? { cases: toCases(j.cases) } : {}),
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

/** What the CI says the project is about: an API of the catalog, and which environment of it. */
export interface SpecLink {
  id: string;
  environment?: string;
}

interface ProjectRef {
  id: string;
  created: boolean;
  /** The repository the project records now (unknown until it was read). */
  repo?: string | null;
  /** What the project is linked to now (unknown until it was read). */
  spec?: { id: string | null; environment: string | null };
  /** The link was set as the project was created. */
  specLinked?: boolean;
}

type Envelope<T> = { success: boolean; data: T };

/** Find the project by name, or create it (unless told not to). Returns its id. */
export async function ensureProject(
  conn: Connection,
  name: string,
  repo: string | null,
  create: boolean,
  spec?: SpecLink,
): Promise<ProjectRef> {
  const find = async (): Promise<ProjectRef | null> => {
    const res = await request({ ...conn, method: "GET", path: "/api/v1/projects", query: { name } });
    const list = (res.data as Envelope<{ data: { id: string; repo?: string | null; spec_id?: string | null; spec_environment?: string | null }[] }>).data.data;
    const hit = list[0];
    return hit ? { id: hit.id, created: false, repo: hit.repo, spec: { id: hit.spec_id ?? null, environment: hit.spec_environment ?? null } } : null;
  };

  const existing = await find();
  if (existing) return existing;
  if (!create) {
    throw new Error(`No project named '${name}' (create it first, or drop --no-create-project).`);
  }
  try {
    const res = await request({
      ...conn,
      method: "POST",
      path: "/api/v1/projects",
      // A new project is born linked: nothing to compare, nothing to patch afterwards.
      body: { name, ...(repo ? { repo } : {}), ...(spec ? { spec_id: spec.id, ...(spec.environment ? { spec_environment: spec.environment } : {}) } : {}) },
    });
    return { id: (res.data as Envelope<{ id: string }>).data.id, created: true, repo, spec: spec ? { id: spec.id, environment: spec.environment ?? null } : undefined, specLinked: !!spec };
  } catch (err) {
    // Another job of the same pipeline created it between our lookup and our create.
    if (err instanceof ApiError && err.status === 409) {
      const raced = await find();
      if (raced) return raced;
    }
    throw err;
  }
}

export interface UploadParams {
  conn: Connection;
  project: string;
  /** Send to this project by id: no lookup by name, nothing is created. */
  projectId?: string;
  repo: string | null;
  createProject: boolean;
  payload: ReportPayload;
  /** Tie the project to this API of the catalog (set when it differs; a new project is created already linked). */
  spec?: SpecLink;
}

/** What the project is linked to after the upload, and whether this upload changed it. */
export interface SpecResult {
  id: string;
  environment: string | null;
  /** false = it already was this; true = it was set (or changed) now. */
  changed: boolean;
  /** What it was linked to before this upload (null = nothing). */
  was: string | null;
}

export interface UploadResult {
  project_id: string;
  project_created: boolean;
  run_id: string;
  suite_id: string;
  replaced: boolean;
  spec?: SpecResult;
  /** The repository the project had before this upload, when this upload changed it (the CI's repository wins). */
  repo_changed_from?: string | null;
}

/**
 * The repository the CI reports is the project's repository: the latest sender wins, whether the old value was typed in
 * or came from an earlier upload. (To follow another repository, use another project.) Only a difference is written.
 */
async function syncRepo(conn: Connection, project: ProjectRef, repo: string): Promise<{ changed: boolean; was: string | null }> {
  let current = project.repo;
  if (current === undefined) {
    const res = await request({ ...conn, method: "GET", path: `/api/v1/projects/${encodeURIComponent(project.id)}` });
    current = (res.data as Envelope<{ repo?: string | null }>).data.repo ?? null;
  }
  if (current === repo) return { changed: false, was: current };
  await request({ ...conn, method: "PATCH", path: `/api/v1/projects/${encodeURIComponent(project.id)}`, body: { repo } });
  return { changed: true, was: current ?? null };
}

/**
 * Bring the project's link to the catalog in line with what the CI says. Only what differs is written, so a pipeline that
 * runs on every commit leaves the project untouched once it is linked. Pointing at another spec clears the environment
 * unless one is given too (the API's rule: the old environment belonged to the old spec).
 */
async function syncSpecLink(conn: Connection, project: ProjectRef, spec: SpecLink): Promise<SpecResult> {
  const want = spec.environment ?? null;
  if (project.specLinked) return { id: spec.id, environment: want, changed: true, was: null };
  let current = project.spec;
  if (!current) {
    const res = await request({ ...conn, method: "GET", path: `/api/v1/projects/${encodeURIComponent(project.id)}` });
    const row = (res.data as Envelope<{ spec_id?: string | null; spec_environment?: string | null }>).data;
    current = { id: row.spec_id ?? null, environment: row.spec_environment ?? null };
  }
  const sameId = current.id === spec.id;
  const patch: { spec_id?: string; spec_environment?: string } = {};
  if (!sameId) patch.spec_id = spec.id;
  if (spec.environment !== undefined && (!sameId || current.environment !== want)) patch.spec_environment = spec.environment;
  if (Object.keys(patch).length === 0) return { id: spec.id, environment: current.environment, changed: false, was: current.id };
  await request({ ...conn, method: "PATCH", path: `/api/v1/projects/${encodeURIComponent(project.id)}`, body: patch });
  return { id: spec.id, environment: spec.environment ?? (sameId ? current.environment : null), changed: true, was: current.id };
}

export async function uploadReport(p: UploadParams): Promise<UploadResult> {
  const project: ProjectRef = p.projectId ? { id: p.projectId, created: false } : await ensureProject(p.conn, p.project, p.repo, p.createProject, p.spec);
  let res;
  try {
    res = await request({
      ...p.conn,
      method: "POST",
      path: `/api/v1/projects/${encodeURIComponent(project.id)}/results`,
      body: p.payload,
    });
  } catch (err) {
    // A pinned id that is not found (or not yours) is a wrong id, not a project to create.
    if (p.projectId && err instanceof ApiError && err.status === 404) {
      throw new Error(`No project with id '${p.projectId}' (check --project-id / NB_ASSURANCE_PROJECT_ID, and --env).`);
    }
    throw err;
  }
  const data = (res.data as Envelope<{ run_id: string; suite_id: string; replaced: boolean }>).data;
  const done: UploadResult = { project_id: project.id, project_created: project.created, ...data };
  if (p.repo) {
    try {
      const synced = await syncRepo(p.conn, project, p.repo);
      if (synced.changed) done.repo_changed_from = synced.was;
    } catch (err) {
      const detail = err instanceof ApiError ? ((err.data as { error?: { message?: string } } | undefined)?.error?.message ?? err.message) : (err as Error).message;
      throw new Error(`The result was reported, but the project's repository could not be updated: ${detail}`);
    }
  }
  if (p.spec) {
    // The result is in; a link that fails now leaves it as it is and says so.
    try {
      done.spec = await syncSpecLink(p.conn, project, p.spec);
    } catch (err) {
      const detail = err instanceof ApiError ? ((err.data as { error?: { message?: string } } | undefined)?.error?.message ?? err.message) : (err as Error).message;
      throw new Error(`The result was reported, but the project could not be linked to the catalog: ${detail}`);
    }
  }
  return done;
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
  coverageReport?: string;
  metric?: string[];
  apiVersion?: string;
  dir?: string;
  format?: string;
  kind?: string;
  tool?: string;
  component?: string[];
  label?: string;
  toolVersion?: string;
  attach?: string;
  specId?: string;
  specEnvironment?: string;
  specFile?: string;
  specName?: string;
  specGroup?: string;
  specOrg?: string;
  project?: string;
  projectId?: string;
  repo?: string;
  repoUrl?: string;
  provider?: string;
  reportPath?: string;
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

/** At most this many components per result (the API's limit) and this many characters in a name. */
const MAX_COMPONENTS = 20;
const MAX_COMPONENT_LENGTH = 100;

/** The `--label`: trimmed, not empty, within the API's limit. */
function checkLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const label = raw.trim();
  if (label === "") fail("--label must not be empty");
  if (label.length > MAX_COMPONENT_LENGTH) fail(`--label must be ${MAX_COMPONENT_LENGTH} characters or fewer`);
  return label;
}

/** The `--tool-version`: trimmed, not empty, within the API's limit. */
function checkToolVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const version = raw.trim();
  if (version === "") fail("--tool-version must not be empty");
  if (version.length > 50) fail("--tool-version must be 50 characters or fewer");
  return version;
}

/** The `--component` names: trimmed, no empty one, no two alike ignoring case, within the API's limits. */
function checkComponents(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const out: string[] = [];
  for (const value of raw) {
    const name = value.trim();
    if (name === "") fail("--component must not be empty");
    if (name.length > MAX_COMPONENT_LENGTH) fail(`--component must be ${MAX_COMPONENT_LENGTH} characters or fewer: ${name.slice(0, 20)}…`);
    if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  if (out.length > MAX_COMPONENTS) fail(`At most ${MAX_COMPONENTS} --component values`);
  return out;
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

export interface Attachment {
  /** The name it is downloaded under. */
  name: string;
  bytes: Uint8Array;
}

/** `--attach`: a file as it is, or a folder as a zip. Refuses before anything is sent: missing, empty, or too big for the server. */
export function prepareAttachment(path: string, limit: number = MAX_ATTACHMENT_BYTES): Attachment {
  if (!existsSync(path)) throw new Error(`--attach: not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`--attach: ${path} is a symbolic link; pass the real path`);
  if (stat.isDirectory()) return { name: `${basename(path.replace(/[\\/]+$/, "")) || "report"}.zip`, bytes: zipDirectory(path, limit) };
  if (!stat.isFile()) throw new Error(`--attach: ${path} is not a file or a folder`);
  if (stat.size === 0) throw new Error(`--attach: ${path} is empty`);
  if (stat.size > limit) throw new Error(`--attach: ${path} is ${(stat.size / 1048576).toFixed(1)} MiB, more than the ${limit / 1048576} MiB the server takes`);
  return { name: basename(path), bytes: readFileSync(path) };
}

/** Keep the original report with a result that was just reported. A failure here leaves the result as it is. */
export async function uploadAttachment(conn: Connection, ids: { project_id: string; run_id: string; suite_id: string }, a: Attachment): Promise<void> {
  try {
    await request({
      ...conn,
      method: "PUT",
      path: `/api/v1/projects/${encodeURIComponent(ids.project_id)}/runs/${encodeURIComponent(ids.run_id)}/suites/${encodeURIComponent(ids.suite_id)}/attachment`,
      query: { name: a.name },
      rawBody: a.bytes,
      contentType: a.name.endsWith(".zip") ? "application/zip" : "application/octet-stream",
    });
  } catch (err) {
    const detail = err instanceof ApiError ? ((err.data as { error?: { message?: string } } | undefined)?.error?.message ?? err.message) : (err as Error).message;
    throw new Error(`The result was reported, but the attached report was not kept: ${detail}`);
  }
}

export function buildReportUploadCommand(): Command {
  return new Command("upload")
    .description("Report a test result file (JUnit XML or Locust CSV) to an Assurance project")
    .option("--file <path>", "the report file (JUnit XML, or Locust *_stats.csv)")
    .option("--dir <dir>", "a Locust output directory (uses its *_stats.csv)")
    .option("--coverage-report <path>", "specmatic: its report (the HTML or a JSON copy); adds the API coverage as the coverage_pct metric")
    .option("--format <format>", "junit | locust (default: from the file name)")
    .option("--kind <kind>", `what the suite proves: ${SUITE_KINDS.join(" | ")} (locust: load)`)
    .option("--tool <label>", "the producing tool, a free label, e.g. vitest, pytest, playwright, specmatic, zap, trivy (locust: locust)")
    .option("--component <name>", "a component the result is for (e.g. frontend, backend), repeatable when it covers several (e.g. an end-to-end test: --component frontend --component backend); new names are created in the project; leave it out for the component `default`", (v: string, all: string[] = []) => [...all, v])
    .option("--label <name>", "tells apart results that are otherwise the same, such as two scans of one tool on the same components (e.g. --label baseline, --label full-scan); part of the result's identity, so the same label again replaces the result; optional")
    .option("--tool-version <version>", "the version of the tool that produced the report (e.g. 9.1.0): informational, shown next to the tool, handy when a tool's new version changes its layout; optional")
    .option("--metric <key=value>", "an extra number for the suite, repeatable (e.g. --metric high=0 --metric medium=3; for security: critical, high, medium, low, info)", (v: string, all: string[] = []) => [...all, v])
    .option("--api-version <label>", "the API version the result is for (e.g. v1, v2), part of the result's identity next to its kind and components; leave it out for results that hold for every version, such as unit tests. Default: the NB_API_VERSION environment variable (set it once per CI job or branch). A project can require a version for some kinds of result, and then refuses one without it")
    .option("--project <name>", "project name (CI: the repository); found, or created if missing")
    .option("--attach <path>", "keep the tool's own report with the result: a file as it is, or a folder as a zip (up to 20 MiB). The server only stores it and offers it for download; nothing opens it. Nothing is attached unless you pass this, so check the report holds no secrets")
    .option("--spec-id <id>", "tie the project to this API of the catalog (the spec's id in Assurance / Specs): set when it differs, so a pipeline that runs on every commit leaves it alone once it is linked. A new project is created already linked. The id is not looked up here")
    .option("--spec-file <path>", "register this OpenAPI file in the API catalog first (a new spec, or a new version when its content changed; nothing is uploaded when it is already the latest) and tie the project to it: the whole chain in one command. Needs the catalog (Evolution) access of the account. Exclusive with --spec-id")
    .option("--spec-name <name>", "with --spec-file: the spec's name in the catalog (default: the document's info.title)")
    .option("--spec-group <name>", "with --spec-file: file a NEW spec in this group (made when missing); default none. An existing spec is never moved")
    .option("--spec-org <id>", "with --spec-file: the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .option("--spec-environment <name>", "which environment of that API the project covers (production, staging, ...); needs --spec-id")
    .option("--project-id <id>", "send to this project by id (or $NB_ASSURANCE_PROJECT_ID): no lookup by name and nothing is created, so a rename never moves the results; recommended for a pipeline once the project exists")
    .option("--repo <repo>", "repository recorded on the project; the latest sender wins (CI: detected)")
    .option("--repo-url <url>", "the repository's web address on its host, e.g. https://gitlab.example.com/group/app (CI: detected); lets Evolution link to the report on a self-hosted GitLab / GitHub Enterprise")
    .option("--provider <provider>", `the CI provider: ${RUN_PROVIDERS.join(" | ")} (CI: detected)`)
    .option("--report-path <path>", "the report file's path in the repository, relative to its root (default: detected, and only for a file committed at the reported commit)")
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

      // The flag wins; NB_API_VERSION (a CI variable) is the default, and an empty one (a CI that declares it but does not set it) is none.
      const versionRaw = opts.apiVersion ?? (process.env.NB_API_VERSION || undefined);
      const apiVersion = versionRaw === undefined ? undefined : checkApiVersion(versionRaw);
      const parsed = parseReport({
        format,
        kind,
        tool: checkedTool,
        components: checkComponents(opts.component),
        label: checkLabel(opts.label),
        toolVersion: checkToolVersion(opts.toolVersion),
        status: opts.status as "passed" | "failed" | undefined,
        maxFailRatio,
        file,
      });

      if (opts.coverageReport !== undefined) {
        if (kind !== "contract" || checkedTool !== "specmatic") fail("--coverage-report is only for --kind contract --tool specmatic");
        if (!existsSync(opts.coverageReport)) fail(`File not found: ${opts.coverageReport}`);
        const cov = parseSpecmaticCoverage(readFileSync(opts.coverageReport, "utf8"));
        parsed.suite.metrics = { ...parsed.suite.metrics, coverage_pct: cov.coverage_pct };
        parsed.note += `, API coverage ${cov.coverage_pct}% (${cov.covered}/${cov.total} operations)`;
      }

      if (apiVersion !== undefined) parsed.suite.api_version = apiVersion;
      if (opts.metric !== undefined && opts.metric.length > 0) {
        const extra = parseMetrics(opts.metric);
        const merged = { ...parsed.suite.metrics, ...extra };
        if (Object.keys(merged).length > MAX_METRICS) fail(`At most ${MAX_METRICS} metrics per suite`);
        parsed.suite.metrics = merged;
        parsed.note += `, metrics ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")}`;
      }

      const ci: CiInfo = detectCi(process.env);
      const runKey = opts.runKey ?? ci.runKey ?? fail("Cannot determine the run key; pass --run-key");
      const attachment = opts.attach !== undefined ? prepareAttachment(opts.attach) : undefined;
      if (opts.specId !== undefined && opts.specFile !== undefined) fail("--spec-id and --spec-file are exclusive: one names a spec of the catalog, the other registers a file");
      if (opts.specEnvironment !== undefined && opts.specId === undefined && opts.specFile === undefined) fail("--spec-environment needs --spec-id or --spec-file");
      for (const [flag, value] of [["--spec-name", opts.specName], ["--spec-group", opts.specGroup], ["--spec-org", opts.specOrg]] as const) {
        if (value !== undefined && opts.specFile === undefined) fail(`${flag} needs --spec-file`);
      }
      const specEnvironment = opts.specEnvironment !== undefined ? checkSpecEnvironment(opts.specEnvironment) : undefined;
      let spec: SpecLink | undefined = opts.specId !== undefined ? { id: checkSpecId(opts.specId), ...(specEnvironment !== undefined ? { environment: specEnvironment } : {}) } : undefined;
      // The file is read and its name settled before anything is sent, so a bad path fails the command while nothing has happened yet.
      const specText = opts.specFile !== undefined ? readSpecFile(opts.specFile) : undefined;
      const specOrg = opts.specFile !== undefined ? checkOrg(opts.specOrg ?? process.env.NB_SPECS_ORG) : undefined;
      const projectId = checkProjectId(opts.projectId ?? process.env.NB_ASSURANCE_PROJECT_ID);
      const project = opts.project ?? ci.project ?? projectId ?? fail("Cannot determine the project name; pass --project <name> or --project-id <id>");
      if (projectId && opts.project) process.stderr.write("--project is ignored: --project-id decides where the result goes\n");
      const commit = opts.commit ?? ci.commitSha;
      const branch = opts.branch ?? ci.branch;
      const ciUrl = opts.ciUrl ?? ci.ciUrl;
      const provider = opts.provider !== undefined ? checkProvider(opts.provider) : ci.provider === "local" ? undefined : ci.provider;
      const repoUrl = opts.repoUrl !== undefined ? checkRepoUrl(opts.repoUrl) : ci.repoUrl;
      const reportPath = opts.reportPath !== undefined ? checkReportPath(opts.reportPath) : readReportPath(file, commit);
      if (reportPath) parsed.suite.report_path = reportPath;

      const payload: ReportPayload = {
        run: {
          key: runKey,
          ...(commit ? { commit_sha: commit } : {}),
          ...(branch ? { branch } : {}),
          ...(ciUrl ? { ci_url: ciUrl } : {}),
          ...(provider ? { provider } : {}),
          ...(repoUrl ? { repo_url: repoUrl } : {}),
        },
        suite: parsed.suite,
      };
      const repo = opts.repo ?? ci.repo;

      if (opts.dryRun) {
        printJson({ project, ...(projectId ? { project_id: projectId } : {}), repo, payload, ...(spec ? { spec } : {}), ...(specText !== undefined && opts.specFile !== undefined ? { spec_file: { file: opts.specFile, name: specNameFor(specText, opts.specFile, opts.specName), content_hash: hashText(specText), ...(opts.specGroup ? { group: opts.specGroup } : {}) } } : {}), ...(attachment ? { attachment: { name: attachment.name, size_bytes: attachment.bytes.length } } : {}) });
        process.stderr.write(`(dry run) ${basename(dirname(file)) || "."}/${basename(file)}: ${parsed.note}\n`);
        return;
      }

      const env = (opts.env as Environment | undefined) || resolveEnv();
      const override = process.env.NB_BASE_URL?.replace(/\/$/, "");
      const baseUrl = override ?? resolveBaseUrl(loadSpec("assurance.yaml").servers, env);
      const token = opts.token || (await resolveAccessToken());

      // The catalog comes first: the project is tied to the spec it returns. It must not cost the result: a failure here is
      // kept, the result is reported without the link, and the command says so at the end.
      let pushed: PushResult | undefined;
      let specError: Error | undefined;
      if (opts.specFile !== undefined && specOrg !== undefined) {
        try {
          pushed = await pushSpec({
            conn: { baseUrl: specsBaseUrl(env), token, org: specOrg },
            file: opts.specFile,
            name: opts.specName,
            group: opts.specGroup,
            note: ciNote(ci, commit),
          });
          spec = { id: pushed.id, ...(specEnvironment !== undefined ? { environment: specEnvironment } : {}) };
        } catch (err) {
          specError = err as Error;
        }
      }

      const result = await uploadReport({
        conn: { baseUrl, token },
        project,
        projectId,
        repo,
        createProject: opts.createProject,
        payload,
        spec,
      });
      if (attachment) await uploadAttachment({ baseUrl, token }, result, attachment);
      printJson({ ...result, ...(attachment ? { attachment: { name: attachment.name, size_bytes: attachment.bytes.length } } : {}), ...(pushed ? { catalog: pushed } : {}) });
      exportGithubOutput("project_id", result.project_id);
      if (pushed) exportGithubOutput("spec_id", pushed.id);
      process.stderr.write(
        `✓ ${kind}/${checkedTool} ${payload.suite.status}: ${parsed.note} -> project '${project}' (id ${result.project_id})` +
          `${result.project_created ? " (created)" : ""}, run '${runKey}'${result.replaced ? " (replaced)" : ""}` +
          `${attachment ? `, attached ${attachment.name} (${(attachment.bytes.length / 1024).toFixed(0)} KiB)` : ""}` +
          `${pushed ? `, spec ${pushed.name} v${pushed.version} (${pushed.action.replace("_", " ")})` : ""}` +
          `${result.spec ? `, catalog ${result.spec.id}${result.spec.environment ? ` (${result.spec.environment})` : ""} ${result.spec.changed ? (result.spec.was ? `(changed from ${result.spec.was})` : "(linked)") : "(already linked)"}` : ""}\n`,
      );
      if (result.repo_changed_from !== undefined) {
        process.stderr.write(`  Repository of the project set to ${repo} (was ${result.repo_changed_from ?? "not set"}); the latest sender wins\n`);
      }
      if (!projectId) {
        process.stderr.write(
          `  Pin it so a rename or a typo cannot send results elsewhere: --project-id ${result.project_id} (or NB_ASSURANCE_PROJECT_ID=${result.project_id})\n`,
        );
      }
      if (specError) throw new Error(`The result was reported, but the spec could not be registered in the catalog (the project is not tied to it): ${specError.message}`);
    });
}
