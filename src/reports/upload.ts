/**
 * `nb assurance report upload` - read a test report on the CI runner, reduce it
 * to the normalised summary, and report it to a NASEBANAL Assurance SPEC (the spec of the API catalog, with the repository
 * it is tied to: `nb specs specs push`, `nb specs repositories upsert`). The spec is named by id (`--spec-id`, $NB_SPEC_ID) or
 * by names (`--repository`, optional `--component` / `--group` / `--api-version`, `--spec`), see `resolveSpec`; nothing is registered
 * by a report. A result has no API version of its own: it belongs to the spec it is reported to (one spec per API version).
 *
 * The same command runs in a pipeline and on a laptop (nb-quickstarts' `make
 * <tool>:report-upload` calls it): it takes its run key, commit and branch
 * from the CI environment when there is one, and authenticates with
 * `NB_TOKEN` (a PAT or service-account token) so no browser is needed.
 *
 * The parsing happens here, not on the server: the server stays small, parsers
 * are testable offline, and what is uploaded is a few hundred bytes of summary
 * instead of a megabyte of report.
 */
import { Command, Option } from "commander";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { baseUrlOverride, resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { request, resolveBaseUrl, ApiError } from "../http.js";
import { loadSpec } from "../spec/loader.js";
import { exportGithubOutput, printJson } from "../output.js";
import { detectCi, readReportPath, type CiInfo } from "./ci.js";
import { parseJunit, type JunitCase, type SuiteFailure } from "./junit.js";
import { summariseLocust } from "./locust.js";
import { parseSpecmaticCoverage } from "./specmatic.js";
import { MAX_ATTACHMENT_BYTES, zipDirectory } from "./zip.js";
import { checkOrg, hashText, readSpecFile, specsBaseUrl } from "../specs/push.js";
import { resolveRepositorySpecs, resolveSpec, type ResolvedSpec, type SpecRef } from "../specs/resolve.js";

export const SUITE_KINDS = ["unit", "e2e", "load", "contract", "security"] as const;
export type SuiteKind = (typeof SUITE_KINDS)[number];
export type ReportFormat = "junit" | "locust";
export const RUN_PROVIDERS = ["github", "gitlab", "other"] as const;
export type RunProvider = (typeof RUN_PROVIDERS)[number];

/** What the API's ids look like (12 letters and digits); anything else is a typo, not a spec. */
const SPEC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `--spec-id` / `NB_SPEC_ID`: trimmed; empty is none. */
export function checkSpecId(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!SPEC_ID_PATTERN.test(v)) {
    throw new Error(`--spec-id '${raw}' is not a spec id (letters, digits, '-' and '_'): it is the id of the spec in the catalog (Spec Management, or \`nb specs specs list\`)`);
  }
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

const MAX_FAILURES = 20;
/** Per-test cases: the API accepts this many (MAX_CASES), each message up to 2000 characters. */
export const MAX_CASES = 5000;
const MAX_CASE_MESSAGE = 2000;
/** Total failure text sent across all cases, so a suite where everything fails stays a modest upload. */
const MAX_CASE_MESSAGE_BUDGET = 1_000_000;

export interface SuitePayload {
  kind: SuiteKind;
  tool: string;
  /** Tells apart results that are otherwise the same (two scans of one tool); absent = none. */
  label?: string;
  /** The version of the tool that produced the report; informational. */
  tool_version?: string;
  /** The SHA-256 of the API contract document the result was produced against (64 lowercase hex); informational. */
  spec_hash?: string;
  /** The report file's path in the repository, relative to its root; only for a committed file. */
  report_path?: string;
  status: "passed" | "failed";
  tests?: { total: number; passed: number; failed: number; skipped?: number };
  duration_ms?: number;
  metrics?: Record<string, number>;
  failures?: { name: string; message?: string }[];
  cases?: { name: string; status: "passed" | "failed" | "skipped"; duration_ms?: number; message?: string }[];
}

export interface ReportPayload {
  /** The repository the spec is tied to (required by the API together with the spec in the path). */
  repository_id: string;
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
  /** Tells apart results that are otherwise the same. */
  label?: string;
  /** The version of the tool that produced the report. */
  toolVersion?: string;
  /** The SHA-256 of the contract the result was produced against. */
  specHash?: string;
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
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.toolVersion ? { tool_version: opts.toolVersion } : {}),
    ...(opts.specHash ? { spec_hash: opts.specHash } : {}),
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
  /** Extra request headers (the active organization, when it is not `personal`). */
  headers?: Record<string, string>;
}

