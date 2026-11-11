import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { checkOrg, checkProvider, ciNote, hashText, MAX_SPEC_BYTES, pushSpec, readSpecFile, specNameFor, specsBaseUrl, titleOf, upsertRepository } from "./push.js";
import { attachSpecsCommands, buildSpecsCommand } from "./command.js";

const DOC = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 1.0.0\npaths: {}\n";
const DOC_V2 = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 1.1.0\npaths: {}\n";

let dir: string;
let calls: { method: string; path: string; org: string | null; body: any }[];
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-specs-"));
  calls = [];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
  vi.stubEnv("NB_BASE_URL", "");
  vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
  vi.stubEnv("NB_SPECS_ORG", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITLAB_CI", "");
  vi.stubEnv("GITHUB_OUTPUT", "");
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const file = (text = DOC, name = "openapi.yaml") => {
  const f = join(dir, name);
  writeFileSync(f, text);
  return f;
};

interface World {
  specs?: { id: string; name: string; group_id: string | null; repository_id?: string | null; latest_version: number; hash?: string; api_version?: string; initial_spec_id?: string | null }[];
  groups?: { id: string; name: string }[];
  repositories?: { id: string; provider: string; name: string; component?: string }[];
  /** Responses that replace the default for a request, by `METHOD path`. */
  fail?: Record<string, { status: number; code: string; message: string }>;
}

/** A fake catalog: lists, versions with hashes, and the writes, all recorded in `calls`. */
function catalog(world: World = {}) {
  const specs = world.specs ?? [];
  const groups = world.groups ?? [];
  const repositories = world.repositories ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      const method = String(init.method);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const headers = init.headers as Record<string, string>;
      calls.push({ method, path: url.pathname, org: headers["X-Active-Organization-Id"] ?? null, body });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      const failure = world.fail?.[`${method} ${url.pathname}`];
      if (failure) return json(failure.status, { success: false, error: { code: failure.code, message: failure.message } });
      if (method === "GET" && url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: specs, total: specs.length, limit: 3 } });
      const one = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)$/);
      if (method === "GET" && one) {
        const hit = specs.find((s) => s.id === one[1]);
        return hit ? json(200, { success: true, data: hit }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "Spec not found" } });
      }
      if (method === "PATCH" && one) return json(200, { success: true, data: { id: one[1], name: body.name } });
      const versions = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)\/versions$/);
      if (versions && method === "GET") {
        const hit = specs.find((s) => s.id === versions[1])!;
        return json(200, { success: true, data: { data: [{ version: hit.latest_version, content_hash: hit.hash }], total: 1 } });
      }
      if (versions && method === "POST") {
        // like the API: a document of another major than the spec's API version is refused
        const spec = specs.find((s) => s.id === versions[1])!;
        const major = /version:\s*v?(\d+)/.exec(String(body.content))?.[1];
        if (major && `v${Number(major)}` !== (spec.api_version ?? "v1")) return json(409, { success: false, error: { code: "API_VERSION_MISMATCH", message: `This document is API version v${Number(major)}, the spec is ${spec.api_version ?? "v1"}` } });
        return json(201, { success: true, data: { version: spec.latest_version + 1 } });
      }
      if (method === "GET" && url.pathname === "/api/v1/groups") return json(200, { success: true, data: { data: groups, total: groups.length, limit: 10 } });
      if (method === "POST" && url.pathname === "/api/v1/groups") return json(201, { success: true, data: { id: "newgroup", name: body.name } });
      if (url.pathname === "/api/v1/repositories" && method === "GET") return json(200, { success: true, data: { data: repositories, total: repositories.length, limit: 100 } });
      if (url.pathname === "/api/v1/repositories" && method === "PUT") {
        const hit = repositories.find((r) => r.provider === body.provider && r.name.toLowerCase() === body.name.toLowerCase() && (r.component ?? "") === (body.component ?? ""));
        if (hit) return json(200, { success: true, data: hit });
        const made = { id: "newrepo", provider: body.provider, name: body.name, component: body.component ?? "" };
        repositories.push(made);
        return json(201, { success: true, data: made });
      }
      if (method === "POST" && url.pathname === "/api/v1/specs") {
        const major = /version:\s*v?(\d+)/.exec(String(body.content))?.[1];
        const api_version = body.api_version ?? (major ? `v${Number(major)}` : undefined);
        if (!api_version) return json(400, { success: false, error: { code: "API_VERSION_REQUIRED", message: "info.version has no major: pass api_version" } });
        return json(201, { success: true, data: { id: "newspec", name: body.name, group_id: body.group_id ?? null, repository_id: body.repository_id ?? null, api_version } });
      }
      return json(500, { success: false, error: { code: "UNEXPECTED", message: `${method} ${url.pathname}` } });
    }),
  );
}

const conn = { baseUrl: "http://specs.test", token: "tkn", org: "personal" };

