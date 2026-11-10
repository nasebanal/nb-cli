import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { parseSettingsFlags, updateSpecSettings } from "./settings.js";
import { attachRepositoryAttachments, buildSettingsCommand, buildUpsertCommand } from "./command.js";

describe("parseSettingsFlags", () => {
  it("turns the flags into the PATCH body, only the ones given", () => {
    expect(parseSettingsFlags({ publicBadge: "on" })).toEqual({ public_badge: true });
    expect(parseSettingsFlags({ publicBadge: "OFF", reportAccess: "Login" })).toEqual({ public_badge: false, report_access: "login" });
    expect(parseSettingsFlags({ rotateQualityPublicId: true })).toEqual({ rotate_quality_public_id: true });
  });

  it("has no API version rule any more: a spec has one API version, so a result needs none", () => {
    expect(() => parseSettingsFlags({ apiVersionRequiredKinds: "unit" } as never)).toThrow(/Nothing to change/);
  });

  it("refuses a wrong value, and a call that changes nothing", () => {
    expect(() => parseSettingsFlags({ publicBadge: "maybe" })).toThrow(/--public-badge 'maybe' must be on or off/);
    expect(() => parseSettingsFlags({ reportAccess: "everyone" })).toThrow(/--report-access 'everyone' must be one of: hidden, login, public/);
    expect(() => parseSettingsFlags({})).toThrow(/Nothing to change/);
  });
});

describe("nb specs specs settings", () => {
  let calls: { method: string; path: string; body: unknown }[];
  let stdout: string[];
  beforeEach(() => {
    calls = [];
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("NB_BASE_URL", "");
    vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
    vi.stubEnv("NB_SPECS_ORG", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const url = new URL(String(input));
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method: String(init.method), path: url.pathname, body });
        return new Response(JSON.stringify({ success: true, data: { id: "s1", name: "Billing API", public_badge: true, report_access: "public", api_version_required_kinds: [], quality_public_id: "tok" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends one PATCH to the spec with only the settings asked for and prints the spec", async () => {
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>").addCommand(buildSettingsCommand());
    program.commands.forEach((c) => c.exitOverride());
    await program.parseAsync(["node", "nb", "--token", "tkn", "settings", "s1", "--public-badge", "on", "--report-access", "public"]);
    expect(calls).toEqual([{ method: "PATCH", path: "/api/v1/specs/s1", body: { public_badge: true, report_access: "public" } }]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ id: "s1", quality_public_id: "tok" });
  });

  it("no longer takes --attachments: that setting is the repository's", async () => {
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>").addCommand(buildSettingsCommand());
    program.commands.forEach((c) => c.exitOverride());
    await expect(program.parseAsync(["node", "nb", "--token", "tkn", "settings", "s1", "--attachments", "on"])).rejects.toThrow(/unknown option '--attachments'/);
    expect(calls).toEqual([]);
  });

  it("explains the catalog's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Spec not found" } }), { status: 404, headers: { "Content-Type": "application/json" } })));
    await expect(updateSpecSettings({ baseUrl: "http://specs.test", token: "t", org: "personal" }, "x", { public_badge: true })).rejects.toThrow(/The catalog refused the settings: Spec not found/);
  });
});

describe("the repository's attachments setting (`repositories upsert|update --attachments`)", () => {
  let calls: { method: string; path: string; body: unknown }[];
  beforeEach(() => {
    calls = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("NB_BASE_URL", "");
    vi.stubEnv("NB_SPECS_BASE_URL", "http://specs.test");
    vi.stubEnv("NB_SPECS_ORG", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ method: String(init.method), path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ success: true, data: { id: "rp1", provider: "github", name: "acme/api", component: "", attachments_enabled: true } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("upsert sends attachments_enabled only when the flag is given", async () => {
    const run = async (extra: string[]) => {
      const program = new Command().exitOverride().option("--env <env>").option("--token <token>").addCommand(buildUpsertCommand());
      program.commands.forEach((c) => c.exitOverride());
      await program.parseAsync(["node", "nb", "--token", "tkn", "upsert", "--name", "acme/api", ...extra]);
    };
    await run([]);
    await run(["--attachments", "on"]);
    expect(calls.map((c) => c.body)).toEqual([{ provider: "github", name: "acme/api" }, { provider: "github", name: "acme/api", attachments_enabled: true }]);
  });

  it("upsert refuses a value that is not on or off", async () => {
    const program = new Command().exitOverride().option("--env <env>").option("--token <token>").addCommand(buildUpsertCommand());
    program.commands.forEach((c) => c.exitOverride());
    await expect(program.parseAsync(["node", "nb", "--token", "tkn", "upsert", "--name", "acme/api", "--attachments", "maybe"])).rejects.toThrow(/--attachments 'maybe' must be on or off/);
    expect(calls).toEqual([]);
  });

  it("the generated `repositories update` gets --attachments, merged into its --data before it runs", async () => {
    const seen: (string | undefined)[] = [];
    // A fresh program per call: commander keeps option values between parses of the same one.
    const run = async (args: string[]) => {
      const repositories = new Command("repositories");
      repositories.addCommand(
        new Command("update").argument("<id>").option("--data <json>").action((_id: string, _flags: unknown, command: Command) => {
          seen.push((command.optsWithGlobals() as { data?: string }).data);
        }),
      );
      attachRepositoryAttachments(repositories);
      await new Command().exitOverride().addCommand(repositories).parseAsync(["node", "nb", "repositories", "update", "rp1", ...args]);
    };
    await run(["--attachments", "off", "--data", '{"name":"acme/renamed"}']);
    await run(["--data", '{"name":"x"}']);
    await run(["--attachments", "on"]);
    expect(seen.map((d) => (d === undefined ? d : JSON.parse(d)))).toEqual([{ name: "acme/renamed", attachments_enabled: false }, { name: "x" }, { attachments_enabled: true }]);
  });
});
