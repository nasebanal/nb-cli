import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { attachMonitorSpecOptions } from "./monitors.js";

let sent: Record<string, unknown> | undefined;
let calls: string[];

/** The generated tree's shape in miniature: `assurance monitors create|update`, each with `--data`, `--org`, whose action just records the body. */
function program(): Command {
  const root = new Command().exitOverride().option("--env <env>").option("--token <token>");
  const assurance = root.command("assurance").exitOverride();
  const monitors = assurance.command("monitors").exitOverride();
  for (const verb of ["create", "update"]) {
    monitors
      .command(verb)
      .exitOverride()
      .option("--data <json>")
      .option("--org <value>")
      .action((_o: unknown, command: Command) => {
        const data = (command.optsWithGlobals() as { data?: string }).data;
        sent = data === undefined ? undefined : JSON.parse(data);
      });
  }
  attachMonitorSpecOptions(assurance);
  return root;
}

const run = (...args: string[]) => program().parseAsync(["node", "nb", "--token", "tkn", "assurance", "monitors", ...args]);

beforeEach(() => {
  sent = undefined;
  calls = [];
  vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
  vi.stubEnv("NB_SPEC_ID", "");
  vi.stubEnv("NB_SPECS_ORG", "");
  vi.stubEnv("NB_ASSURANCE_ORG", "");
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const repositories = [{ id: "r1", provider: "github", name: "acme/api", component: "" }];
  const specs = [
    { id: "s1", name: "Api", repository_id: "r1" },
    { id: "s2", name: "Loose", repository_id: null },
    { id: "s3", name: "Api", group_id: "g-prod", repository_id: "r1" },
    // the same name at two API versions (a new major version is a new spec)
    { id: "s5", name: "Multi", repository_id: "r1", api_version: "v1" },
    { id: "s6", name: "Multi", repository_id: "r1", api_version: "v2" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/groups") return json(200, { success: true, data: { data: [{ id: "g-prod", name: "Production" }] } });
      if (url.pathname === "/api/v1/repositories") return json(200, { success: true, data: { data: repositories } });
      if (url.pathname === "/api/v1/specs") return json(200, { success: true, data: { data: specs } });
      const one = /^\/api\/v1\/(specs|repositories)\/([^/]+)$/.exec(url.pathname);
      const row = one ? (one[1] === "specs" ? specs : repositories).find((x) => x.id === one[2]) : undefined;
      return row ? json(200, { success: true, data: row }) : json(404, { success: false, error: { code: "NOT_FOUND", message: "no" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("assurance monitors create / update name the spec", () => {
  it("create puts spec_id and repository_id into the body, by id or by names, and keeps the rest of --data", async () => {
    await run("create", "--spec-id", "s1", "--data", '{"url":"https://x.test/health"}');
    expect(sent).toEqual({ url: "https://x.test/health", spec_id: "s1", repository_id: "r1" });
    await run("create", "--repository", "acme/api", "--spec", "api", "--data", '{"url":"https://x.test/health"}');
    expect(sent).toMatchObject({ spec_id: "s1", repository_id: "r1" });
  });

  it("--group is part of the spec's key: the same name in a group is another spec, and no --group means no group", async () => {
    await run("create", "--repository", "acme/api", "--group", "Production", "--spec", "api", "--data", "{}");
    expect(sent).toMatchObject({ spec_id: "s3", repository_id: "r1" });
    await run("create", "--repository", "acme/api", "--spec", "api", "--data", "{}");
    expect(sent).toMatchObject({ spec_id: "s1" });
    await expect(run("create", "--repository", "acme/api", "--group", "Dev", "--spec", "api", "--data", "{}")).rejects.toThrow(/No group named 'Dev'/);
  });

  it("create reads $NB_SPEC_ID, and refuses to run without a spec (nothing is sent)", async () => {
    vi.stubEnv("NB_SPEC_ID", "s1");
    await run("create", "--data", '{"url":"https://x.test"}');
    expect(sent).toMatchObject({ spec_id: "s1", repository_id: "r1" });
    vi.stubEnv("NB_SPEC_ID", "");
    sent = undefined;
    await expect(run("create", "--data", '{"url":"https://x.test"}')).rejects.toThrow(/Say which spec/);
    expect(sent).toBeUndefined();
  });

  it("a spec with no repository is refused", async () => {
    await expect(run("create", "--spec-id", "s2", "--data", "{}")).rejects.toThrow(/tied to no repository/);
    expect(sent).toBeUndefined();
  });

  it("update leaves the body alone unless it moves the monitor to a spec", async () => {
    // (the generated `update` also takes the monitor id as an argument; the miniature leaves it out)
    await run("update", "--data", '{"enabled":false}');
    expect(sent).toEqual({ enabled: false });
    expect(calls).toHaveLength(0);
    await run("update", "--spec-id", "s1", "--data", '{"enabled":false}');
    expect(sent).toEqual({ enabled: false, spec_id: "s1", repository_id: "r1" });
  });

  it("--api-version is part of the spec's key (left out, several API versions are an error that lists them)", async () => {
    await run("create", "--repository", "acme/api", "--api-version", "v2", "--spec", "multi", "--data", "{}");
    expect(sent).toMatchObject({ spec_id: "s6", repository_id: "r1" });
    await expect(run("create", "--repository", "acme/api", "--spec", "multi", "--data", "{}")).rejects.toThrow(/more than one API version.*v1, v2.*--api-version/s);
    await expect(run("create", "--spec-id", "s1", "--api-version", "v1", "--data", "{}")).rejects.toThrow(/do not combine/);
  });
});