describe("pushSpec: a new spec", () => {
  it("registers it in no group when none is named, under the document's title, and creates nothing else", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file() });
    expect(r).toMatchObject({ id: "newspec", name: "Billing API", version: 1, group_id: null, action: "created", content_hash: hashText(DOC) });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/specs", "POST /api/v1/specs"]);
    expect(calls[1].body).toEqual({ name: "Billing API", content: DOC });
    expect(calls[1].body).not.toHaveProperty("group_id");
  });

  it("files it in a group named, which already exists, without making another", async () => {
    catalog({ groups: [{ id: "g1", name: "Billing" }] });
    const r = await pushSpec({ conn, file: file(), group: "billing" });
    expect(r.group_id).toBe("g1");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/groups")).toBe(false);
    expect(calls.at(-1)!.body).toMatchObject({ group_id: "g1" });
  });

  it("makes the group when there is none of that name", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file(), group: "Billing" });
    // The group is looked up first (it is part of the key), then made on the way to creating the spec.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/groups", "GET /api/v1/specs", "GET /api/v1/groups", "POST /api/v1/groups", "POST /api/v1/specs"]);
    expect(r.group_id).toBe("newgroup");
  });

  it("takes the name asked for, then the title, then the file's name", async () => {
    catalog();
    expect((await pushSpec({ conn, file: file(), name: "My Billing" })).name).toBe("My Billing");
    expect(specNameFor("not: [valid", "dir/payments-api.yaml")).toBe("payments-api");
    expect(specNameFor("openapi: 3.0.3\ninfo:\n  version: 1\n", "x/payments.yml")).toBe("payments");
    expect(titleOf("{\"info\":{\"title\":\" T \"}}")).toBe("T");
    expect(titleOf("::: not yaml :::")).toBeNull();
    expect(specNameFor("x", "f.yaml", "a".repeat(150))).toHaveLength(100);
  });

  it("sends the description with the first version, and the organization on every call", async () => {
    catalog();
    await pushSpec({ conn: { ...conn, org: "7" }, file: file(), description: "About it" });
    expect(calls.every((c) => c.org === "7")).toBe(true);
    expect(calls.at(-1)!.body.description).toBe("About it");
  });

  it("explains the catalog's refusal: the plan's limit, an invalid document", async () => {
    catalog({ fail: { "POST /api/v1/specs": { status: 409, code: "LIMIT_REACHED", message: "A personal account can hold 3 specs" } } });
    await expect(pushSpec({ conn, file: file() })).rejects.toThrow(/The catalog refused the spec: A personal account can hold 3 specs/);
    catalog({ fail: { "POST /api/v1/specs": { status: 422, code: "INVALID_SPEC", message: "not an OpenAPI document" } } });
    // a document with no info.version needs --api-version (the API version is part of the spec's key)
    await expect(pushSpec({ conn, file: file("nonsense") })).rejects.toThrow(/gives no API version.*--api-version/s);
    await expect(pushSpec({ conn, file: file("nonsense"), apiVersion: "v1" })).rejects.toThrow(/not an OpenAPI document/);
  });

  it("when two jobs create the same spec, the one that lost pushes to the winner's", async () => {
    // The first lookup finds nothing, the create says the name is taken, the second lookup finds it.
    let lookups = 0;
    const real = { id: "won", name: "Billing API", group_id: null, latest_version: 1, hash: hashText(DOC) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const url = new URL(String(input));
        const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        calls.push({ method: String(init.method), path: url.pathname, org: null, body: undefined });
        if (init.method === "GET" && url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: lookups++ === 0 ? [] : [real], total: 1, limit: 3 } });
        if (init.method === "POST" && url.pathname === "/api/v1/specs") return json(409, { success: false, error: { code: "NAME_TAKEN", message: "exists" } });
        if (init.method === "GET" && url.pathname === "/api/v1/specs/won") return json(200, { success: true, data: real });
        if (init.method === "GET" && url.pathname === "/api/v1/specs/won/versions") return json(200, { success: true, data: { data: [{ version: 1, content_hash: real.hash }], total: 1 } });
        return json(500, { success: false, error: { code: "X", message: "unexpected" } });
      }),
    );
    const r = await pushSpec({ conn, file: file() });
    expect(r).toMatchObject({ id: "won", action: "unchanged" });
  });
});

describe("pushSpec: what the catalog refuses on the way", () => {
  it("gives the catalog's own reason when even the first read is refused (a plan without the catalog)", async () => {
    catalog({ fail: { "GET /api/v1/specs": { status: 403, code: "ENTERPRISE_REQUIRED", message: "An active Enterprise subscription is required" } } });
    await expect(pushSpec({ conn, file: file() })).rejects.toThrow("The catalog refused the request: An active Enterprise subscription is required");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("does the same for the group lookup and the versions list", async () => {
    catalog({ fail: { "GET /api/v1/groups": { status: 409, code: "X", message: "groups are down" } } });
    await expect(pushSpec({ conn, file: file(), group: "Billing" })).rejects.toThrow(/groups are down/);
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, latest_version: 1 }], fail: { "GET /api/v1/specs/s1/versions": { status: 500, code: "X", message: "versions are down" } } });
    await expect(pushSpec({ conn, file: file() })).rejects.toThrow(/versions are down/);
  });
});

