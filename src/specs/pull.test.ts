import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parseHash, parseVersion, pullSpec, specVersions } from "./pull.js";
import { hashText } from "./push.js";
import { buildSpecsCommand } from "./command.js";

// The documents of two versions of one spec. V1 is JSON with its own spacing on purpose: a parsed and re-printed copy
// would not have the bytes (or the hash) that were uploaded, and a pull must give the bytes back.
const V1 = '{"openapi":"3.0.3",   "info":{"title":"Billing API","version":"1.0.0"},\n  "paths":{}}\n';
const V2 = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 1.1.0\npaths: {}\n";

let dir: string;
let calls: { method: string; path: string; org: string | null }[];
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-pull-"));
  calls = [];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
  vi.stubEnv("NB_BASE_URL", "");
  vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
  vi.stubEnv("NB_SPECS_ORG", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_OUTPUT", "");
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Doc {
  version: number;
  text: string;
  /** What the catalog lists as this version's hash (default: the real one). */
  listedHash?: string;
  /** What the content endpoint actually sends (default: `text`). */
  body?: string;
  contentType?: string;
}

interface World {
  specs?: { id: string; name: string; group_id: string | null; latest_version: number }[];
  docs?: Doc[];
  fail?: Record<string, { status: number; code: string; message: string }>;
}

const SPEC = { id: "s1", name: "Billing API", group_id: null, latest_version: 2 };
const DOCS: Doc[] = [
  { version: 1, text: V1, contentType: "application/json" },
  { version: 2, text: V2, contentType: "application/yaml" },
];

/** A fake catalog that answers the way nb-specs-api does: envelopes for the metadata, the bare document for the content. */
function catalog(world: World = {}) {
  const specs = world.specs ?? [SPEC];
  const docs = world.docs ?? DOCS;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      const method = String(init.method);
      const headers = init.headers as Record<string, string>;
      calls.push({ method, path: url.pathname, org: headers["X-Active-Organization-Id"] ?? null });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      const failure = world.fail?.[`${method} ${url.pathname}`];
      if (failure) return json(failure.status, { success: false, error: { code: failure.code, message: failure.message } });
      if (url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: specs, total: specs.length, limit: 3 } });
      const one = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)$/);
      if (one) {
        const hit = specs.find((s) => s.id === one[1]);
        return hit ? json(200, { success: true, data: hit }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "Spec not found" } });
      }
      if (url.pathname.endsWith("/versions")) {
        const rows = [...docs].sort((a, b) => b.version - a.version).map((d) => ({ version: d.version, content_hash: d.listedHash ?? hashText(d.text), size_bytes: d.text.length, created_at: "2026-10-27T00:00:00Z" }));
        return json(200, { success: true, data: { data: rows, total: rows.length } });
      }
      const content = url.pathname.match(/\/versions\/(\d+)\/content$/);
      if (content) {
        const d = docs.find((x) => x.version === Number(content[1]));
        return d ? new Response(d.body ?? d.text, { status: 200, headers: { "Content-Type": d.contentType ?? "application/yaml" } }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "Version not found" } });
      }
      return json(500, { success: false, error: { code: "UNEXPECTED", message: `${method} ${url.pathname}` } });
    }),
  );
}

const conn = { baseUrl: "http://specs.test", token: "tkn", org: "personal" };

describe("parseVersion / parseHash", () => {
  it("takes a version number, or nothing / latest for the newest", () => {
    expect(parseVersion(undefined)).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("latest")).toBeUndefined();
    expect(parseVersion(" LATEST ")).toBeUndefined();
    expect(parseVersion("3")).toBe(3);
    expect(parseVersion(" 12 ")).toBe(12);
  });

  it("refuses what is not a version number, and says it is the catalog's version, not the API's", () => {
    for (const bad of ["0", "-1", "1.5", "v2", "abc", "1e3"]) expect(() => parseVersion(bad), bad).toThrow(/catalog's version, not the API's v1 \/ v2/);
  });

  it("takes 64 hex characters, lower-cased, or nothing; refuses the rest", () => {
    const h = hashText(V2);
    expect(parseHash(h.toUpperCase())).toBe(h);
    expect(parseHash(undefined)).toBeUndefined();
    expect(parseHash("")).toBeUndefined();
    expect(() => parseHash("abc123")).toThrow(/SHA-256: 64 hexadecimal/);
    expect(() => parseHash("z".repeat(64))).toThrow(/SHA-256/);
  });
});

