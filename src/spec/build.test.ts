import { describe, it, expect } from "vitest";
import { buildApiCommand } from "./build.js";
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
