import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { docsDelete, docsPull, docsPush, MAX_DOCS_BYTES, readDocsFile } from "./docs.js";
import { buildDocsCommand } from "./command.js";

const conn = { baseUrl: "http://specs.test", token: "tkn", org: "personal" };
const GROUPS = [{ id: "g-prod", name: "Production" }];
const REPOSITORIES = [{ id: "r1", provider: "github", name: "acme/api", component: "" }];
const SPECS = [
  { id: "s-prod", name: "Account API", group_id: "g-prod", repository_id: "r1" },
  { id: "s-loose", name: "Hand Made", group_id: null, repository_id: null },
];

let dir: string;
let calls: { method: string; path: string; contentType?: string; accept?: string; body?: string }[];
let stdout: string[];
let stderr: string[];
let docs: Map<string, string>;
let refuse: { status: number; code: string } | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-docs-"));
  calls = [];
  stdout = [];
  stderr = [];
  docs = new Map();
  refuse = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
  vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
  vi.stubEnv("NB_SPEC_ID", "");
  vi.stubEnv("NB_SPECS_ORG", "");
  vi.stubEnv("GITHUB_OUTPUT", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      const headers = init.headers as Record<string, string>;
      calls.push({ method: String(init.method), path: url.pathname, contentType: headers["Content-Type"], accept: headers.Accept, body: init.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : undefined });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url.pathname === "/api/v1/groups") return json(200, { success: true, data: { data: GROUPS } });
      if (url.pathname === "/api/v1/repositories") return json(200, { success: true, data: { data: REPOSITORIES } });
      if (url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: SPECS } });
      const spec = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)$/);
      if (spec) {
        const hit = SPECS.find((s) => s.id === spec[1]);
        return hit ? json(200, { success: true, data: hit }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "no" } });
      }
      const repo = url.pathname.match(/^\/api\/v1\/repositories\/([^/]+)$/);
      if (repo) return json(200, { success: true, data: REPOSITORIES.find((r) => r.id === repo[1]) });
      const doc = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)\/docs$/);
      if (doc) {
        if (refuse) return json(refuse.status, { success: false, error: { code: refuse.code, message: "refused" } });
        const id = doc[1];
        if (init.method === "PUT") {
          const created = !docs.has(id);
          docs.set(id, Buffer.from(init.body as Uint8Array).toString("utf8"));
          return json(created ? 201 : 200, { success: true, data: { size_bytes: docs.get(id)!.length, updated_at: "2026-11-10T00:00:00Z" } });
        }
        if (init.method === "GET") return docs.has(id) ? new Response(docs.get(id), { status: 200, headers: { "Content-Type": "text/markdown" } }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "no docs" } });
        if (init.method === "DELETE") {
          docs.delete(id);
          return new Response(null, { status: 204 });
        }
      }
      return json(500, { success: false, error: { code: "UNEXPECTED", message: url.pathname } });
    }),
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const md = (text = "# Account API\n\nHello.\n") => {
  const f = join(dir, "README.md");
  writeFileSync(f, text);
  return f;
};

describe("readDocsFile", () => {
  it("takes a Markdown text file, and refuses a missing, empty, too large or binary one before anything is sent", () => {
    expect(readDocsFile(md()).text).toContain("Hello.");
    expect(() => readDocsFile(join(dir, "nope.md"))).toThrow(/not found/);
    expect(() => readDocsFile(md(""))).toThrow(/empty/);
    expect(() => readDocsFile(md("x".repeat(MAX_DOCS_BYTES + 1)))).toThrow(/200 KiB/);
    expect(() => readDocsFile(md("a\u0000b"))).toThrow(/NUL byte/);
  });
});

