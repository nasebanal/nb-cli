import { afterEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { buildApiCommand, headerFlag } from "./build.js";
import type { ApiEntry } from "../apis.js";

// These exercise the command-mapping rules against the synced specs. Run
// `npm run sync-specs` first (the build script does this automatically).
function leaves(api: ApiEntry): Set<string> {
  const root = buildApiCommand(api);
  const out = new Set<string>();
  const walk = (cmd: { name(): string; commands: any[] }, prefix: string[]) => {
    for (const c of cmd.commands) {
      const path = [...prefix, c.name()];
      if (c.commands.length === 0) out.add(path.join(" "));
      else walk(c, path);
    }
  };
  walk(root as any, []);
  return out;
}

describe("command mapping", () => {
  const target: ApiEntry = { name: "target", spec: "target.yaml", summary: "" };
  const account: ApiEntry = { name: "account", spec: "account.yaml", summary: "" };
  const recorder: ApiEntry = { name: "recorder", spec: "recorder.yaml", summary: "" };

  it("maps singleton GET to `get`, not `list`", () => {
    expect(leaves(account)).toContain("me get");
  });

  it("maps collection GET to `list` and POST to `create`", () => {
    const r = leaves(recorder);
    expect(r).toContain("records list");
    expect(r).toContain("records create");
  });

  it("maps item access by path param to get/delete", () => {
    const r = leaves(recorder);
    expect(r).toContain("records get");
    expect(r).toContain("records delete");
  });

  it("uses the trailing singular segment as an action verb", () => {
    const t = leaves(target);
    expect(t).toContain("shares accept");
    expect(t).toContain("shares reject");
    expect(t).toContain("shares transfer");
  });

  it("resolves with/without-id action collisions to a single command", () => {
    const t = [...leaves(target)].filter((c) => c === "shares accept");
    expect(t).toHaveLength(1);
  });

  // account 1.2.0 added `DELETE /api/v1/me` next to the existing `GET
  // /api/v1/me` and `/api/v1/me/tokens`. The singular-write rule wanted to name
  // the delete `me`, which is the group the other two live under, and commander
  // threw "cannot add command 'me' as already have command 'me'" — taking the
  // whole build down rather than mis-naming one command.
  it("keeps a singular write under its group when the segment is also a group", () => {
    const a = leaves(account);
    expect(a).toContain("me delete");
    expect(a).toContain("me get");
    expect(a).not.toContain("me");
  });

  it("still names singular writes after the segment when there is no group", () => {
    // `PUT /api/v1/me/profile` has nothing nested under it, so it keeps the
    // segment-as-action name rather than gaining a redundant `replace`.
    expect(leaves(account)).toContain("me profile");
  });

  it("never emits duplicate command paths", () => {
    for (const api of [account, recorder, target]) {
      const root = buildApiCommand(api);
      const seen = new Set<string>();
      const walk = (cmd: any, prefix: string[]) => {
        for (const c of cmd.commands) {
          const path = [...prefix, c.name()].join(" ");
          expect(seen.has(path), `duplicate: ${api.name} ${path}`).toBe(false);
          seen.add(path);
          walk(c, [...prefix, c.name()]);
        }
      };
      walk(root, []);
    }
  });
});

describe("the specs API (repositories and the catalog)", () => {
  const specs: ApiEntry = { name: "specs", spec: "specs.yaml", summary: "" };

  it("is generated like the other groups: <resource> <verb>", () => {
    const l = leaves(specs);
    for (const c of [
      "specs list",
      "specs get",
      "specs update",
      "specs delete",
      "specs versions list",
      "specs versions create",
      "repositories list",
      "repositories replace",
      "repositories get",
      "repositories update",
      "repositories delete",
      "groups list",
      "groups create",
      "access get",
    ]) {
      expect(l, c).toContain(c);
    }
  });

  it("names a header after its flag: the active organization is --org", () => {
    expect(headerFlag("X-Active-Organization-Id")).toBe("org");
    expect(headerFlag("x-active-organization-id")).toBe("org");
    expect(headerFlag("X-Request-Source")).toBe("request-source");
  });
});

describe("a header parameter (the catalog's active organization) on a generated command", () => {
  const specs: ApiEntry = { name: "specs", spec: "specs.yaml", summary: "" };
  let headers: Record<string, string>[];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const run = async (args: string[]) => {
    headers = [];
    vi.stubEnv("NB_BASE_URL", "http://specs.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ success: true, data: { data: [], total: 0, limit: 100 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>");
    program.addCommand(buildApiCommand(specs));
    const walk = (c: Command) => {
      c.exitOverride();
      c.commands.forEach(walk);
    };
    program.commands.forEach(walk);
    await program.parseAsync(["node", "nb", "--token", "tkn", "specs", ...args]);
  };

  it("sends --org as X-Active-Organization-Id, and `personal` when nothing is said (the header is required)", async () => {
    vi.stubEnv("NB_SPECS_ORG", "");
    await run(["repositories", "list", "--org", "7"]);
    expect(headers[0]["X-Active-Organization-Id"]).toBe("7");
    await run(["repositories", "list"]);
    expect(headers[0]["X-Active-Organization-Id"]).toBe("personal");
  });

  it("reads $NB_SPECS_ORG, which the flag beats", async () => {
    vi.stubEnv("NB_SPECS_ORG", "9");
    await run(["repositories", "list"]);
    expect(headers[0]["X-Active-Organization-Id"]).toBe("9");
    await run(["repositories", "list", "--org", "personal"]);
    expect(headers[0]["X-Active-Organization-Id"]).toBe("personal");
  });

  it("refuses an organization that is not an id before anything is sent", async () => {
    vi.stubEnv("NB_SPECS_ORG", "");
    await expect(run(["repositories", "list", "--org", "acme"])).rejects.toThrow(/organization id/);
    expect(headers).toHaveLength(0);
  });
});
