/**
 * `nb specs push` - register an OpenAPI document in the API catalog (nb-specs-api) from a file, the way a pipeline
 * wants it: no group has to exist, nothing is uploaded when the file is already the latest version, and running it on
 * every commit is safe.
 *
 *   - the spec is found by name (or by `--id`); new -> created with its first version, known -> a new version
 *   - the document's SHA-256 is compared with the latest version's `content_hash` BEFORE anything is sent: the same
 *     bytes mean "unchanged", and the 2 MiB stay where they are. (The server refuses an identical upload with
 *     409 UNCHANGED too; that is treated as "unchanged", for two jobs racing.)
 *   - a group is optional: `--group <name>` files a NEW spec in that group (made when missing); a spec that already
 *     exists is never moved by a push (moving is the catalog's job).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { parse } from "yaml";
import { ApiError, request } from "../http.js";
import type { Environment } from "../config.js";
import type { CiInfo } from "../reports/ci.js";
import { envTokenHint } from "../output.js";

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

export interface PushResult {
  id: string;
  name: string;
  /** The version the spec is at after the push (the latest). */
  version: number;
  /** null = in no group. */
  group_id: string | null;
  action: PushAction;
  content_hash: string;
  /** Set when the push renamed the spec (or, in a dry run, would): the name it had. */
  renamed_from?: string;
}

export interface PushParams {
  conn: SpecsConnection;
  file: string;
  /** Default: the document's `info.title`, then the file's name. */
  name?: string;
  /** The group a NEW spec is filed in (by name; made when missing). Absent = no group. */
  group?: string;
  description?: string;
  /** What changed, shown in the version list. */
  note?: string;
  /** Push to this spec by id: a rename of the spec cannot make a second one. */
  id?: string;
  /** With `id`: also rename the spec to `name` (default: the document's `info.title`) when it is called something else. */
  rename?: boolean;
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
  latest_version: number;
}

export async function findSpec(conn: SpecsConnection, name: string, id?: string): Promise<SpecRow | null> {
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
  return list.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? null;
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
  const text = readSpecFile(p.file);
  const hash = hashText(text);
  const name = specNameFor(text, p.file, p.name);
  const note = p.note !== undefined ? p.note.trim().slice(0, MAX_NOTE) || undefined : undefined;

  if (p.rename && !p.id) throw new Error("--rename needs --id: without an id the spec is found by its name, so there is nothing to rename");
  let existing = await findSpec(p.conn, name, p.id);

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
      return { id: existing.id, name: existing.name, version: latest.version, group_id: existing.group_id, action: "unchanged", content_hash: hash, ...renamed };
    }
    if (p.dryRun) return { id: existing.id, name: existing.name, version: existing.latest_version + 1, group_id: existing.group_id, action: "new_version", content_hash: hash, ...renamed };
    try {
      const res = await request({
        ...headersOf(p.conn),
        method: "POST",
        path: `/api/v1/specs/${encodeURIComponent(existing.id)}/versions`,
        body: { content: text, ...(note ? { note } : {}) },
      });
      const version = (res.data as Envelope<{ version: number }>).data.version;
      return { id: existing.id, name: existing.name, version, group_id: existing.group_id, action: "new_version", content_hash: hash, ...renamed };
    } catch (err) {
      // Another job pushed the same document between our comparison and our upload: the catalog says so, and that is the goal.
      if (codeOf(err) === "UNCHANGED") return { id: existing.id, name: existing.name, version: existing.latest_version, group_id: existing.group_id, action: "unchanged", content_hash: hash, ...renamed };
      throw new Error(`The catalog refused the new version: ${reasonOf(err)}`);
    }
  }

  // A new spec. The group is by name and made on the way; none asked = in no group.
  if (p.dryRun) {
    const gid = p.group ? await groupIdFor(p.conn, p.group, false) : null;
    return { id: "(new)", name, version: 1, group_id: gid, action: "created", content_hash: hash };
  }
  let groupId: string | null = null;
  try {
    if (p.group) groupId = await groupIdFor(p.conn, p.group, true);
    const res = await request({
      ...headersOf(p.conn),
      method: "POST",
      path: "/api/v1/specs",
      body: { name, content: text, ...(groupId ? { group_id: groupId } : {}), ...(p.description ? { description: p.description } : {}) },
    });
    const created = (res.data as Envelope<{ id: string; name: string; group_id: string | null }>).data;
    return { id: created.id, name: created.name, version: 1, group_id: created.group_id ?? null, action: "created", content_hash: hash };
  } catch (err) {
    if (codeOf(err) === "NAME_TAKEN") {
      // Two jobs creating the same spec: the loser pushes to the winner's.
      const raced = await findSpec(p.conn, name);
      if (raced) return pushSpecInner({ ...p, id: raced.id });
    }
    throw new Error(`The catalog refused the spec: ${reasonOf(err)}`);
  }
}