describe("docs push / pull / delete", () => {
  it("pushes the file as text/markdown to the spec's docs, found by its key (group and repository), and says whether it was added or replaced", async () => {
    const first = await docsPush({ conn, ref: { spec: "Account API", repository: "acme/api", group: "Production" }, file: md() });
    expect(first).toMatchObject({ spec_id: "s-prod", created: true });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/v1/specs/s-prod/docs");
    expect(put.contentType).toBe("text/markdown; charset=utf-8");
    expect(put.body).toContain("# Account API");
    expect((await docsPush({ conn, ref: { specId: "s-prod" }, file: md("# v2\n") })).created).toBe(false);
  });

  it("works on a spec with no repository and no group when none is named", async () => {
    expect((await docsPush({ conn, ref: { spec: "Hand Made" }, file: md() })).spec_id).toBe("s-loose");
  });

  it("pulls it back as asked for (Accept: text/markdown) and says so when there is none", async () => {
    await expect(docsPull({ conn, ref: { specId: "s-prod" } })).rejects.toThrow(/has no description document/);
    await docsPush({ conn, ref: { specId: "s-prod" }, file: md("# Hi\n") });
    const out = await docsPull({ conn, ref: { specId: "s-prod" } });
    expect(out.text).toBe("# Hi\n");
    expect(calls.filter((c) => c.method === "GET" && c.path.endsWith("/docs")).at(-1)!.accept).toBe("text/markdown");
  });

  it("deletes it, also when there is none", async () => {
    await docsPush({ conn, ref: { specId: "s-prod" }, file: md() });
    await docsDelete({ conn, ref: { specId: "s-prod" } });
    expect(docs.has("s-prod")).toBe(false);
    await expect(docsDelete({ conn, ref: { specId: "s-prod" } })).resolves.toMatchObject({ spec_id: "s-prod" });
  });

  it("explains the catalog's 413 and 415, and names where a spec is when the key misses", async () => {
    refuse = { status: 413, code: "TOO_LARGE" };
    await expect(docsPush({ conn, ref: { specId: "s-prod" }, file: md() })).rejects.toThrow(/larger than 200 KiB/);
    refuse = { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" };
    await expect(docsPush({ conn, ref: { specId: "s-prod" }, file: md() })).rejects.toThrow(/Markdown only/);
    await expect(docsPush({ conn, ref: { spec: "Account API" }, file: md() })).rejects.toThrow(/No spec named 'Account API' in no group \/ no repository.*group 'Production'/s);
  });
});

describe("the docs command tree", () => {
  const run = (...args: string[]) => {
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>");
    program.addCommand(buildDocsCommand().exitOverride());
    return program.parseAsync(["node", "nb", "--token", "tkn", "docs", ...args]);
  };

  it("pushes with --spec-id, defaults to $NB_SPEC_ID, and refuses an id together with names or nothing at all", async () => {
    await run("push", "--file", md(), "--spec-id", "s-prod");
    expect(calls.find((c) => c.method === "PUT")!.path).toBe("/api/v1/specs/s-prod/docs");
    expect(stderr.join("")).toContain("description document added");
    calls.length = 0;
    vi.stubEnv("NB_SPEC_ID", "s-loose");
    await run("push", "--file", md());
    expect(calls.find((c) => c.method === "PUT")!.path).toBe("/api/v1/specs/s-loose/docs");
    vi.stubEnv("NB_SPEC_ID", "");
    await expect(run("push", "--file", md())).rejects.toThrow(/Say which spec/);
    await expect(run("push", "--file", md(), "--spec-id", "s-prod", "--spec", "x")).rejects.toThrow(/do not combine/);
  });

  it("pulls to standard output, or to a file with --out", async () => {
    await run("push", "--file", md("# Out\n"), "--spec-id", "s-prod");
    stdout.length = 0;
    await run("pull", "--spec-id", "s-prod");
    expect(stdout.join("")).toBe("# Out\n");
    const out = join(dir, "pulled.md");
    await run("pull", "--spec-id", "s-prod", "--out", out);
    expect(readFileSync(out, "utf8")).toBe("# Out\n");
  });
});