describe("pullSpec", () => {
  it("gives the latest version of a spec found by name (ignoring case), with its hash", async () => {
    catalog();
    const r = await pullSpec({ conn, name: "billing api" });
    expect(r).toMatchObject({ id: "s1", name: "Billing API", version: 2, text: V2, content_hash: hashText(V2), size_bytes: V2.length });
  });

  it("gives a given version by id, and the document is exactly the bytes that were uploaded even when it is JSON", async () => {
    catalog();
    const r = await pullSpec({ conn, id: "s1", version: 1 });
    expect(r.version).toBe(1);
    expect(r.text).toBe(V1); // not JSON.parse'd and re-printed
    expect(r.content_hash).toBe(hashText(V1));
  });

  it("sends the organization with every call, and asks for the content of the version it chose", async () => {
    catalog();
    await pullSpec({ conn: { ...conn, org: "42" }, name: "Billing API", version: 1 });
    expect(calls.every((c) => c.org === "42")).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/specs", "GET /api/v1/specs/s1/versions", "GET /api/v1/specs/s1/versions/1/content"]);
  });

  it("says which versions exist when the asked one does not", async () => {
    catalog();
    await expect(pullSpec({ conn, id: "s1", version: 7 })).rejects.toThrow(/has no version 7 \(it has 2, 1\)/);
  });

  it("needs a spec to be named, and says so before anything is sent", async () => {
    catalog();
    await expect(pullSpec({ conn })).rejects.toThrow(/--id <id> or --name <name>/);
    expect(calls).toHaveLength(0);
  });

  it("says when there is no such spec, pointing at the catalog being per owner", async () => {
    catalog();
    await expect(pullSpec({ conn, name: "Nope" })).rejects.toThrow(/No spec named 'Nope'.*per owner/);
    await expect(pullSpec({ conn, id: "zzz" })).rejects.toThrow(/No spec with id 'zzz'/);
  });

  it("says when a spec has no versions", async () => {
    catalog({ docs: [] });
    await expect(pullSpec({ conn, id: "s1" })).rejects.toThrow(/has no versions/);
  });

  it("refuses a document whose hash is not the one the catalog lists for that version", async () => {
    catalog({ docs: [{ version: 1, text: V2, listedHash: hashText(V1) }] });
    await expect(pullSpec({ conn, id: "s1" })).rejects.toThrow(/did not arrive intact/);
  });

  it("holds a pipeline to the hash it pinned: same document passes, another one fails", async () => {
    catalog();
    await expect(pullSpec({ conn, id: "s1", version: 2, hash: hashText(V2) })).resolves.toMatchObject({ version: 2 });
    await expect(pullSpec({ conn, id: "s1", version: 2, hash: hashText(V1) })).rejects.toThrow(/not the .* you pinned with --hash/);
  });

  it("carries the catalog's own reason when it refuses, not a bare status", async () => {
    catalog({ fail: { "GET /api/v1/specs": { status: 403, code: "ENTERPRISE_REQUIRED", message: "Specs need an Enterprise plan for organizations" } } });
    await expect(pullSpec({ conn, name: "Billing API" })).rejects.toThrow(/The catalog refused the request: Specs need an Enterprise plan/);
  });
});

