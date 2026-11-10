import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateSpec, resolveRepositorySpecs, resolveSpec } from "./resolve.js";

const conn = { baseUrl: "http://specs.test", token: "tkn", org: "personal" };

const REPOSITORIES = [
  { id: "rp-whole", provider: "github", name: "acme/account", component: "", spec_count: 1 },
  { id: "rp-web", provider: "github", name: "acme/account", component: "web", spec_count: 1 },
  { id: "rp-gl", provider: "gitlab", name: "acme/account", component: "", spec_count: 0 },
  { id: "rp-ver", provider: "github", name: "acme/versioned", component: "", spec_count: 3 },
];
const SPECS = [
  { id: "s-public", name: "Account API", repository_id: "rp-whole" },
  { id: "s-internal", name: "Account Internal API", repository_id: "rp-web" },
  { id: "s-loose", name: "Hand Made API", repository_id: null },
  // The same name in other groups (an environment each) under the same repository row: the group picks the spec.
  { id: "s-public-prod", name: "Account API", group_id: "g-prod", repository_id: "rp-whole" },
  { id: "s-public-stg", name: "Account API", group_id: "g-stg", repository_id: "rp-whole" },
  // The same name under another repository (and one with none): the repository row picks the spec.
  { id: "s-public-gl", name: "Account API", repository_id: "rp-gl" },
  { id: "s-hand-web", name: "Hand Made API", repository_id: "rp-web" },
  // One API per API version (a new major version is a new spec): the same name, the API version picks the spec.
  { id: "s-ver-v1", name: "Versioned API", repository_id: "rp-ver", api_version: "v1" },
  { id: "s-ver-v2", name: "Versioned API", repository_id: "rp-ver", api_version: "v2" },
  { id: "s-ver-v1-stg", name: "Versioned API", group_id: "g-stg", repository_id: "rp-ver", api_version: "v1" },
];

const GROUPS = [
  { id: "g-prod", name: "Production" },
  { id: "g-stg", name: "Staging" },
];

let paths: string[];
beforeEach(() => {
  paths = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: SPECS } });
      if (url.pathname === "/api/v1/groups") return json(200, { success: true, data: { data: GROUPS } });
      if (url.pathname === "/api/v1/repositories") return json(200, { success: true, data: { data: REPOSITORIES } });
      const spec = url.pathname.match(/^\/api\/v1\/specs\/([^/]+)$/);
      if (spec) {
        const hit = SPECS.find((s) => s.id === spec[1]);
        return hit ? json(200, { success: true, data: hit }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "Spec not found" } });
      }
      const repo = url.pathname.match(/^\/api\/v1\/repositories\/([^/]+)$/);
      if (repo) {
        const hit = REPOSITORIES.find((r) => r.id === repo[1]);
        return hit ? json(200, { success: true, data: hit }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "Repository not found" } });
      }
      return json(500, { success: false, error: { code: "UNEXPECTED", message: url.pathname } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveSpec: by id", () => {
  it("gives the spec and the repository row it is tied to", async () => {
    const r = await resolveSpec(conn, { specId: "s-internal" });
    expect(r).toMatchObject({ spec_id: "s-internal", spec_name: "Account Internal API", repository_id: "rp-web" });
    expect(r.repository).toMatchObject({ provider: "github", name: "acme/account", component: "web" });
  });

  it("refuses a spec with no repository, and says how to tie it", async () => {
    await expect(resolveSpec(conn, { specId: "s-loose" })).rejects.toThrow(/tied to no repository.*Tie it first/s);
  });

  it("says when the catalog has no such spec", async () => {
    await expect(resolveSpec(conn, { specId: "nope" })).rejects.toThrow(/No spec with id 'nope'/);
  });
});

