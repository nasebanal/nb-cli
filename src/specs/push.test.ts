import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { checkOrg, ciNote, hashText, MAX_SPEC_BYTES, pushSpec, readSpecFile, specNameFor, specsBaseUrl, titleOf } from "./push.js";
import { buildSpecsCommand } from "./command.js";

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
  specs?: { id: string; name: string; group_id: string | null; latest_version: number; hash?: string }[];
  groups?: { id: string; name: string }[];
  /** Responses that replace the default for a request, by `METHOD path`. */
  fail?: Record<string, { status: number; code: string; message: string }>;
}

/** A fake catalog: lists, versions with hashes, and the writes, all recorded in `calls`. */
function catalog(world: World = {}) {
  const specs = world.specs ?? [];
  const groups = world.groups ?? [];
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
      if (versions && method === "POST") return json(201, { success: true, data: { version: specs.find((s) => s.id === versions[1])!.latest_version + 1 } });
      if (method === "GET" && url.pathname === "/api/v1/groups") return json(200, { success: true, data: { data: groups, total: groups.length, limit: 10 } });
      if (method === "POST" && url.pathname === "/api/v1/groups") return json(201, { success: true, data: { id: "newgroup", name: body.name } });
      if (method === "POST" && url.pathname === "/api/v1/specs") return json(201, { success: true, data: { id: "newspec", name: body.name, group_id: body.group_id ?? null } });
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
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/specs", "GET /api/v1/groups", "POST /api/v1/groups", "POST /api/v1/specs"]);
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
    await expect(pushSpec({ conn, file: file("nonsense") })).rejects.toThrow(/not an OpenAPI document/);
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
  const known = (over: Partial<NonNullable<World["specs"]>[number]> = {}) => ({ id: "s1", name: "Billing API", group_id: "g1", latest_version: 3, hash: hashText(DOC), ...over });

  it("uploads NOTHING when the file is the latest version: the hash decides, the document is not sent", async () => {
    catalog({ specs: [known()] });
    const r = await pushSpec({ conn, file: file() });
    expect(r).toMatchObject({ id: "s1", version: 3, action: "unchanged" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/specs", "GET /api/v1/specs/s1/versions"]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("adds the next version when the content changed, with the note, and never moves the spec's group", async () => {
    catalog({ specs: [known()] });
    const r = await pushSpec({ conn, file: file(DOC_V2), note: "added /invoices", group: "Other" });
    expect(r).toMatchObject({ id: "s1", version: 4, action: "new_version", group_id: "g1" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/v1/specs/s1/versions");
    expect(post.body).toEqual({ content: DOC_V2, note: "added /invoices" });
    expect(calls.some((c) => c.path === "/api/v1/groups")).toBe(false);
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
    await expect(pushSpec({ conn, file: file(DOC_V2) })).rejects.toThrow(/The catalog refused the new version: paths is missing/);
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
    expect(stderr.join("")).toContain("✓ Billing API -> created (v1)");
    expect((await import("node:fs")).readFileSync(out, "utf8")).toBe("spec_id=newspec\n");
  });

  it("says 'nothing uploaded' for an unchanged file, and 'dry run' for a dry run", async () => {
    catalog({ specs: [{ id: "s1", name: "Billing API", group_id: null, latest_version: 2, hash: hashText(DOC) }] });
    await run(["--file", file()]);
    expect(stderr.join("")).toContain("unchanged (already v2: nothing uploaded)");
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
