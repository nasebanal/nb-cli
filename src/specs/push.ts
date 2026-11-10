/**
 * `nb specs push` - register an OpenAPI document in the API catalog (nb-specs-api) from a file, the way a pipeline
 * wants it: no group has to exist, nothing is uploaded when the file is already the latest version, and running it on
 * every commit is safe.
 *
 *   - the spec is found by its key (or by `--id`): its group, its repository row, its API VERSION and its name; new -> created with
 *     its first revision (and the group, the repository and the spec are all made on the first run), known -> a new revision. The
 *     API version is what the document's `info.version` gives (1.8.0 -> v1; see apiVersion.ts), or `--api-version`: a document of
 *     another major makes (first-run semantics) the NEW spec for that API version and never touches the other one. The same name
 *     may exist in other groups (an environment each) and at other API versions; a group left out means "the specs in no group",
 *     not any group, and a name that exists only in groups is an error that lists them instead of silently making a second spec
 *   - the document's SHA-256 is compared with the latest version's `content_hash` BEFORE anything is sent: the same
 *     bytes mean "unchanged", and the 2 MiB stay where they are. (The server refuses an identical upload with
 *     409 UNCHANGED too; that is treated as "unchanged", for two jobs racing.)
 *   - a group is optional: `--group <name>` is part of the key (the spec is looked up in that group) and files a NEW spec there
 *     (the group is made when missing); a spec that already exists is never moved by a push (moving is the catalog's job).
 *   - `--server-url <url>` replaces the document's top-level `servers` before it is sent (see servers.ts): one OpenAPI file in the
 *     repository, one URL per environment.
 *   - a repository is optional too: `--repository-id <id>` (or `$NB_REPOSITORY_ID`) ties the spec to that repository, and
 *     `--repository <name> [--component <name>]` (the key of a repository is provider + name + component; no component = the
 *     repository as a whole) registers the repository first (an idempotent upsert) and uses the id it returns. A NEW spec
 *     is created tied to it; an existing spec with no repository is tied to it; one tied to ANOTHER repository is left
 *     where it is and the result says so (a push never moves a spec).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { parse } from "yaml";
import { ApiError, request } from "../http.js";
import type { Environment } from "../config.js";
import type { CiInfo } from "../reports/ci.js";
import { envTokenHint } from "../output.js";
import { apiVersionOf, checkApiVersion, sameApiVersion } from "./apiVersion.js";
import { checkServerUrl, setServers, type ServersEdit } from "./servers.js";

/** The catalog takes documents up to this size (2 MiB); the CLI refuses a larger one before sending anything. */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 500;

export interface SpecsConnection {
  baseUrl: string;
  token: string | undefined;
  /** `X-Active-Organization-Id`: an organization's id, or `personal` for the caller's own specs. */
  org: string;
}

export type PushAction = "created" | "new_version" | "unchanged";

export const REPOSITORY_PROVIDERS = ["github", "gitlab", "bitbucket", "other"] as const;
export type RepositoryProvider = (typeof REPOSITORY_PROVIDERS)[number];

/** A repository as the catalog answers it. */
export interface RepositoryRow {
  id: string;
  provider: RepositoryProvider;
  name: string;
  /** The owner's own name for a part of the repository; '' = the repository as a whole. Part of the key. */
  component: string;
  /** A result of this repository may carry the original test report (kept in R2). The repository's own setting. */
  attachments_enabled?: boolean;
  spec_count?: number;
}

export interface PushResult {
  id: string;
  name: string;
  /** The revision the spec is at after the push (the latest). */
  version: number;
  /** The API version (v1, v2) of the spec: part of its key. */
  api_version: string;
  /** null = in no group. */
  group_id: string | null;
  action: PushAction;
  content_hash: string;
  /** Set when the push renamed the spec (or, in a dry run, would): the name it had. */
  renamed_from?: string;
  /** The repository the spec is tied to after the push; null = none. */
  repository_id: string | null;
  /** Set when the spec is tied to ANOTHER repository than the one asked for: it was left there (a push never moves a spec). */
  repository_kept?: string;
  /** Set with `--server-url`: the URL the pushed document carries, and how the file was edited (json | text | reserialised). */
  server_url?: string;
  servers_edit?: ServersEdit["method"];
}

