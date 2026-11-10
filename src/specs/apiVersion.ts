/**
 * The API version of a spec (`v1`, `v2`): a property of the SPEC, not of a revision. A new major API version is a new spec; inside
 * a spec the numbered history is the REVISION (what the catalog calls `version`, and this CLI calls a revision).
 *
 * The same derivation as nb-specs-api's `apiVersionOf`, so `nb specs specs push` knows before sending which spec a document
 * belongs to: the document's `info.version`, trimmed, must match `^[vV]?(\d{1,3})(\.\d+){0,2}([-+][0-9A-Za-z.+-]*)?$`, and the
 * API version is `v<major>` with leading zeros dropped. `1.8.0` -> `v1`, `v2.0` -> `v2`, `1.0.0-rc.1` -> `v1`, `007.1` -> `v7`;
 * `2023-01`, `2023.1`, `latest` and `1.x` have no major (they need `--api-version`).
 */
import { parse } from "yaml";

const MAJOR = /^[vV]?(\d{1,3})(\.\d+){0,2}([-+][0-9A-Za-z.+-]*)?$/;

/** The API version an `info.version` gives, or null when it has no major. */
export function apiVersionFromInfoVersion(infoVersion: string): string | null {
  const m = MAJOR.exec(infoVersion.trim());
  return m ? `v${Number(m[1])}` : null;
}

/** The API version a document's `info.version` gives, or null (not parseable, no `info.version`, or no major in it). */
export function apiVersionOf(text: string): string | null {
  try {
    const doc = parse(text) as { info?: { version?: unknown } } | null;
    const v = doc?.info?.version;
    // YAML reads `version: 1.0` as the number 1: the text the author wrote is what the server reads, so a number is its plain text.
    return typeof v === "string" || typeof v === "number" ? apiVersionFromInfoVersion(String(v)) : null;
  } catch {
    return null;
  }
}

const LABEL = /^[A-Za-z0-9._-]{1,32}$/;

/** `--api-version`: the same label rule as the catalog (letters, digits, '.', '_', '-', up to 32). Returned trimmed. */
export function checkApiVersion(raw: string): string {
  const v = raw.trim();
  if (!LABEL.test(v)) throw new Error(`--api-version '${raw}' must be a version label: letters, digits, '.', '_' and '-' (up to 32), e.g. v1 or v2`);
  return v;
}

/** Whether two API versions are the same one (the catalog compares them ignoring case). */
export const sameApiVersion = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