describe("specVersions", () => {
  it("lists the versions newest first, with the hash of each document", async () => {
    catalog();
    const r = await specVersions({ conn, name: "Billing API" });
    expect(r.id).toBe("s1");
    expect(r.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(r.versions[0].content_hash).toBe(hashText(V2));
    expect(r.versions[1].content_hash).toBe(hashText(V1));
  });
});

describe("nb specs pull / versions", () => {
  const run = async (sub: "pull" | "versions", args: string[]) => {
    // The root has -V, --version like the real `nb`: a subcommand option of that name would be swallowed by it.
    const program = new Command().exitOverride().version("0.0.0").option("--env <env>").option("--token <token>");
    program.addCommand(buildSpecsCommand());
    program.commands.forEach((c) => {
      c.exitOverride();
      c.commands.forEach((cc) => cc.exitOverride());
    });
    await program.parseAsync(["node", "nb", "--token", "tkn", "specs", sub, ...args]);
  };

  it("writes the document to --out, prints the details as JSON, and tells later steps which spec, version and hash", async () => {
    catalog();
    const out = join(dir, "spec.json");
    const gh = join(dir, "gh-output");
    writeFileSync(gh, "");
    vi.stubEnv("GITHUB_OUTPUT", gh);
    await run("pull", ["--name", "Billing API", "--spec-version", "1", "--out", out]);
    expect(readFileSync(out, "utf8")).toBe(V1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ id: "s1", version: 1, content_hash: hashText(V1), out });
    expect(stdout.join("")).not.toContain("Billing API\",\"version\""); // the document itself is not in the JSON
    expect(stderr.join("")).toContain("✓ Billing API v1 (sha256 ");
    expect(readFileSync(gh, "utf8")).toBe(`spec_id=s1\nspec_version=1\nspec_hash=${hashText(V1)}\n`);
  });

  it("without --out the document is the whole of standard output (it can be piped), the details go to standard error", async () => {
    catalog();
    await run("pull", ["--id", "s1"]);
    expect(stdout.join("")).toBe(V2);
    expect(stderr.join("")).toContain("✓ Billing API v2");
  });

  it("takes --version latest, and fails with exit-worthy errors for a bad --version / --hash before anything is sent", async () => {
    catalog();
    await run("pull", ["--id", "s1", "--spec-version", "latest"]);
    expect(stdout.join("")).toBe(V2);
    calls.length = 0;
    await expect(run("pull", ["--id", "s1", "--spec-version", "v2"])).rejects.toThrow(/catalog's version/);
    await expect(run("pull", ["--id", "s1", "--hash", "nope"])).rejects.toThrow(/SHA-256/);
    expect(calls).toHaveLength(0);
  });

  it("fails when the pinned hash does not match, and leaves no --out file behind", async () => {
    catalog();
    const out = join(dir, "never.yaml");
    await expect(run("pull", ["--id", "s1", "--hash", hashText(V1), "--out", out])).rejects.toThrow(/you pinned with --hash/);
    expect(() => readFileSync(out)).toThrow();
  });

  it("says when --out cannot be written", async () => {
    catalog();
    await expect(run("pull", ["--id", "s1", "--out", join(dir, "no-such-dir", "spec.yaml")])).rejects.toThrow(/--out: cannot write/);
  });

  it("lists versions as JSON with a one-line summary", async () => {
    catalog();
    await run("versions", ["--name", "Billing API"]);
    const printed = JSON.parse(stdout.join(""));
    expect(printed.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(stderr.join("")).toContain("✓ Billing API: 2 versions (latest v2)");
  });

  it("refuses an organization that is not an id before anything is sent", async () => {
    catalog();
    await expect(run("pull", ["--id", "s1", "--org", "acme"])).rejects.toThrow(/organization id/);
    expect(calls).toHaveLength(0);
  });

  it("is listed under `nb specs`, next to push", () => {
    expect(buildSpecsCommand().commands.map((c) => c.name()).sort()).toEqual(["pull", "push", "versions"]);
  });
});