describe("pushSpec: a refused token", () => {
  it("points at an NB_TOKEN left in the shell, which wins over the login, only when there is one", async () => {
    catalog({ fail: { "GET /api/v1/specs": { status: 401, code: "AUTH_ERROR", message: "Invalid API token" } } });
    vi.stubEnv("NB_TOKEN", "nbpat_old");
    await expect(pushSpec({ conn, file: file() })).rejects.toThrow(/Invalid API token\nNB_TOKEN is set in this shell and takes priority over `nb auth login`.*unset NB_TOKEN/s);
    vi.stubEnv("NB_TOKEN", "");
    await expect(pushSpec({ conn, file: file() })).rejects.not.toThrow(/NB_TOKEN/);
  });

  it("says nothing about NB_TOKEN for a refusal that is not about the token", async () => {
    vi.stubEnv("NB_TOKEN", "nbpat_old");
    catalog({ fail: { "GET /api/v1/specs": { status: 403, code: "ENTERPRISE_REQUIRED", message: "An Enterprise plan is required" } } });
    await expect(pushSpec({ conn, file: file() })).rejects.not.toThrow(/NB_TOKEN/);
  });
});

describe("pushSpec: a spec the catalog already has", () => {
  const known = (over: Partial<NonNullable<World["specs"]>[number]> = {}) => ({ id: "s1", name: "Billing API", group_id: null, latest_version: 3, hash: hashText(DOC), ...over });

  it("uploads NOTHING when the file is the latest version: the hash decides, the document is not sent", async () => {
    catalog({ specs: [known()] });
    const r = await pushSpec({ conn, file: file() });
    expect(r).toMatchObject({ id: "s1", version: 3, action: "unchanged" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/specs", "GET /api/v1/specs/s1/versions"]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("adds the next version when the content changed, with the note", async () => {
    catalog({ specs: [known()] });
    const r = await pushSpec({ conn, file: file(DOC_V2), note: "added /invoices" });
    expect(r).toMatchObject({ id: "s1", version: 4, action: "new_version", group_id: null });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/v1/specs/s1/versions");
    expect(post.body).toEqual({ content: DOC_V2, note: "added /invoices" });
    expect(calls.some((c) => c.path === "/api/v1/groups")).toBe(false);
  });

  it("the group is part of the key: --group finds the spec of that group, and another group makes a separate spec (an environment), never moving the first", async () => {
    const groups = [{ id: "g-prod", name: "Production" }, { id: "g-stg", name: "Staging" }];
    catalog({ groups, specs: [known({ id: "s-prod", group_id: "g-prod" })] });
    const same = await pushSpec({ conn, file: file(DOC_V2), group: "production" });
    expect(same).toMatchObject({ id: "s-prod", action: "new_version", group_id: "g-prod" });
    calls = [];
    const other = await pushSpec({ conn, file: file(DOC_V2), group: "Staging" });
    expect(other).toMatchObject({ id: "newspec", action: "created", group_id: "g-stg" });
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/specs")!.body).toMatchObject({ group_id: "g-stg" });
  });

  it("a name that exists only in groups, pushed with no --group, is an error that lists them, not a second spec", async () => {
    catalog({ groups: [{ id: "g-prod", name: "Production" }], specs: [known({ id: "s-prod", group_id: "g-prod" })] });
    await expect(pushSpec({ conn, file: file(DOC_V2) })).rejects.toThrow(/exists in group 'Production'.*--group/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("treats the catalog's own 409 UNCHANGED as success (another job pushed the same file first)", async () => {
    catalog({ specs: [known({ hash: "something-else" })], fail: { "POST /api/v1/specs/s1/versions": { status: 409, code: "UNCHANGED", message: "identical" } } });
    expect((await pushSpec({ conn, file: file() })).action).toBe("unchanged");
  });

  it("finds the spec by name ignoring case, and by id when given, so a rename cannot make a second one", async () => {
    catalog({ specs: [known({ name: "Renamed Billing" })] });
    expect((await pushSpec({ conn, file: file(), name: "renamed billing" })).id).toBe("s1");
    calls = [];
    expect((await pushSpec({ conn, file: file(), id: "s1" })).id).toBe("s1");
    expect(calls[0].path).toBe("/api/v1/specs/s1");
    expect(calls.some((c) => c.path === "/api/v1/specs")).toBe(false);
  });

  it("renames the spec to the document's title on --rename, before the new version, and says what it was called", async () => {
    catalog({ specs: [known({ name: "NASEBANAL - Billing API", hash: "old" })] });
    const r = await pushSpec({ conn, file: file(DOC_V2), id: "s1", rename: true });
    expect(r).toMatchObject({ id: "s1", name: "Billing API", action: "new_version", renamed_from: "NASEBANAL - Billing API" });
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /api/v1/specs/s1", "POST /api/v1/specs/s1/versions"]);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Billing API" });
  });

  it("renames to --name when one is given, and also when the file itself is unchanged", async () => {
    catalog({ specs: [known({ name: "Old", hash: hashText(DOC) })] });
    const r = await pushSpec({ conn, file: file(), id: "s1", rename: true, name: "Billing (prod)" });
    expect(r).toMatchObject({ name: "Billing (prod)", action: "unchanged", renamed_from: "Old" });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Billing (prod)" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does not rename without --rename (a name set by hand stays), nor when the name already matches", async () => {
    catalog({ specs: [known({ name: "Mine", hash: "old" })] });
    const r = await pushSpec({ conn, file: file(DOC_V2), id: "s1" });
    expect(r.name).toBe("Mine");
    expect(r).not.toHaveProperty("renamed_from");
    calls = [];
    catalog({ specs: [known({ name: "Billing API", hash: "old" })] });
    expect(await pushSpec({ conn, file: file(DOC_V2), id: "s1", rename: true })).not.toHaveProperty("renamed_from");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("only says what a rename would do in a dry run", async () => {
    catalog({ specs: [known({ name: "Old", hash: "old" })] });
    const r = await pushSpec({ conn, file: file(DOC_V2), id: "s1", rename: true, dryRun: true });
    expect(r).toMatchObject({ name: "Billing API", renamed_from: "Old" });
    expect(calls.some((c) => c.method === "PATCH" || c.method === "POST")).toBe(false);
  });

  it("refuses --rename without --id, and explains a refused name", async () => {
    catalog({ specs: [known()] });
    await expect(pushSpec({ conn, file: file(), rename: true })).rejects.toThrow(/--rename needs --id/);
    catalog({ specs: [known({ name: "Old", hash: "old" })], fail: { "PATCH /api/v1/specs/s1": { status: 409, code: "NAME_TAKEN", message: "name is taken" } } });
    await expect(pushSpec({ conn, file: file(DOC_V2), id: "s1", rename: true })).rejects.toThrow(/refused the new name 'Billing API': name is taken/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("says plainly when the id is not the owner's", async () => {
    catalog({ specs: [] });
    await expect(pushSpec({ conn, file: file(), id: "nope" })).rejects.toThrow(/No spec with id 'nope'/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a refused version", async () => {
    catalog({ specs: [known({ hash: "x" })], fail: { "POST /api/v1/specs/s1/versions": { status: 422, code: "INVALID_SPEC", message: "paths is missing" } } });
    await expect(pushSpec({ conn, file: file(DOC_V2) })).rejects.toThrow(/The catalog refused the new revision: paths is missing/);
  });

  it("--dry-run reads and writes nothing, and says what it would do", async () => {
    catalog({ specs: [known({ hash: "x" })] });
    expect((await pushSpec({ conn, file: file(DOC_V2), dryRun: true })).action).toBe("new_version");
    catalog();
    expect((await pushSpec({ conn, file: file(), dryRun: true, group: "Billing" })).action).toBe("created");
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
  });
});

describe("the file", () => {
  it("is checked before anything is sent: missing, empty, a folder, too big", async () => {
    catalog();
    expect(() => readSpecFile(join(dir, "nope.yaml"))).toThrow(/not found/);
    expect(() => readSpecFile(file("", "empty.yaml"))).toThrow(/is empty/);
    expect(() => readSpecFile(dir)).toThrow(/not a file/);
    expect(() => readSpecFile(file("x".repeat(MAX_SPEC_BYTES + 1), "big.yaml"))).toThrow(/more than the 2 MiB/);
    await expect(pushSpec({ conn, file: join(dir, "nope.yaml") })).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(0);
  });

  it("hashes exactly what the catalog hashes: the document's text as UTF-8", () => {
    expect(hashText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashText("日本語")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashText("日本語")).not.toBe(hashText("日本"));
  });
});

describe("settings", () => {
  it("picks the catalog's host from the environment, with an override", () => {
    vi.stubEnv("NB_SPECS_BASE_URL", "");
    expect(specsBaseUrl("production")).toBe("https://api.specs.nasebanal.com");
    expect(specsBaseUrl("local")).toBe("http://localhost:8792");
    vi.stubEnv("NB_SPECS_BASE_URL", "http://x.test/");
    expect(specsBaseUrl("production")).toBe("http://x.test");
  });

  it("takes the organization as 'personal' or a number, and nothing else", () => {
    expect(checkOrg(undefined)).toBe("personal");
    expect(checkOrg("")).toBe("personal"); // a CI variable that is set but blank
    expect(checkOrg("  ")).toBe("personal");
    expect(checkOrg(" 7 ")).toBe("7");
    for (const bad of ["abc", "0", "-1", "7x", "Personal "]) expect(() => checkOrg(bad), bad).toThrow(/organization id/);
  });

  it("writes the note from the CI run: repository, commit, branch and the run's URL", () => {
    const ci = { provider: "github", runKey: "1", commitSha: "abcdef1234567", branch: "main", ciUrl: "https://github.com/o/r/actions/runs/1", project: "o/r", repo: "o/r" } as const;
    expect(ciNote(ci, undefined)).toBe("o/r@abcdef1 (main) https://github.com/o/r/actions/runs/1");
    expect(ciNote({ ...ci, commitSha: null, branch: null, ciUrl: null, repo: null }, undefined)).toBeUndefined();
    expect(ciNote({ ...ci, ciUrl: "https://x/" + "a".repeat(600) }, undefined)).toHaveLength(500);
  });
});

describe("nb specs push", () => {
  const run = async (args: string[]) => {
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>");
    program.addCommand(buildSpecsCommand());
    // Commander exits the process on a usage error unless every command in the tree is told to throw instead.
    program.commands.forEach((c) => {
      c.exitOverride();
      c.commands.forEach((cc) => cc.exitOverride());
    });
    await program.parseAsync(["node", "nb", "--token", "tkn", "specs", "push", ...args]);
  };

  it("pushes a file, prints the result as JSON and a one-line summary, and tells later steps of the spec id", async () => {
    catalog();
    const out = join(dir, "gh-output");
    writeFileSync(out, "");
    vi.stubEnv("GITHUB_OUTPUT", out);
    await run(["--file", file()]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ id: "newspec", action: "created" });
    expect(stderr.join("")).toContain("✓ Billing API -> created (v1, rev 1)");
    expect((await import("node:fs")).readFileSync(out, "utf8")).toBe("spec_id=newspec\n");
  });

  it("says 'nothing uploaded' for an unchanged file, and 'dry run' for a dry run", async () => {
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, latest_version: 2, hash: hashText(DOC) }] });
    await run(["--file", file()]);
    expect(stderr.join("")).toContain("unchanged (already rev 2 of v1: nothing uploaded)");
    stderr.length = 0;
    await run(["--file", file(), "--dry-run"]);
    expect(stderr.join("")).toContain("(dry run)");
  });

  it("refuses an organization that is not an id before anything is sent", async () => {
    catalog();
    await expect(run(["--file", file(), "--org", "acme"])).rejects.toThrow(/organization id/);
    expect(calls).toHaveLength(0);
  });

  it("needs --file", async () => {
    catalog();
    await expect(run([])).rejects.toThrow(/--file/);
  });
});

describe("pushSpec: the repository", () => {
  it("creates a new spec tied to the repository id given, and ties nothing when none is given", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file(), repositoryId: "rp1" });
    expect(r.repository_id).toBe("rp1");
    expect(calls.at(-1)!.body).toMatchObject({ repository_id: "rp1" });
    calls.length = 0;
    catalog();
    expect((await pushSpec({ conn, file: file() })).repository_id).toBeNull();
    expect(calls.at(-1)!.body).not.toHaveProperty("repository_id");
  });

  it("registers the repository by name first (idempotently) and uses the id it answers", async () => {
    catalog({ repositories: [{ id: "rp-known", provider: "github", name: "Acme/Billing" }] });
    const known = await pushSpec({ conn, file: file(), repository: "acme/billing" });
    expect(known.repository_id).toBe("rp-known");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/v1/repositories", "GET /api/v1/specs", "POST /api/v1/specs"]);
    calls.length = 0;
    catalog();
    const fresh = await pushSpec({ conn, file: file(), repository: "acme/new", provider: "gitlab" });
    expect(fresh.repository_id).toBe("newrepo");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ provider: "gitlab", name: "acme/new" });
  });

  it("the component is part of the key: sent when given, left out for the repository as a whole, looked up with it in a dry run", async () => {
    catalog({ repositories: [{ id: "rp-whole", provider: "github", name: "acme/billing", component: "" }, { id: "rp-web", provider: "github", name: "acme/billing", component: "web" }] });
    expect((await pushSpec({ conn, file: file(), repository: "acme/billing", component: "web" })).repository_id).toBe("rp-web");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ provider: "github", name: "acme/billing", component: "web" });
    calls.length = 0;
    expect((await pushSpec({ conn, file: file(), repository: "acme/billing" })).repository_id).toBe("rp-whole");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ provider: "github", name: "acme/billing" });
    expect((await pushSpec({ conn, file: file(), repository: "acme/billing", component: "api", dryRun: true })).repository_id).toBe("(new)");
    expect((await pushSpec({ conn, file: file(), repository: "acme/billing", component: "WEB", dryRun: true })).repository_id).toBe("rp-web");
  });

  it("refuses an id and a name together, before anything is written", async () => {
    catalog();
    await expect(pushSpec({ conn, file: file(), repositoryId: "rp1", repository: "a/b" })).rejects.toThrow(/pass one/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("ties an existing spec that has no repository when it is named by --id, even when its file is unchanged", async () => {
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, repository_id: null, latest_version: 2, hash: hashText(DOC) }] });
    const r = await pushSpec({ conn, file: file(), id: "s1", repositoryId: "rp1" });
    expect(r).toMatchObject({ action: "unchanged", repository_id: "rp1" });
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/api/v1/specs/s1", body: { repository_id: "rp1" } });
  });

  it("never moves a spec that is tied to another repository: it says so and leaves it", async () => {
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, repository_id: "rp-old", latest_version: 1, hash: hashText(DOC) }] });
    const r = await pushSpec({ conn, file: file(DOC_V2), id: "s1", repositoryId: "rp-new" });
    expect(r).toMatchObject({ action: "new_version", repository_id: "rp-old", repository_kept: "rp-old" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("leaves an existing spec's repository alone when none is asked for", async () => {
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, repository_id: "rp-old", latest_version: 1, hash: hashText(DOC) }] });
    expect(await pushSpec({ conn, file: file(DOC_V2) })).toMatchObject({ repository_id: "rp-old" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a dry run registers nothing: a known repository is looked up, an unknown one reads (new)", async () => {
    catalog({ repositories: [{ id: "rp-known", provider: "github", name: "acme/billing" }] });
    expect((await pushSpec({ conn, file: file(), repository: "acme/billing", dryRun: true })).repository_id).toBe("rp-known");
    expect((await pushSpec({ conn, file: file(), repository: "acme/other", dryRun: true })).repository_id).toBe("(new)");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("pushSpec: the same name under different repositories", () => {
  const twins = [
    { id: "s-a", name: "Billing API", group_id: null, repository_id: "rp-a", latest_version: 1, hash: hashText(DOC) },
    { id: "s-b", name: "Billing API", group_id: null, repository_id: "rp-b", latest_version: 3, hash: hashText(DOC) },
    { id: "s-none", name: "Loose API", group_id: null, repository_id: null, latest_version: 1, hash: hashText(DOC) },
  ];
  const repositories = [
    { id: "rp-a", provider: "github", name: "acme/a" },
    { id: "rp-b", provider: "github", name: "acme/b", component: "web" },
  ];

  it("looks the name up inside the repository asked for: each repository's own spec is the one updated", async () => {
    catalog({ specs: twins, repositories });
    expect(await pushSpec({ conn, file: file(DOC_V2), repository: "acme/b", component: "web" })).toMatchObject({ id: "s-b", action: "new_version", repository_id: "rp-b" });
    calls.length = 0;
    expect(await pushSpec({ conn, file: file(DOC_V2), repository: "acme/a" })).toMatchObject({ id: "s-a", action: "new_version", repository_id: "rp-a" });
  });

  it("a name that exists only under other repositories is a NEW spec in the repository asked for (a spec with no repository is not adopted by name)", async () => {
    catalog({ specs: twins, repositories });
    expect(await pushSpec({ conn, file: file(), name: "Billing API", repository: "acme/new" })).toMatchObject({ id: "newspec", action: "created" });
    calls.length = 0;
    catalog({ specs: twins, repositories });
    expect(await pushSpec({ conn, file: file(), name: "Loose API", repository: "acme/a" })).toMatchObject({ id: "newspec", action: "created" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("with no repository asked: the spec that has none wins; one match under a repository is used; several under repositories are refused, naming them", async () => {
    catalog({ specs: [...twins, { id: "s-loose-twin", name: "Billing API", group_id: null, repository_id: null, latest_version: 1, hash: hashText(DOC) }], repositories });
    expect(await pushSpec({ conn, file: file(DOC_V2), name: "Billing API" })).toMatchObject({ id: "s-loose-twin" });
    calls.length = 0;
    catalog({ specs: twins, repositories });
    expect(await pushSpec({ conn, file: file(DOC_V2), name: "Loose API" })).toMatchObject({ id: "s-none" });
    calls.length = 0;
    catalog({ specs: twins, repositories });
    await expect(pushSpec({ conn, file: file(DOC_V2), name: "Billing API" })).rejects.toThrow(/More than one spec is named 'Billing API' \(no group \/ github acme\/a; no group \/ github acme\/b \/ web\).*--repository.*--id/s);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("--id still names one spec outright", async () => {
    catalog({ specs: twins, repositories });
    expect(await pushSpec({ conn, file: file(DOC_V2), id: "s-b" })).toMatchObject({ id: "s-b" });
  });
});

describe("upsertRepository / checkProvider", () => {
  it("answers 201 as created and 200 as already registered, with the same id", async () => {
    catalog();
    const first = await upsertRepository(conn, "github", "acme/api");
    expect(first).toMatchObject({ id: "newrepo", created: true });
    const again = await upsertRepository(conn, "github", "ACME/api");
    expect(again).toMatchObject({ id: "newrepo", created: false });
  });

  it("explains the catalog's refusal with its own reason", async () => {
    catalog({ fail: { "PUT /api/v1/repositories": { status: 400, code: "VALIDATION_ERROR", message: "name must be written owner/name for github" } } });
    await expect(upsertRepository(conn, "github", "justaname")).rejects.toThrow(/The catalog refused the repository: name must be written owner\/name/);
  });

  it("takes github by default and refuses an unknown provider", () => {
    expect(checkProvider(undefined)).toBe("github");
    expect(checkProvider(" GitLab ")).toBe("gitlab");
    expect(() => checkProvider("svn")).toThrow(/must be one of/);
  });
});

describe("nb specs ... (the generated group with the hand-written verbs attached)", () => {
  const run = async (args: string[]) => {
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>");
    const group = attachSpecsCommands(new Command("specs"));
    program.addCommand(group);
    const walk = (c: Command) => {
      c.exitOverride();
      c.commands.forEach(walk);
    };
    program.commands.forEach(walk);
    await program.parseAsync(["node", "nb", "--token", "tkn", "specs", ...args]);
  };

  it("`repositories upsert` registers a repository, prints it with its id, and tells later steps", async () => {
    catalog();
    const out = join(dir, "gh-output");
    writeFileSync(out, "");
    vi.stubEnv("GITHUB_OUTPUT", out);
    await run(["repositories", "upsert", "--name", "nasebanal/nb-recorder-api"]);
    expect(JSON.parse(stdout.join(""))).toEqual({ id: "newrepo", provider: "github", name: "nasebanal/nb-recorder-api", component: "" });
    expect(stderr.join("")).toContain("✓ github nasebanal/nb-recorder-api -> newrepo (registered)");
    expect((await import("node:fs")).readFileSync(out, "utf8")).toBe("repository_id=newrepo\n");
    stderr.length = 0;
    await run(["repositories", "upsert", "--name", "nasebanal/nb-recorder-api"]);
    expect(stderr.join("")).toContain("(already registered)");
    stderr.length = 0;
    await run(["repositories", "upsert", "--name", "nasebanal/nb-recorder-api", "--component", "web"]);
    expect(calls.filter((c) => c.method === "PUT").at(-1)!.body).toEqual({ provider: "github", name: "nasebanal/nb-recorder-api", component: "web" });
    expect(stderr.join("")).toContain("✓ github nasebanal/nb-recorder-api / web ->");
  });

  it("`specs push` takes the repository id from --repository-id, or from $NB_REPOSITORY_ID, and a name wins over the variable", async () => {
    catalog();
    await run(["specs", "push", "--file", file(), "--repository-id", "rp-flag"]);
    expect(calls.at(-1)!.body).toMatchObject({ repository_id: "rp-flag" });
    calls.length = 0;
    catalog();
    vi.stubEnv("NB_REPOSITORY_ID", "rp-env");
    await run(["specs", "push", "--file", file()]);
    expect(calls.at(-1)!.body).toMatchObject({ repository_id: "rp-env" });
    calls.length = 0;
    catalog();
    await run(["specs", "push", "--file", file(), "--repository", "acme/api"]);
    expect(calls.at(-1)!.body).toMatchObject({ repository_id: "newrepo" });
  });

  it("the old direct form (`nb specs push`) keeps working and is not advertised", async () => {
    catalog();
    await run(["push", "--file", file()]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ action: "created" });
    const group = attachSpecsCommands(new Command("specs"));
    const hidden = (group.commands as unknown as { _hidden?: boolean; name(): string }[]).filter((c) => c._hidden).map((c) => c.name());
    expect(hidden.sort()).toEqual(["pull", "push", "versions"]);
  });

  it("warns, on stderr, when the spec is tied to another repository and was left there", async () => {
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, repository_id: "rp-old", latest_version: 1, hash: hashText(DOC) }] });
    await run(["specs", "push", "--file", file(DOC_V2), "--id", "s1", "--repository-id", "rp-new"]);
    expect(stderr.join("")).toContain("tied to another repository (rp-old)");
  });
});

describe("pushSpec: --server-url (one OpenAPI file, one URL per environment)", () => {
  const WITH_SERVERS = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 1.0.0\nservers:\n  - url: http://localhost:8788\npaths: {}\n";

  it("sends the document with its servers replaced, and the hash is of what was sent", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file(WITH_SERVERS), serverUrl: "https://staging.example.com/v1" });
    expect(r).toMatchObject({ action: "created", server_url: "https://staging.example.com/v1", servers_edit: "text" });
    const sent = calls.find((c) => c.method === "POST" && c.path === "/api/v1/specs")!.body.content as string;
    expect(sent).toContain("https://staging.example.com/v1");
    expect(sent).not.toContain("localhost:8788");
    expect(r.content_hash).toBe(hashText(sent));
  });

  it("is unchanged when the same file is pushed to the same environment again (the hash is of the edited text)", async () => {
    const edited = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 1.0.0\nservers:\n  - url: \"https://staging.example.com/v1\"\npaths: {}\n";
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, latest_version: 2, hash: hashText(edited) }] });
    const r = await pushSpec({ conn, file: file(WITH_SERVERS), serverUrl: "https://staging.example.com/v1" });
    expect(r).toMatchObject({ id: "s1", action: "unchanged" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("--dry-run shows the URL and writes nothing; a bad URL is refused before anything is read", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file(WITH_SERVERS), serverUrl: "https://x.example.com", dryRun: true });
    expect(r).toMatchObject({ server_url: "https://x.example.com", servers_edit: "text" });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    calls.length = 0;
    await expect(pushSpec({ conn, file: file(WITH_SERVERS), serverUrl: "nope" })).rejects.toThrow(/not a URL/);
    expect(calls).toHaveLength(0);
  });
});

