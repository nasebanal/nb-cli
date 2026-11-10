/**
 * `nb specs specs docs push|pull|delete`: the description document of a spec (Kong Dev Portal style): ONE Markdown file per spec,
 * shown rendered in the catalog beside the API reference. The catalog keeps it as text (`PUT|GET|DELETE /specs/{id}/docs`, at most
 * 200 KiB of UTF-8). The spec is named like everywhere else: `--spec-id`, or `--spec <name>` with the optional `--repository`
 * [`--component`] and `--group` (what is left out means none: a spec in no group, tied to no repository).
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { ApiError, request } from "../http.js";
import { envTokenHint } from "../output.js";
import { headersOf, reasonOf, type Envelope, type SpecsConnection } from "./push.js";
import { locateSpec, type SpecRef } from "./resolve.js";

/** The catalog takes a description document up to this size (200 KiB); the CLI refuses a larger one before sending anything. */
export const MAX_DOCS_BYTES = 200 * 1024;

export interface DocsInfo {
  spec_id: string;
  spec_name: string;
}

export interface DocsPushResult extends DocsInfo {
  size_bytes: number;
  updated_at?: string;
  /** true = the spec had none and this made it; false = it replaced the one it had. */
  created: boolean;
}

/** The Markdown file: it must exist, be a file, be non-empty, at most 200 KiB, valid text (no NUL byte). */
export function readDocsFile(file: string): { text: string; bytes: Buffer } {
  if (!existsSync(file)) throw new Error(`--file: not found: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`--file: ${file} is not a file`);
  if (stat.size === 0) throw new Error(`--file: ${file} is empty`);
  if (stat.size > MAX_DOCS_BYTES) throw new Error(`--file: ${file} is ${(stat.size / 1024).toFixed(0)} KiB, more than the ${MAX_DOCS_BYTES / 1024} KiB the catalog takes for a description document`);
  const bytes = readFileSync(file);
  if (bytes.includes(0)) throw new Error(`--file: ${file} is not a text file (it contains a NUL byte): a description document is Markdown`);
  return { text: bytes.toString("utf8"), bytes };
}

async function catalog<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError) {
      const hint = err.status === 401 ? envTokenHint() : null;
      const reason =
        err.status === 413 ? `the document is larger than ${MAX_DOCS_BYTES / 1024} KiB` : err.status === 415 ? "the catalog takes Markdown only (text/markdown)" : reasonOf(err);
      throw new Error(`The catalog refused ${what}: ${reason}${hint ? `\n${hint}` : ""}`);
    }
    throw err;
  }
}

const pathOf = (id: string) => `/api/v1/specs/${encodeURIComponent(id)}/docs`;

export async function docsPush(p: { conn: SpecsConnection; ref: SpecRef; file: string }): Promise<DocsPushResult> {
  const { bytes } = readDocsFile(p.file);
  return catalog("the description document", async () => {
    const { spec } = await locateSpec(p.conn, p.ref);
    const res = await request({ ...headersOf(p.conn), method: "PUT", path: pathOf(spec.id), rawBody: new Uint8Array(bytes), contentType: "text/markdown; charset=utf-8" });
    const data = (res.data as Envelope<{ size_bytes: number; updated_at?: string }>).data;
    return { spec_id: spec.id, spec_name: spec.name, size_bytes: data?.size_bytes ?? bytes.length, updated_at: data?.updated_at, created: res.status === 201 };
  });
}

export async function docsPull(p: { conn: SpecsConnection; ref: SpecRef }): Promise<DocsInfo & { text: string }> {
  return catalog("the request", async () => {
    const { spec } = await locateSpec(p.conn, p.ref);
    try {
      const res = await request({ ...headersOf(p.conn), method: "GET", path: pathOf(spec.id), headers: { ...headersOf(p.conn).headers, Accept: "text/markdown" }, raw: true });
      return { spec_id: spec.id, spec_name: spec.name, text: res.data as string };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new Error(`The spec '${spec.name}' has no description document (push one with 'nb specs specs docs push --file README.md').`);
      throw err;
    }
  });
}

export async function docsDelete(p: { conn: SpecsConnection; ref: SpecRef }): Promise<DocsInfo> {
  return catalog("the request", async () => {
    const { spec } = await locateSpec(p.conn, p.ref);
    await request({ ...headersOf(p.conn), method: "DELETE", path: pathOf(spec.id) });
    return { spec_id: spec.id, spec_name: spec.name };
  });
}
