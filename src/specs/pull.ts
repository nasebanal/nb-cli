/**
 * `nb specs pull` / `nb specs versions` - read a document back out of the API catalog (nb-specs-api), the other half of
 * `nb specs push`: a pipeline asks the catalog for a given version of an API's document and works from that (a contract
 * test with Specmatic, a client generator) instead of from a copy that lives in some repository.
 *
 *   - a spec is named by `--id` (what a rename cannot change) or by `--name` (matched ignoring case, like push)
 *   - `--spec-version` is the catalog's version NUMBER (1, 2, 3...: one per `nb specs push` that changed the document),
 *     not the API's URL version (`v1`, `v2`) and not the document's own `info.version`; absent or `latest` = the newest
 *   - the document comes back exactly as it was uploaded (the bytes, not a re-serialised copy), and its SHA-256 is
 *     checked against the `content_hash` the catalog keeps for that version; `--hash` pins what a pipeline expects, so
 *     a version that was swapped, or a name that now points somewhere else, fails instead of testing the wrong thing
 */
import { ApiError, request } from "../http.js";
import { envTokenHint } from "../output.js";
import { findSpec, hashText, headersOf, reasonOf, type Envelope, type SpecRow, type SpecsConnection } from "./push.js";

/** One row of a spec's version list, as the catalog answers it (the documents themselves are not in the list). */
export interface SpecVersion {
  version: number;
  title?: string;
  info_version?: string;
  note?: string;
  size_bytes?: number;
  content_hash?: string;
  created_at?: string;
}

export interface VersionsResult {
  id: string;
  name: string;
  /** Newest first, as the catalog lists them. */
  versions: SpecVersion[];
}

export interface PullParams {
  conn: SpecsConnection;
  /** The spec, by id or by name: one of them. */
  id?: string;
  name?: string;
  /** A catalog version number; absent = the latest. */
  version?: number;
  /** The SHA-256 (hex) the document must have; the pull fails when it does not. */
  hash?: string;
}

export interface PullResult {
  id: string;
  name: string;
  version: number;
  content_hash: string;
  size_bytes: number;
  /** The document exactly as uploaded. */
  text: string;
}

/** `--spec-version`: a positive whole number, or `latest` (or nothing) for the newest. Returns undefined for the newest. */
export function parseVersion(raw: string | undefined): number | undefined {
  const v = raw?.trim();
  if (v === undefined || v === "" || v.toLowerCase() === "latest") return undefined;
  if (/^[1-9]\d{0,8}$/.test(v)) return Number(v);
  throw new Error(`--spec-version '${raw}' must be a version number (1, 2, 3...) or 'latest'. It is the catalog's version, not the API's v1 / v2`);
}

/** `--hash`: 64 hex characters (case does not matter). Returns it lower-cased, or undefined when none was asked. */
export function parseHash(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (v === undefined || v === "") return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  throw new Error(`--hash '${raw}' must be a SHA-256: 64 hexadecimal characters (the content_hash that 'nb specs versions' prints)`);
}

/** Whatever the catalog refuses comes back with its own reason, and the token hint on a 401, not a bare "403 Forbidden". */
async function refusal<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError) {
      const hint = err.status === 401 ? envTokenHint() : null;
      throw new Error(`The catalog refused ${what}: ${reasonOf(err)}${hint ? `\n${hint}` : ""}`);
    }
    throw err;
  }
}

async function resolveSpec(conn: SpecsConnection, id?: string, name?: string): Promise<SpecRow> {
  if (!id && !name?.trim()) throw new Error("Say which spec: --id <id> or --name <name> (the name is the spec's title in the catalog)");
  const spec = await findSpec(conn, name?.trim() ?? "", id);
  if (!spec) {
    throw new Error(`No spec named '${name}' in the catalog (names match ignoring case; check --org: the catalog is per owner, and 'nb specs versions' needs the exact name or the id).`);
  }
  return spec;
}

async function listVersions(conn: SpecsConnection, spec: SpecRow): Promise<SpecVersion[]> {
  const res = await request({ ...headersOf(conn), method: "GET", path: `/api/v1/specs/${encodeURIComponent(spec.id)}/versions` });
  return (res.data as Envelope<{ data: SpecVersion[] }>).data.data;
}

/** The versions of a spec, newest first, each with the SHA-256 of its document (what `--hash` pins). */
export async function specVersions(p: { conn: SpecsConnection; id?: string; name?: string }): Promise<VersionsResult> {
  return refusal("the request", async () => {
    const spec = await resolveSpec(p.conn, p.id, p.name);
    return { id: spec.id, name: spec.name, versions: await listVersions(p.conn, spec) };
  });
}

/** A version's document exactly as uploaded, verified against the catalog's hash (and `--hash`). */
export async function pullSpec(p: PullParams): Promise<PullResult> {
  return refusal("the request", async () => {
    const spec = await resolveSpec(p.conn, p.id, p.name);
    const versions = await listVersions(p.conn, spec);
    if (versions.length === 0) throw new Error(`Spec '${spec.name}' has no versions.`);
    const picked = p.version === undefined ? versions[0] : versions.find((v) => v.version === p.version);
    if (!picked) {
      throw new Error(`Spec '${spec.name}' has no version ${p.version} (it has ${versions.map((v) => v.version).join(", ")}). The version is the catalog's number: 'nb specs versions' lists them.`);
    }

    const res = await request({
      ...headersOf(p.conn),
      method: "GET",
      path: `/api/v1/specs/${encodeURIComponent(spec.id)}/versions/${picked.version}/content`,
      raw: true,
    });
    const text = res.data as string;
    const hash = hashText(text);

    // The catalog keeps the hash of what it stored: a document that does not match it was damaged on the way.
    if (picked.content_hash && hash !== picked.content_hash) {
      throw new Error(`The document of '${spec.name}' v${picked.version} has SHA-256 ${hash}, not the ${picked.content_hash} the catalog lists for it: it did not arrive intact.`);
    }
    // And the one a pipeline pinned: the version, or what the name points at, is no longer what it expected.
    if (p.hash && hash !== p.hash) {
      throw new Error(`The document of '${spec.name}' v${picked.version} has SHA-256 ${hash}, not the ${p.hash} you pinned with --hash: the version was replaced, or the name now points at another spec.`);
    }
    return { id: spec.id, name: spec.name, version: picked.version, content_hash: hash, size_bytes: Buffer.byteLength(text, "utf8"), text };
  });
}