describe("pushSpec: the API version is part of the spec's key", () => {
  const DOC_MAJOR2 = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 2.0.0\npaths: {}\n";
  const DOC_CALVER = "openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: 2023-01\npaths: {}\n";
  const v1 = { id: "s-v1", name: "Billing API", group_id: null, latest_version: 3, hash: hashText(DOC), api_version: "v1" };

  it("a new spec takes the API version the document's info.version gives, and the result says it", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file() });
    expect(r).toMatchObject({ action: "created", api_version: "v1", version: 1 });
    expect(calls.at(-1)!.body).not.toHaveProperty("api_version"); // derived by the catalog from the same document
  });

  it("a document of another major makes the NEW spec for its API version and leaves the existing one alone", async () => {
    catalog({ specs: [v1] });
    const r = await pushSpec({ conn, file: file(DOC_MAJOR2) });
    expect(r).toMatchObject({ id: "newspec", action: "created", api_version: "v2" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/specs", "POST /api/v1/specs"]);
  });

  it("a document of the same major is a new revision of that API version's spec", async () => {
    catalog({ specs: [v1, { id: "s-v2", name: "Billing API", group_id: null, latest_version: 1, hash: "x", api_version: "v2" }] });
    const r = await pushSpec({ conn, file: file(DOC_V2) });
    expect(r).toMatchObject({ id: "s-v1", action: "new_version", api_version: "v1", version: 4 });
    calls.length = 0;
    const r2 = await pushSpec({ conn, file: file(DOC_MAJOR2) });
    expect(r2).toMatchObject({ id: "s-v2", action: "new_version", api_version: "v2", version: 2 });
  });

  it("--api-version wins over the document, and is sent when a spec is created; a bad label is refused before the catalog is read", async () => {
    catalog();
    const r = await pushSpec({ conn, file: file(DOC), apiVersion: "v7" });
    expect(r.api_version).toBe("v7");
    expect(calls.at(-1)!.body.api_version).toBe("v7");
    calls.length = 0;
    await expect(pushSpec({ conn, file: file(DOC), apiVersion: "v 7" })).rejects.toThrow(/must be a version label/);
    expect(calls).toHaveLength(0);
  });

  it("a document whose info.version gives no major needs --api-version, before anything is sent", async () => {
    catalog();
    await expect(pushSpec({ conn, file: file(DOC_CALVER) })).rejects.toThrow(/gives no API version.*--api-version <v1\|v2/s);
    expect(calls).toHaveLength(0);
    expect((await pushSpec({ conn, file: file(DOC_CALVER), apiVersion: "v1" })).action).toBe("created");
  });

  it("a push by id of another API version's document says to push it without --id", async () => {
    catalog({ specs: [v1] });
    await expect(pushSpec({ conn, file: file(DOC_MAJOR2), id: "s-v1" })).rejects.toThrow(/belongs to another API version than 'Billing API' \(v1\).*without --id/s);
  });

  it("the catalog's API_VERSION_REQUIRED is turned into the way out", async () => {
    catalog({ fail: { "POST /api/v1/specs": { status: 400, code: "API_VERSION_REQUIRED", message: "no major" } } });
    await expect(pushSpec({ conn, file: file() })).rejects.toThrow(/could not tell this document's API version.*--api-version/s);
  });
});

const DOC_V = (version: string) => `openapi: 3.0.3\ninfo:\n  title: Billing API\n  version: ${version}\npaths: {}\n`;
const FAMILY = [
  { id: "first", name: "Billing API", group_id: "g1", repository_id: "rp1", latest_version: 3, hash: "h", api_version: "v1", initial_spec_id: null },
  { id: "second", name: "Billing API", group_id: "g1", repository_id: "rp1", latest_version: 1, hash: "h", api_version: "v2", initial_spec_id: "first" },
];

describe("pushSpec --follow-version: the id names the first spec of an API", () => {
  it("pushes a document of an API version the API has to THAT spec, whatever the id names", async () => {
    catalog({ specs: FAMILY });
    const res = await pushSpec({ conn, file: file(DOC_V("2.1.0")), id: "first", followVersion: true });
    expect(res).toMatchObject({ id: "second", action: "new_version", api_version: "v2" });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/specs/second/versions")).toBe(true);
    // from any member of the family: the family is found from it
    calls = [];
    const again = await pushSpec({ conn, file: file(DOC_V("1.9.0")), id: "second", followVersion: true });
    expect(again).toMatchObject({ id: "first", action: "new_version" });
  });

  it("makes the spec of the next API version, named as the initial spec is, naming it as its initial version", async () => {
    catalog({ specs: FAMILY });
    const res = await pushSpec({ conn, file: file(DOC_V("3.0.0")), id: "first", followVersion: true, serverUrl: "https://api.example.com" });
    expect(res).toMatchObject({ id: "newspec", name: "Billing API", action: "created", api_version: "v3" });
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/specs")!;
    expect(post.body.initial_spec_id).toBe("first");
    expect(post.body.name).toBe("Billing API");
    expect(post.body.group_id).toBeUndefined(); // the catalog keeps the family's group and repository
    expect(String(post.body.content)).toContain("https://api.example.com");
  });

  it("refuses an API version that is not the next one, before anything is sent (the catalog would refuse it too)", async () => {
    catalog({ specs: FAMILY });
    await expect(pushSpec({ conn, file: file(DOC_V("4.0.0")), id: "first", followVersion: true })).rejects.toThrow(/next API version of 'Billing API' is v3, not v4/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("says in a dry run what a real push would do, writing nothing", async () => {
    catalog({ specs: FAMILY });
    const next = await pushSpec({ conn, file: file(DOC_V("3.0.0")), id: "first", followVersion: true, dryRun: true });
    expect(next).toMatchObject({ id: "(new)", action: "created", api_version: "v3", name: "Billing API" });
    await expect(pushSpec({ conn, file: file(DOC_V("5.0.0")), id: "first", followVersion: true, dryRun: true })).rejects.toThrow(/v3/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("needs an id and a document with an API version", async () => {
    catalog({ specs: FAMILY });
    await expect(pushSpec({ conn, file: file(DOC_V("3.0.0")), followVersion: true })).rejects.toThrow(/needs --id/);
    await expect(pushSpec({ conn, file: file(DOC_V("2023-01")), id: "first", followVersion: true })).rejects.toThrow(/API version/);
  });
});
