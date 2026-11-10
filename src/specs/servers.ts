/**
 * `nb specs specs push --server-url <url>`: the document a pipeline keeps in its repository is ONE file per API; what differs
 * between environments is where the API is served, which is the document's top-level `servers`. The push replaces `servers`
 * with `[{ url }]` just before it sends the document, so each environment's spec (a spec per environment, filed in a group)
 * carries its own URL. The catalog's contract hash ignores `servers`, so this does not change the contract's identity.
 *
 * How the document is edited:
 *   - JSON input: parsed, `servers` set, written back as JSON (2-space indent).
 *   - YAML input: a TEXT edit of the top-level `servers` block (or one inserted before `paths:`), so comments and the order of
 *     everything else stay as they are. The result is parsed and compared with the original (everything but `servers` must be
 *     identical); if the edit cannot be proven safe the document is re-serialised instead (comments are lost) and the method
 *     says so.
 */
import { parse, stringify } from "yaml";

export interface ServersEdit {
  text: string;
  /** How it was done: `json`, `text` (comments and order kept) or `reserialised` (YAML written again: comments lost). */
  method: "json" | "text" | "reserialised";
}

/** `--server-url`: an absolute http(s) URL (no trailing slash needed). */
export function checkServerUrl(raw: string): string {
  const v = raw.trim();
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`--server-url '${raw}' is not a URL (e.g. https://api.example.com/v1)`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`--server-url must be an http(s) URL, got '${raw}'`);
  return v;
}

const withoutServers = (doc: unknown): string => {
  const { servers: _servers, ...rest } = (doc ?? {}) as Record<string, unknown>;
  void _servers;
  return JSON.stringify(rest);
};

/** Set the document's top-level `servers` to `[{ url }]`. */
export function setServers(text: string, url: string): ServersEdit {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("--server-url: the file looks like JSON but does not parse");
    }
    return { text: `${JSON.stringify({ ...doc, servers: [{ url }] }, null, 2)}\n`, method: "json" };
  }

  let original: unknown;
  try {
    original = parse(text);
  } catch (err) {
    throw new Error(`--server-url: the file is not valid YAML or JSON: ${(err as Error).message}`);
  }
  if (original === null || typeof original !== "object" || Array.isArray(original)) throw new Error("--server-url: the document is not an OpenAPI object");

  const block = `servers:\n  - url: ${JSON.stringify(url)}`;
  const lines = text.split("\n");
  const isTopKey = (l: string) => /^[^\s#\-][^\n]*$/.test(l) && !/^---\s*$/.test(l) && !/^\.\.\.\s*$/.test(l);
  const start = lines.findIndex((l) => /^servers\s*:/.test(l));
  let edited: string | null = null;
  if (start >= 0) {
    let end = start + 1;
    // The block runs to the next top-level key; comment lines and blank lines after the last item stay with what follows it.
    while (end < lines.length && !isTopKey(lines[end])) end++;
    let tail = end;
    while (tail > start + 1 && (lines[tail - 1].trim() === "" || lines[tail - 1].trimStart().startsWith("#"))) tail--;
    edited = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(tail)].join("\n");
  } else {
    const paths = lines.findIndex((l) => /^paths\s*:/.test(l));
    if (paths >= 0) edited = [...lines.slice(0, paths), ...block.split("\n"), ...lines.slice(paths)].join("\n");
    else edited = `${text.endsWith("\n") ? text : `${text}\n`}${block}\n`;
  }

  try {
    const after = parse(edited) as { servers?: unknown } | null;
    const ok = JSON.stringify(after?.servers) === JSON.stringify([{ url }]) && withoutServers(after) === withoutServers(original);
    if (ok) return { text: edited, method: "text" };
  } catch {
    /* fall through to re-serialising */
  }
  return { text: stringify({ ...(original as Record<string, unknown>), servers: [{ url }] }), method: "reserialised" };
}