type Envelope<T> = { success: boolean; data: T };

export interface UploadParams {
  conn: Connection;
  /** The spec the result is for: the id of the catalog. */
  specId: string;
  /** The payload carries the repository the spec is tied to (`repository_id`). */
  payload: ReportPayload;
}

export interface UploadResult {
  spec_id: string;
  repository_id: string;
  run_id: string;
  suite_id: string;
  replaced: boolean;
}

export async function uploadReport(p: UploadParams): Promise<UploadResult> {
  let res;
  try {
    res = await request({
      ...p.conn,
      method: "POST",
      path: `/api/v1/specs/${encodeURIComponent(p.specId)}/results`,
      body: p.payload,
    });
  } catch (err) {
    // Assurance answers 404 for an id that is held by another namespace; a typo is the likelier cause.
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(`No spec with id '${p.specId}' for this account (check --spec-id / NB_SPEC_ID, --org and --env). The id is the spec's id in the catalog.`);
    }
    // The pair of spec and repository is checked by Assurance against the catalog: say what it refused.
    if (err instanceof ApiError && err.status === 422) {
      const e = (err.data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new Error(`Assurance refused the result${e?.code ? ` (${e.code})` : ""}: ${e?.message ?? err.message}`);
    }
    throw err;
  }
  const data = (res.data as Envelope<{ run_id: string; suite_id: string; replaced: boolean }>).data;
  return { spec_id: p.specId, repository_id: p.payload.repository_id, ...data };
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
  label?: string;
  toolVersion?: string;
  specHash?: string;
  contractFile?: string;
  attach?: string;
  repositoryId?: string;
  specId?: string;
  repository?: string;
  component?: string;
  group?: string;
  spec?: string;
  allSpecs?: boolean;
  repositoryProvider?: string;
  org?: string;
  repoUrl?: string;
  provider?: string;
  reportPath?: string;
  runKey?: string;
  commit?: string;
  branch?: string;
  ciUrl?: string;
  status?: string;
  maxFailRatio?: string;
  dryRun?: boolean;
  env?: string;
  token?: string;
}

/** The longest `--label` the API takes. */
const MAX_LABEL_LENGTH = 100;

/** The `--label`: trimmed, not empty, within the API's limit. */
function checkLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const label = raw.trim();
  if (label === "") fail("--label must not be empty");
  if (label.length > MAX_LABEL_LENGTH) fail(`--label must be ${MAX_LABEL_LENGTH} characters or fewer`);
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

/** The `--spec-hash`: a SHA-256 in hex (what `nb specs versions` prints), lower-cased because the API takes lowercase only. */
function checkSpecHash(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const hash = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) fail("--spec-hash must be a SHA-256 in hex (64 characters), e.g. the sha256 `nb specs versions` prints");
  return hash;
}