export interface PushParams {
  conn: SpecsConnection;
  file: string;
  /** Default: the document's `info.title`, then the file's name. */
  name?: string;
  /** The group a NEW spec is filed in (by name; made when missing). Absent = no group. */
  group?: string;
  description?: string;
  /** What changed, shown in the revision list. */
  note?: string;
  /** The API version of the spec (v1, v2), part of its key. Default: what the document's `info.version` gives; needed when it gives none. */
  apiVersion?: string;
  /** Push to this spec by id: a rename of the spec cannot make a second one. */
  id?: string;
  /** With `id`: also rename the spec to `name` (default: the document's `info.title`) when it is called something else. */
  rename?: boolean;
  /** The repository to tie the spec to, by id. Wins over `repository`. */
  repositoryId?: string;
  /** The repository to tie the spec to, by name: registered first (upsert), its id used. */
  repository?: string;
  /** With `repository`: the provider of that name (default `github`). */
  provider?: RepositoryProvider;
  /** With `repository`: the component (default none = the repository as a whole). */
  component?: string;
  /** Replace the document's top-level `servers` with this one URL before sending (the environment's URL). */
  serverUrl?: string;
  /** Read what is there, write nothing, say what would happen. */
  dryRun?: boolean;
}

export type Envelope<T> = { success: boolean; data: T };

/** The catalog's host for the active environment (`NB_SPECS_BASE_URL` overrides; the CLI ships no spec for this API). */
export function specsBaseUrl(env: Environment): string {
  const override = process.env.NB_SPECS_BASE_URL?.replace(/\/$/, "");
  if (override) return override;
  return env === "local" ? "http://localhost:8792" : "https://api.specs.nasebanal.com";
}

/** `--org` / `NB_SPECS_ORG`: `personal`, or an organization's numeric id. Unset or empty (a CI variable left blank) is `personal`. */
export function checkOrg(raw: string | undefined): string {
  const v = raw?.trim() || "personal";
  if (v === "personal" || /^[1-9]\d{0,17}$/.test(v)) return v;
  throw new Error(`--org '${raw}' must be 'personal' or an organization id (a number)`);
}

/** SHA-256 (hex) of the document as text - what the catalog stores as `content_hash`. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What a pipeline says about a version it pushes: the commit, the branch and the CI run, so "which commit made v7" has an answer. */
export function ciNote(ci: CiInfo, commit: string | null | undefined): string | undefined {
  const sha = (commit ?? ci.commitSha)?.slice(0, 7);
  const parts = [ci.repo && sha ? `${ci.repo}@${sha}` : (sha ?? ci.repo), ci.branch ? `(${ci.branch})` : null, ci.ciUrl].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" ").slice(0, MAX_NOTE) : undefined;
}