describe("resolveSpec: by names", () => {
  it("finds the repository row with the component and the spec tied to it", async () => {
    const r = await resolveSpec(conn, { repository: "acme/account", component: "web", spec: "account internal api" });
    expect(r).toMatchObject({ spec_id: "s-internal", repository_id: "rp-web" });
  });

  it("takes no component as the repository as a whole (the row whose component is empty)", async () => {
    const r = await resolveSpec(conn, { repository: "ACME/account", spec: "Account API" });
    expect(r).toMatchObject({ spec_id: "s-public", repository_id: "rp-whole" });
  });

  it("the provider is part of the key (github by default)", async () => {
    await expect(resolveSpec(conn, { repository: "acme/account", provider: "gitlab", spec: "Account Internal API" })).rejects.toThrow(/No spec named 'Account Internal API' in no group \/ gitlab acme\/account.*exists in: no group \/ github acme\/account \/ web/);
    await expect(resolveSpec(conn, { repository: "acme/account", provider: "bitbucket", spec: "Account API" })).rejects.toThrow(/No repository bitbucket acme\/account/);
  });

  it("checks the three names against each other and names every place the name is in when they disagree", async () => {
    const err = await resolveSpec(conn, { repository: "acme/account", component: "web", spec: "Account API" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/No spec named 'Account API' in no group \/ github acme\/account \/ web\. The name exists in:/);
    for (const where of ["no group / github acme/account", "no group / gitlab acme/account", "group 'Production' / github acme/account", "group 'Staging' / github acme/account"]) {
      expect((err as Error).message).toContain(where);
    }
  });

  it("creates nothing: an unknown repository or spec is an error that points at the command that registers it", async () => {
    await expect(resolveSpec(conn, { repository: "acme/other", spec: "Account API" })).rejects.toThrow(/No repository github acme\/other.*nb specs repositories upsert/s);
    await expect(resolveSpec(conn, { repository: "acme/account", spec: "Missing API" })).rejects.toThrow(/No spec named 'Missing API'.*nb specs specs push/s);
    await expect(resolveSpec(conn, { repository: "acme/account", component: "api", spec: "Account API" })).rejects.toThrow(/No repository github acme\/account \/ api/);
  });

  it("the repository row picks the spec when the same name exists under several repositories", async () => {
    expect(await resolveSpec(conn, { repository: "acme/account", spec: "Account API" })).toMatchObject({ spec_id: "s-public", repository_id: "rp-whole" });
    expect(await resolveSpec(conn, { repository: "acme/account", provider: "gitlab", spec: "Account API" })).toMatchObject({ spec_id: "s-public-gl", repository_id: "rp-gl" });
    expect(await resolveSpec(conn, { repository: "acme/account", component: "web", spec: "Hand Made API" })).toMatchObject({ spec_id: "s-hand-web" });
  });

  it("refuses a spec with no repository", async () => {
    // 'Hand Made API' exists with no repository and under the web component only: asked for the whole repository it is not found, and says where it is.
    await expect(resolveSpec(conn, { repository: "acme/account", spec: "Hand Made API" })).rejects.toThrow(/No spec named 'Hand Made API' in no group \/ github acme\/account\..*no group \/ no repository \/ v1; no group \/ github acme\/account \/ web \/ v1/s);
    await expect(resolveSpec(conn, { specId: "s-loose" })).rejects.toThrow(/tied to no repository/);
  });
});

describe("resolveSpec: how it is asked", () => {
  it("wants an id or the names, never both, never nothing, never half of the names", async () => {
    await expect(resolveSpec(conn, {})).rejects.toThrow(/Say which spec/);
    await expect(resolveSpec(conn, { specId: "s-public", spec: "Account API" })).rejects.toThrow(/do not combine/);
    await expect(resolveSpec(conn, { specId: "s-public", repository: "acme/account" })).rejects.toThrow(/do not combine/);
    await expect(resolveSpec(conn, { spec: "Account API" })).rejects.toThrow(/--repository is required/);
    await expect(resolveSpec(conn, { repository: "acme/account" })).rejects.toThrow(/--spec is required/);
    await expect(resolveSpec(conn, { component: "web" })).rejects.toThrow(/--repository is required/);
    expect(paths).toEqual([]); // every one of them was refused before a call
  });
});

describe("the group is part of the key", () => {
  it("picks the spec of the same name by its group; a group left out means 'no group', not any", async () => {
    expect(await resolveSpec(conn, { repository: "acme/account", group: "Production", spec: "Account API" })).toMatchObject({ spec_id: "s-public-prod", repository_id: "rp-whole" });
    expect(await resolveSpec(conn, { repository: "acme/account", group: "staging", spec: "account api" })).toMatchObject({ spec_id: "s-public-stg" });
    expect(await resolveSpec(conn, { repository: "acme/account", spec: "Account API" })).toMatchObject({ spec_id: "s-public" });
  });

  it("on a miss says where the name is, and asks for --group, --repository or --spec-id", async () => {
    await expect(resolveSpec(conn, { repository: "acme/account", component: "web", group: "Production", spec: "Account API" })).rejects.toThrow(
      /No spec named 'Account API' in group 'Production' \/ github acme\/account \/ web\. The name exists in:.*group 'Staging' \/ github acme\/account.*--group.*--spec-id/s,
    );
  });

  it("refuses a group the catalog does not have, and lists the ones it has", async () => {
    await expect(resolveSpec(conn, { repository: "acme/account", group: "Dev", spec: "Account API" })).rejects.toThrow(/No group named 'Dev'.*Production, Staging/);
  });

  it("is not combinable with --spec-id", async () => {
    await expect(resolveSpec(conn, { specId: "s-public", group: "Production" })).rejects.toThrow(/do not combine/);
  });
});

describe("locateSpec: a spec by its key, tied to a repository or not (docs, pull)", () => {
  it("finds a spec with no repository when no repository is named", async () => {
    const hit = await locateSpec(conn, { spec: "Hand Made API" });
    expect(hit.spec.id).toBe("s-loose");
    expect(hit.repository).toBeNull();
  });

  it("finds one by group and repository", async () => {
    expect((await locateSpec(conn, { spec: "Account API", group: "Staging", repository: "acme/account" })).spec.id).toBe("s-public-stg");
  });

  it("needs a spec, and --component / --provider need --repository", async () => {
    await expect(locateSpec(conn, {})).rejects.toThrow(/Say which spec/);
    await expect(locateSpec(conn, { spec: "Account API", component: "web" })).rejects.toThrow(/need --repository/);
  });
});

describe("resolveRepositorySpecs: every spec tied to one repository row (--all-specs)", () => {
  it("lists them whatever their group, sorted by group then name", async () => {
    const out = await resolveRepositorySpecs(conn, { repository: "acme/account" });
    expect(out.map((r) => r.spec_id)).toEqual(["s-public", "s-public-prod", "s-public-stg"]);
    expect(new Set(out.map((r) => r.repository_id))).toEqual(new Set(["rp-whole"]));
  });

  it("refuses a repository with no spec, an unknown one, and a missing --repository", async () => {
    await expect(resolveRepositorySpecs(conn, { repository: "acme/account", provider: "gitlab" })).resolves.toHaveLength(1);
    await expect(resolveRepositorySpecs(conn, { repository: "acme/other" })).rejects.toThrow(/No repository github acme\/other/);
    await expect(resolveRepositorySpecs(conn, {})).rejects.toThrow(/needs --repository/);
  });
});

describe("the API version is part of the key", () => {
  it("--api-version picks the spec of that API version", async () => {
    expect(await resolveSpec(conn, { repository: "acme/versioned", spec: "Versioned API", apiVersion: "v2" })).toMatchObject({ spec_id: "s-ver-v2" });
    expect(await resolveSpec(conn, { repository: "acme/versioned", spec: "Versioned API", apiVersion: "V1" })).toMatchObject({ spec_id: "s-ver-v1" });
  });

  it("left out, it is the API version of the one spec the rest of the key leaves; several: the error lists them (the one exception to 'left out means none')", async () => {
    // in no group the name exists at v1 and v2
    await expect(resolveSpec(conn, { repository: "acme/versioned", spec: "Versioned API" })).rejects.toThrow(/more than one API version in no group \/ github acme\/versioned: v1, v2.*--api-version/s);
    // in Staging only v1 exists: it is the one
    expect(await resolveSpec(conn, { repository: "acme/versioned", group: "Staging", spec: "Versioned API" })).toMatchObject({ spec_id: "s-ver-v1-stg" });
    // a spec that has one API version is found without saying it
    expect(await resolveSpec(conn, { repository: "acme/account", spec: "Account API" })).toMatchObject({ spec_id: "s-public" });
  });

  it("on a miss lists the API versions where the name is, and refuses a bad label before reading anything", async () => {
    await expect(resolveSpec(conn, { repository: "acme/versioned", spec: "Versioned API", apiVersion: "v3" })).rejects.toThrow(/in no group \/ github acme\/versioned \/ v3.*exists in:.*v1.*v2.*--api-version/s);
    await expect(resolveSpec(conn, { repository: "acme/versioned", spec: "Versioned API", apiVersion: "v 1" })).rejects.toThrow(/--api-version 'v 1' must be a version label/);
    await expect(resolveSpec(conn, { specId: "s-ver-v1", apiVersion: "v1" })).rejects.toThrow(/do not combine/);
  });

  it("--all-specs: one API version at a time; a repository row with specs of several asks for --api-version", async () => {
    await expect(resolveRepositorySpecs(conn, { repository: "acme/versioned" })).rejects.toThrow(/several API versions \(v1, v2\).*--api-version/s);
    const v1 = await resolveRepositorySpecs(conn, { repository: "acme/versioned", apiVersion: "v1" });
    expect(v1.map((x) => x.spec_id)).toEqual(["s-ver-v1", "s-ver-v1-stg"].sort((a, b) => 0)); // sorted by group name then name: no group first
    expect((await resolveRepositorySpecs(conn, { repository: "acme/versioned", apiVersion: "v2" })).map((x) => x.spec_id)).toEqual(["s-ver-v2"]);
    await expect(resolveRepositorySpecs(conn, { repository: "acme/versioned", apiVersion: "v9" })).rejects.toThrow(/No spec of github acme\/versioned is at API version 'v9'.*v1, v2/s);
    // a row whose specs are all at one API version needs no --api-version
    expect((await resolveRepositorySpecs(conn, { repository: "acme/account", component: "web" })).map((x) => x.spec_id)).toContain("s-internal");
  });
});