/** The `--contract-file`: the hash the catalog would keep as `content_hash` for this document (SHA-256 of its text). */
function hashOfContractFile(file: string): string {
  try {
    return hashText(readSpecFile(file));
  } catch (err) {
    return fail(String((err as Error).message).replace(/^--file:/, "--contract-file:"));
  }
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
export async function uploadAttachment(conn: Connection, ids: { spec_id: string; run_id: string; suite_id: string }, a: Attachment): Promise<void> {
  try {
    await request({
      ...conn,
      method: "PUT",
      path: `/api/v1/specs/${encodeURIComponent(ids.spec_id)}/runs/${encodeURIComponent(ids.run_id)}/suites/${encodeURIComponent(ids.suite_id)}/attachment`,
      query: { name: a.name },
      rawBody: a.bytes,
      contentType: a.name.endsWith(".zip") ? "application/zip" : "application/octet-stream",
    });
  } catch (err) {
    const detail = err instanceof ApiError ? ((err.data as { error?: { message?: string } } | undefined)?.error?.message ?? err.message) : (err as Error).message;
    throw new Error(`The result was reported, but the attached report was not kept: ${detail}`);
  }
}

/**
 * The spec a command is about, from its options: `--spec-id` (default $NB_SPEC_ID) OR `--repository` [`--component`] `--spec`
 * (a name asked for on the command line wins over the id the pipeline's variable carries). The retired `NB_REPOSITORY_ID` /
 * `--repository-id` are refused with the way to the new ones, for this release.
 */
export function specRefOf(opts: { repositoryId?: string; specId?: string; repository?: string; component?: string; group?: string; apiVersion?: string; spec?: string; repositoryProvider?: string }, env: NodeJS.ProcessEnv = process.env): SpecRef {
  if (opts.repositoryId !== undefined) fail("--repository-id is retired: a result is reported to a SPEC now. Use --spec-id <id> (or $NB_SPEC_ID), or --repository <owner/name> [--component <name>] [--group <name>] --spec <name>");
  const byNames = [opts.repository, opts.spec, opts.component, opts.group, opts.apiVersion].some((v) => v !== undefined && v.trim() !== "");
  if (opts.specId !== undefined && byNames) fail("--spec-id names the spec by itself: do not combine it with --repository, --component, --group, --api-version or --spec");
  if (opts.repositoryProvider !== undefined && !opts.repository) fail("--repository-provider needs --repository");
  if (byNames) return { repository: opts.repository, component: opts.component, group: opts.group, apiVersion: opts.apiVersion, spec: opts.spec, provider: opts.repositoryProvider };
  const specId = checkSpecId(opts.specId ?? env.NB_SPEC_ID);
  if (specId) return { specId };
  if (env.NB_REPOSITORY_ID?.trim()) {
    fail("NB_REPOSITORY_ID is retired: a result is now reported to a SPEC. Set NB_SPEC_ID (the spec's id in the catalog), or pass --repository <owner/name> [--component <name>] --spec <name>");
  }
  return fail("Say which spec: --spec-id <id> (or set NB_SPEC_ID), or --repository <owner/name> [--component <name>] [--group <name>] [--api-version <v>] --spec <name>. The spec must be tied to a repository (Spec Management on the screen, or `nb specs specs push`)");
}

export function buildReportUploadCommand(): Command {
  return new Command("upload")
    .description("Report a test result file (JUnit XML or Locust CSV) to an Assurance spec: by its id (--spec-id, or $NB_SPEC_ID), or by names (--repository, optional --component and --group, --spec, and --api-version when the name exists at several API versions). The spec must be tied to a repository; nothing is registered by a report")
    .option("--file <path>", "the report file (JUnit XML, or Locust *_stats.csv)")
    .option("--dir <dir>", "a Locust output directory (uses its *_stats.csv)")
    .option("--coverage-report <path>", "specmatic: its report (the HTML or a JSON copy); adds the API coverage as the coverage_pct metric")
    .option("--format <format>", "junit | locust (default: from the file name)")
    .option("--kind <kind>", `what the suite proves: ${SUITE_KINDS.join(" | ")} (locust: load)`)
    .option("--tool <label>", "the producing tool, a free label, e.g. vitest, pytest, playwright, specmatic, zap, trivy (locust: locust)")
    .option("--label <name>", "tells apart results that are otherwise the same, such as two scans of one tool of the same spec (e.g. --label baseline, --label full-scan); part of the result's identity, so the same label again replaces the result; optional")
    .option("--tool-version <version>", "the version of the tool that produced the report (e.g. 9.1.0): informational, shown next to the tool, handy when a tool's new version changes its layout; optional")
    .option("--spec-hash <sha256>", "the SHA-256 of the API contract this result was produced against (64 hex characters; the sha256 `nb specs versions` prints for a catalog version): Evolution compares it with the catalog's versions and tells whether the result was produced with the current contract, an older one or an unknown one. Informational, not part of the result's identity; a report sent again replaces it. Exclusive with --contract-file")
    .option("--contract-file <path>", "the contract document the result was produced against (e.g. node_modules/@nasebanal/api-specs-<api>/spec.yaml): its SHA-256 is sent as --spec-hash would, the same hash the catalog keeps for that document. Exclusive with --spec-hash")
    .option("--metric <key=value>", "an extra number for the suite, repeatable (e.g. --metric high=0 --metric medium=3; for security: critical, high, medium, low, info)", (v: string, all: string[] = []) => [...all, v])
    .option("--api-version <v>", "by names: the API version (v1, v2) of the spec, part of the spec's key (a new major API version is a new spec). It selects the spec; a result has no API version of its own. Left out, it is the API version of the one spec the rest of the key matches (several: the error lists them). With --all-specs: only the specs at this API version get the result (a release branch feeds its own API version)")
    .option("--attach <path>", "keep the tool's own report with the result: a file as it is, or a folder as a zip (up to 20 MiB). The server only stores it and offers it for download; nothing opens it. Nothing is attached unless you pass this, so check the report holds no secrets")
    .option("--spec-id <id>", "the spec to report to, by its id in the catalog (default: $NB_SPEC_ID). Keep the id in the pipeline's variable: a rename of the spec or its repository never moves the results. Exclusive with --repository / --component / --spec")
    .option("--repository <owner/name>", "by names: the repository the spec is tied to (owner/name for a git host). Needs --spec; --component is optional (none = the repository as a whole). The three are checked against each other: the spec must be tied to exactly that repository row. Nothing is created")
    .option("--component <name>", "by names: the component part of the repository's key (the owner's own name for a part of it, e.g. account-api, web); optional, none = the repository as a whole")
    .option("--group <name>", "by names: the group the spec is filed in (an environment, say: the same spec name may exist in several groups); optional, none = the specs in no group (not any group). On a miss the error lists where the name is")
    .option("--spec <name>", "by names: the spec's name in the catalog. Needs --repository")
    .option("--all-specs", "by names, instead of --spec: send the result to EVERY spec tied to that repository row at one API version, whatever its group (a result that belongs to the source, not to an environment: --kind unit or security). A repository row with specs of several API versions needs --api-version (a release branch feeds its own API version only). One line per spec")
    .addOption(new Option("--repository-id <id>", "retired: use --spec-id").hideHelp())
    .option("--repository-provider <provider>", "with --repository: github | gitlab | bitbucket | other (default: github)")
    .option("--org <id>", "the organization whose specs these are (an id), or 'personal' (default; or $NB_SPECS_ORG): sent to the catalog and to Assurance as X-Active-Organization-Id")
    .option("--repo-url <url>", "the repository's web address on its host, e.g. https://gitlab.example.com/group/app (CI: detected); lets Evolution link to the report on a self-hosted GitLab / GitHub Enterprise")
    .option("--provider <provider>", `the CI provider: ${RUN_PROVIDERS.join(" | ")} (CI: detected)`)
    .option("--report-path <path>", "the report file's path in the repository, relative to its root (default: detected, and only for a file committed at the reported commit)")
    .option("--run-key <key>", "identity of the pipeline run (CI: detected); all jobs of a run share it")
    .option("--commit <sha>", "commit SHA (CI: detected)")
    .option("--branch <name>", "branch (CI: detected)")
    .option("--ci-url <url>", "link to the CI run (CI: detected)")
    .option("--status <status>", "passed | failed; default is derived from the report")
    .option("--max-fail-ratio <ratio>", "locust: allowed failure ratio 0..1 (default: $LOCUST_MAX_FAIL_RATIO or 0)")
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

      // NB_API_VERSION retired with the result's own api_version: the API version is the spec's now. A CI that still sets it keeps working.
      if (process.env.NB_API_VERSION?.trim()) {
        process.stderr.write("! NB_API_VERSION is retired and ignored: a result has no API version of its own, it belongs to the spec it is reported to (a new major API version is a new spec). Use --api-version <v> only to SELECT a spec by names\n");
      }
      if (opts.specHash !== undefined && opts.contractFile !== undefined) fail("--spec-hash and --contract-file are exclusive: one gives the hash, the other a file to take it from");
      const parsed = parseReport({
        format,
        kind,
        tool: checkedTool,
        label: checkLabel(opts.label),
        toolVersion: checkToolVersion(opts.toolVersion),
        specHash: opts.contractFile !== undefined ? hashOfContractFile(opts.contractFile) : checkSpecHash(opts.specHash),
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
      // Which spec the result is for is settled before anything is sent: an id, or names the catalog turns into one (or, with
      // --all-specs, every spec of one repository row: only for results that belong to the source).
      if (opts.allSpecs) {
        if (!opts.repository) fail("--all-specs needs --repository <owner/name> [--component <name>]: the specs tied to that repository row get the result");
        if (opts.spec !== undefined || opts.specId !== undefined || opts.group !== undefined) fail("--all-specs sends the result to every spec of that repository at one API version: do not combine it with --spec-id, --spec or --group");
        if (kind !== "unit" && kind !== "security") fail(`--all-specs is for results that belong to the source (--kind unit or security), not --kind ${kind}: a ${kind} result is about one deployed environment, so name its spec (--spec-id, or --spec with --group)`);
      }
      const ref: SpecRef = opts.allSpecs ? { repository: opts.repository, component: opts.component, apiVersion: opts.apiVersion, provider: opts.repositoryProvider } : specRefOf(opts);
      const org = checkOrg(opts.org ?? process.env.NB_SPECS_ORG);
      const commit = opts.commit ?? ci.commitSha;
      const branch = opts.branch ?? ci.branch;
      const ciUrl = opts.ciUrl ?? ci.ciUrl;
      const provider = opts.provider !== undefined ? checkProvider(opts.provider) : ci.provider === "local" ? undefined : ci.provider;
      const repoUrl = opts.repoUrl !== undefined ? checkRepoUrl(opts.repoUrl) : ci.repoUrl;
      const reportPath = opts.reportPath !== undefined ? checkReportPath(opts.reportPath) : readReportPath(file, commit);
      if (reportPath) parsed.suite.report_path = reportPath;

      const buildPayload = (repositoryId: string): ReportPayload => ({
        repository_id: repositoryId,
        run: {
          key: runKey,
          ...(commit ? { commit_sha: commit } : {}),
          ...(branch ? { branch } : {}),
          ...(ciUrl ? { ci_url: ciUrl } : {}),
          ...(provider ? { provider } : {}),
          ...(repoUrl ? { repo_url: repoUrl } : {}),
        },
        suite: parsed.suite,
      });
      const env = (opts.env as Environment | undefined) || resolveEnv();
      const specsConn = { baseUrl: specsBaseUrl(env), token: opts.token || (await resolveAccessToken()), org };
      const attachmentNote = attachment ? { attachment: { name: attachment.name, size_bytes: attachment.bytes.length } } : {};
      if (opts.dryRun) {
        // Nothing is written. By names the catalog is only read (to say which spec and repository they mean); by id nothing is called.
        if (opts.allSpecs) {
          const hits = await resolveRepositorySpecs(specsConn, ref);
          printJson({ specs: hits.map((h) => ({ id: h.spec_id, name: h.spec_name })), repository: hits[0].repository, payload: buildPayload(hits[0].repository_id), ...attachmentNote });
        } else if (ref.specId !== undefined) {
          printJson({ spec_id: ref.specId, repository_id: "(from the catalog when sent)", payload: buildPayload("(from the catalog when sent)"), ...attachmentNote });
        } else {
          const hit = await resolveSpec(specsConn, ref);
          printJson({ spec: { id: hit.spec_id, name: hit.spec_name }, repository: hit.repository, payload: buildPayload(hit.repository_id), ...attachmentNote });
        }
        process.stderr.write(`(dry run) ${basename(dirname(file)) || "."}/${basename(file)}: ${parsed.note}\n`);
        return;
      }

      const baseUrl = baseUrlOverride("assurance") ?? resolveBaseUrl(loadSpec("assurance.yaml").servers, env);

      // Assurance and the catalog act for the same owner: the organization goes to both (personal is the default and sent as is).
      const orgHeaders = org === "personal" ? undefined : { "X-Active-Organization-Id": org };
      const hits: ResolvedSpec[] = opts.allSpecs ? await resolveRepositorySpecs(specsConn, ref) : [await resolveSpec(specsConn, ref)];
      const conn = { baseUrl, token: specsConn.token, ...(orgHeaders ? { headers: orgHeaders } : {}) };
      const results: UploadResult[] = [];
      for (const hit of hits) {
        const label = `${hit.spec_name} (${hit.repository.provider} ${hit.repository.name}${hit.repository.component ? ` / ${hit.repository.component}` : ""}), id ${hit.spec_id}`;
        const result = await uploadReport({ conn, specId: hit.spec_id, payload: buildPayload(hit.repository_id) });
        if (attachment) await uploadAttachment(conn, result, attachment);
        results.push(result);
        process.stderr.write(
          `✓ ${kind}/${checkedTool} ${parsed.suite.status}: ${parsed.note} -> spec ${label}, run '${runKey}'${result.replaced ? " (replaced)" : ""}` +
            `${attachment ? `, attached ${attachment.name} (${(attachment.bytes.length / 1024).toFixed(0)} KiB)` : ""}\n`,
        );
      }
      if (opts.allSpecs) {
        printJson({ results, ...attachmentNote });
        exportGithubOutput("spec_ids", results.map((x) => x.spec_id).join(","));
      } else {
        printJson({ ...results[0], ...attachmentNote });
        exportGithubOutput("spec_id", results[0].spec_id);
      }
      exportGithubOutput("repository_id", results[0].repository_id);
    });
}