export function readSpecFile(file: string): string {
  if (!existsSync(file)) throw new Error(`--file: not found: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`--file: ${file} is not a file`);
  if (stat.size === 0) throw new Error(`--file: ${file} is empty`);
  if (stat.size > MAX_SPEC_BYTES) throw new Error(`--file: ${file} is ${(stat.size / 1048576).toFixed(1)} MiB, more than the ${MAX_SPEC_BYTES / 1048576} MiB the catalog takes`);
  return readFileSync(file, "utf8");
}

/** `info.title` of the document, or null (not parseable, or no title): the server decides whether it is a valid OpenAPI. */
export function titleOf(text: string): string | null {
  try {
    const doc = parse(text) as { info?: { title?: unknown } } | null;
    const title = doc?.info?.title;
    return typeof title === "string" && title.trim() !== "" ? title.trim() : null;
  } catch {
    return null;
  }
}

/** The name a spec is registered under: asked for, else its title, else its file's name. At most 100 characters. */
export function specNameFor(text: string, file: string, asked?: string): string {
  const name = (asked ?? titleOf(text) ?? basename(file, extname(file))).trim();
  if (name === "") throw new Error("The spec has no name: pass --name");
  return name.slice(0, 100);
}

export function headersOf(conn: SpecsConnection) {
  return { baseUrl: conn.baseUrl, token: conn.token, headers: { "X-Active-Organization-Id": conn.org } };
}

export function reasonOf(err: unknown): string {
  if (err instanceof ApiError) return (err.data as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
  return (err as Error).message;
}

const codeOf = (err: unknown): string | undefined => (err instanceof ApiError ? (err.data as { error?: { code?: string } } | undefined)?.error?.code : undefined);

export interface SpecRow {
  id: string;
  name: string;
  group_id: string | null;
  /** Absent from a catalog that predates repositories. */
  repository_id?: string | null;
  /** The revision the spec is at. */
  latest_version: number;
  /** The API version (v1, v2): part of the spec's key. */
  api_version?: string;
}

/** `--provider`: one of the four the catalog knows. */
export function checkProvider(raw: string | undefined): RepositoryProvider {
  const v = (raw?.trim() || "github").toLowerCase();
  if ((REPOSITORY_PROVIDERS as readonly string[]).includes(v)) return v as RepositoryProvider;
  throw new Error(`--provider '${raw}' must be one of: ${REPOSITORY_PROVIDERS.join(", ")}`);
}

/**
 * Register a repository by provider and name and answer with it; the same pair always answers the same id, so it is safe
 * on every run. `created` says whether this call made it (201) or it was already there (200). Never overwrites what is set.
 */
export async function upsertRepository(conn: SpecsConnection, provider: RepositoryProvider, name: string, component = "", attachments?: boolean): Promise<RepositoryRow & { created: boolean }> {
  try {
    const res = await request({ ...headersOf(conn), method: "PUT", path: "/api/v1/repositories", body: { provider, name, ...(component ? { component } : {}), ...(attachments !== undefined ? { attachments_enabled: attachments } : {}) } });
    return { ...(res.data as Envelope<RepositoryRow>).data, created: res.status === 201 };
  } catch (err) {
    if (err instanceof ApiError) throw new Error(`The catalog refused the repository: ${reasonOf(err)}`);
    throw err;
  }
}

/** A repository by provider and name without registering it (for a dry run); null when it is not registered. */
export async function findRepository(conn: SpecsConnection, provider: RepositoryProvider, name: string, component = ""): Promise<RepositoryRow | null> {
  const res = await request({ ...headersOf(conn), method: "GET", path: "/api/v1/repositories" });
  const list = (res.data as Envelope<{ data: RepositoryRow[] }>).data.data;
  return list.find((r) => r.provider === provider && r.name.toLowerCase() === name.toLowerCase() && (r.component ?? "").toLowerCase() === component.toLowerCase()) ?? null;
}

/** The id of the repository a push should tie to: the id given, or the one `--repository` names (registered unless a dry run). */
async function repositoryIdFor(p: PushParams): Promise<string | null | "(new)"> {
  if (p.repositoryId) return p.repositoryId;
  if (!p.repository) return null;
  const provider = p.provider ?? "github";
  if (p.dryRun) return (await findRepository(p.conn, provider, p.repository, p.component))?.id ?? "(new)";
  return (await upsertRepository(p.conn, provider, p.repository, p.component)).id;
}

/**
 * Where the spec to find is: `repositoryId` a repository row, "(new)" a row a dry run has not made yet, null = none was asked; and,
 * when `groupId` is given, the group (an id, null = the specs in no group, "(new)" = a group that does not exist yet). `groupExplicit`
 * says the caller named the group: a name that is missing from the asked group is then a new spec, while with no group named it is
 * an error if the name exists in other groups (nothing is made twice by accident).
 */
export type SpecScope = { repositoryId: string | null; groupId?: string | null; groupExplicit?: boolean; apiVersion?: string };

/** Several specs carry this name (under different repositories) and no repository says which: nothing is picked silently. */
export class AmbiguousSpecError extends Error {}

/**
 * A spec by name, or by id. The same name may exist under different repositories, so a name is looked up inside the repository
 * asked for (`scope.repositoryId`): that row's specs only (a spec with no repository is not adopted by a push that names one).
 * With no repository asked, a spec with no repository wins; otherwise the name must match exactly one spec, or the error names
 * the repositories that hold it and asks for --repository or --id. `scope.apiVersion` is part of the key: only the specs of that API
 * version are looked at, so a name that exists at another API version is not a match (the push then makes the new spec).
 */
export async function findSpec(conn: SpecsConnection, name: string, id?: string, scope?: SpecScope): Promise<SpecRow | null> {
  if (id) {
    try {
      const res = await request({ ...headersOf(conn), method: "GET", path: `/api/v1/specs/${encodeURIComponent(id)}` });
      return (res.data as Envelope<SpecRow>).data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new Error(`No spec with id '${id}' in the catalog (check --id, and --org: the catalog is per owner).`);
      throw err;
    }
  }
  const res = await request({ ...headersOf(conn), method: "GET", path: "/api/v1/specs" });
  const list = (res.data as Envelope<{ data: SpecRow[] }>).data.data;
  const named = list.filter((s) => s.name.toLowerCase() === name.toLowerCase() && (scope?.apiVersion === undefined || sameApiVersion(s.api_version ?? "v1", scope.apiVersion)));
  const grouped = scope?.groupId !== undefined;
  const pool = !grouped ? named : scope!.groupId === "(new)" ? [] : named.filter((s) => (s.group_id ?? null) === scope!.groupId);

  let found: SpecRow | null;
  if (scope?.repositoryId) {
    found = scope.repositoryId === "(new)" ? null : (pool.find((s) => s.repository_id === scope.repositoryId) ?? null);
  } else if (pool.length <= 1) {
    found = pool[0] ?? null;
  } else {
    const without = pool.filter((s) => !s.repository_id);
    if (without.length > 0) found = without[0];
    else {
      const rows = await repositoriesOf(conn);
      const groups = ((await request({ ...headersOf(conn), method: "GET", path: "/api/v1/groups" })).data as Envelope<{ data: { id: string; name: string }[] }>).data.data;
      const where = pool.map((s) => {
        const r = rows.find((x) => x.id === s.repository_id);
        const g = s.group_id ? `group '${groups.find((x) => x.id === s.group_id)?.name ?? s.group_id}'` : "no group";
        return `${g} / ${r ? `${r.provider} ${r.name}${r.component ? ` / ${r.component}` : ""}` : `repository ${s.repository_id}`}`;
      });
      throw new AmbiguousSpecError(`More than one spec is named '${name}' (${where.join("; ")}): say which with --group, --repository [--component], or --id.`);
    }
  }
  if (found || !grouped || scope!.groupExplicit) return found;

  // No group was named and the name is not among the specs in no group: if it exists in groups, say so rather than make a second spec.
  const others = scope?.repositoryId && scope.repositoryId !== "(new)" ? named.filter((s) => s.repository_id === scope.repositoryId) : scope?.repositoryId ? [] : named;
  if (others.length === 0) return null;
  const groups = ((await request({ ...headersOf(conn), method: "GET", path: "/api/v1/groups" })).data as Envelope<{ data: { id: string; name: string }[] }>).data.data;
  const where = others.map((s) => (s.group_id ? `group '${groups.find((g) => g.id === s.group_id)?.name ?? s.group_id}'` : "no group"));
  throw new AmbiguousSpecError(`A spec named '${name}' exists in ${[...new Set(where)].join(", ")}, but not in the specs with no group: pass --group <name> (the group is part of the spec's key; leaving it out means no group) or --id.`);
}

async function repositoriesOf(conn: SpecsConnection): Promise<RepositoryRow[]> {
  return ((await request({ ...headersOf(conn), method: "GET", path: "/api/v1/repositories" })).data as Envelope<{ data: RepositoryRow[] }>).data.data;
}

/** The id of the owner's group of that name, made when there is none. Refuses (with the catalog's reason) at the limit. */
async function groupIdFor(conn: SpecsConnection, name: string, create: boolean): Promise<string | null> {
  const res = await request({ ...headersOf(conn), method: "GET", path: "/api/v1/groups" });
  const groups = (res.data as Envelope<{ data: { id: string; name: string }[] }>).data.data;
  const hit = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  if (!create) return null;
  const made = await request({ ...headersOf(conn), method: "POST", path: "/api/v1/groups", body: { name } });
  return (made.data as Envelope<{ id: string }>).data.id;
}

/**
 * Push a file to the catalog. Whatever the catalog refuses - at the first read as much as at a write (a plan without the
 * catalog is a 403 on the very first call) - comes back with the catalog's own reason, not a bare "403 Forbidden".
 */
export async function pushSpec(p: PushParams): Promise<PushResult> {
  try {
    return await pushSpecInner(p);
  } catch (err) {
    if (err instanceof ApiError) {
      const hint = err.status === 401 ? envTokenHint() : null;
      throw new Error(`The catalog refused the request: ${reasonOf(err)}${hint ? `\n${hint}` : ""}`);
    }
    throw err;
  }
}

async function pushSpecInner(p: PushParams): Promise<PushResult> {
  let text = readSpecFile(p.file);
  let serverUrl: string | undefined;
  let serversEdit: ServersEdit["method"] | undefined;
  if (p.serverUrl !== undefined) {
    serverUrl = checkServerUrl(p.serverUrl);
    const edited = setServers(text, serverUrl);
    text = edited.text;
    serversEdit = edited.method;
  }
  const hash = hashText(text);
  const served = serverUrl ? { server_url: serverUrl, servers_edit: serversEdit } : {};
  const name = specNameFor(text, p.file, p.name);
  const note = p.note !== undefined ? p.note.trim().slice(0, MAX_NOTE) || undefined : undefined;
  // The API version is part of the key: asked for, else the document's own (info.version). A push by id needs neither: the spec has one.
  const explicitVersion = p.apiVersion !== undefined ? checkApiVersion(p.apiVersion) : undefined;
  const apiVersion = explicitVersion ?? apiVersionOf(text) ?? undefined;
  if (!p.id && apiVersion === undefined) {
    throw new Error(`The document's info.version gives no API version (a major such as 1.8.0 -> v1): say which with --api-version <v1|v2|...>, or push to a spec by --id`);
  }

  if (p.rename && !p.id) throw new Error("--rename needs --id: without an id the spec is found by its name, so there is nothing to rename");
  if (p.repositoryId && p.repository) throw new Error("--repository-id and --repository name the same thing: pass one");
  const wanted = await repositoryIdFor(p);
  // The group is part of the key: looked up (not made) now, made only when a new spec is created below.
  const lookedUpGroup = p.id ? undefined : p.group ? ((await groupIdFor(p.conn, p.group, false)) ?? "(new)") : null;
  const scope: SpecScope = { repositoryId: wanted, ...(apiVersion !== undefined ? { apiVersion } : {}), ...(lookedUpGroup !== undefined ? { groupId: lookedUpGroup, groupExplicit: !!p.group } : {}) };
  let existing = await findSpec(p.conn, name, p.id, scope);
  let repositoryId: string | null = existing?.repository_id ?? null;
  let repositoryKept: string | undefined;
  if (existing && wanted && wanted !== "(new)") {
    if (repositoryId === null) {
      // A spec with no repository is tied to it; one tied to another is not moved.
      if (!p.dryRun) {
        try {
          await request({ ...headersOf(p.conn), method: "PATCH", path: `/api/v1/specs/${encodeURIComponent(existing.id)}`, body: { repository_id: wanted } });
        } catch (err) {
          throw new Error(`The catalog refused the repository link: ${reasonOf(err)}`);
        }
      }
      repositoryId = wanted;
    } else if (repositoryId !== wanted) {
      repositoryKept = repositoryId;
    }
  }
  const linked = { repository_id: repositoryId, ...(repositoryKept ? { repository_kept: repositoryKept } : {}), ...served };

  // A rename only on request: a spec named by hand in the catalog is not renamed back to the title on every push.
  let renamedFrom: string | undefined;
  if (existing && p.rename && existing.name !== name) {
    renamedFrom = existing.name;
    if (!p.dryRun) {
      try {
        await request({ ...headersOf(p.conn), method: "PATCH", path: `/api/v1/specs/${encodeURIComponent(existing.id)}`, body: { name } });
      } catch (err) {
        throw new Error(`The catalog refused the new name '${name}': ${reasonOf(err)}`);
      }
    }
    existing = { ...existing, name };
  }
  const renamed = renamedFrom ? { renamed_from: renamedFrom } : {};

  if (existing) {
    // Nothing to upload when the file is already the latest version: the hash settles it without sending the document.
    const versions = await request({ ...headersOf(p.conn), method: "GET", path: `/api/v1/specs/${encodeURIComponent(existing.id)}/versions` });
    const latest = (versions.data as Envelope<{ data: { version: number; content_hash?: string }[] }>).data.data[0];
    if (latest?.content_hash === hash) {
      return { id: existing.id, name: existing.name, version: latest.version, api_version: existing.api_version ?? apiVersion ?? "v1", group_id: existing.group_id, action: "unchanged", content_hash: hash, ...linked, ...renamed };
    }
    if (p.dryRun) return { id: existing.id, name: existing.name, version: existing.latest_version + 1, api_version: existing.api_version ?? apiVersion ?? "v1", group_id: existing.group_id, action: "new_version", content_hash: hash, ...linked, ...renamed };
    try {
      const res = await request({
        ...headersOf(p.conn),
        method: "POST",
        path: `/api/v1/specs/${encodeURIComponent(existing.id)}/versions`,
        body: { content: text, ...(note ? { note } : {}) },
      });
      const version = (res.data as Envelope<{ version: number }>).data.version;
      return { id: existing.id, name: existing.name, version, api_version: existing.api_version ?? apiVersion ?? "v1", group_id: existing.group_id, action: "new_version", content_hash: hash, ...linked, ...renamed };
    } catch (err) {
      // Another job pushed the same document between our comparison and our upload: the catalog says so, and that is the goal.
      if (codeOf(err) === "UNCHANGED") return { id: existing.id, name: existing.name, version: existing.latest_version, api_version: existing.api_version ?? apiVersion ?? "v1", group_id: existing.group_id, action: "unchanged", content_hash: hash, ...linked, ...renamed };
      if (codeOf(err) === "API_VERSION_MISMATCH") {
        throw new Error(`This document belongs to another API version than '${existing.name}' (${existing.api_version ?? "?"}): the catalog keeps one spec per API version. Push it without --id, so the spec for its own API version is found or made. (${reasonOf(err)})`);
      }
      throw new Error(`The catalog refused the new revision: ${reasonOf(err)}`);
    }
  }

  // A new spec. The group is by name and made on the way; none asked = in no group.
  if (p.dryRun) {
    const gid = p.group ? await groupIdFor(p.conn, p.group, false) : null;
    return { id: "(new)", name, version: 1, api_version: apiVersion ?? "v1", group_id: gid, action: "created", content_hash: hash, repository_id: wanted, ...served };
  }
  let groupId: string | null = null;
  try {
    if (p.group) groupId = await groupIdFor(p.conn, p.group, true);
    const res = await request({
      ...headersOf(p.conn),
      method: "POST",
      path: "/api/v1/specs",
      body: {
        name,
        content: text,
        ...(groupId ? { group_id: groupId } : {}),
        ...(explicitVersion ? { api_version: explicitVersion } : {}),
        ...(wanted && wanted !== "(new)" ? { repository_id: wanted } : {}),
        ...(p.description ? { description: p.description } : {}),
      },
    });
    const created = (res.data as Envelope<{ id: string; name: string; group_id: string | null; repository_id?: string | null; api_version?: string }>).data;
    return { id: created.id, name: created.name, version: 1, api_version: created.api_version ?? apiVersion ?? "v1", group_id: created.group_id ?? null, action: "created", content_hash: hash, repository_id: created.repository_id ?? null, ...served };
  } catch (err) {
    if (codeOf(err) === "NAME_TAKEN") {
      // Two jobs creating the same spec: the loser pushes to the winner's.
      const raced = await findSpec(p.conn, name, undefined, { ...scope, groupId: groupId ?? scope.groupId, groupExplicit: true });
      if (raced) return pushSpecInner({ ...p, id: raced.id });
    }
    if (codeOf(err) === "API_VERSION_REQUIRED") {
      throw new Error(`The catalog could not tell this document's API version (its info.version has no major): pass --api-version <v1|v2|...>. (${reasonOf(err)})`);
    }
    throw new Error(`The catalog refused the spec: ${reasonOf(err)}`);
  }
}
