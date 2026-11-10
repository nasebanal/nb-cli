/**
 * `nb assurance monitors create` / `update`: an external monitor is about a SPEC that is tied to a repository, so the call carries
 * `spec_id` and `repository_id` (the contract refuses a monitor without both). The generated commands take the whole body as
 * `--data`; this adds the same way of naming the spec as `report upload` has - `--spec-id`, or `--repository` [`--component`] [`--group`]
 * [`--api-version`] `--spec` - and puts the two ids into the body before the generated action sends it. Without any of them the body is sent as it is
 * (an `update` that changes only the URL needs no spec; the API then keeps what the monitor has).
 */
import { type Command } from "commander";
import { readFileSync } from "node:fs";
import { resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { checkOrg, specsBaseUrl } from "../specs/push.js";
import { resolveSpec } from "../specs/resolve.js";
import { specRefOf } from "./upload.js";

interface SpecOptions {
  specId?: string;
  repository?: string;
  component?: string;
  group?: string;
  apiVersion?: string;
  spec?: string;
  repositoryProvider?: string;
  org?: string;
  data?: string;
  env?: string;
  token?: string;
}

function readBody(data: string | undefined): Record<string, unknown> {
  if (data === undefined) return {};
  const raw = data.startsWith("@") ? readFileSync(data.slice(1), "utf8") : data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--data must be valid JSON (or @file containing JSON); got: ${data}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--data must be a JSON object");
  return parsed as Record<string, unknown>;
}

const NAMES = ["specId", "repository", "component", "group", "apiVersion", "spec", "repositoryProvider"] as const;

/** Add the spec options to one generated leaf (`create` or `update`) and resolve them just before it runs. */
function attach(leaf: Command, required: boolean): void {
  leaf
    .option("--spec-id <id>", `the spec this monitor is about, by its id in the catalog${required ? " (default: $NB_SPEC_ID)" : ""}: sets spec_id and repository_id. Exclusive with --repository / --component / --spec`)
    .option("--repository <owner/name>", "by names: the repository the spec is tied to; needs --spec (--component optional: none = the repository as a whole)")
    .option("--component <name>", "by names: the component part of the repository's key; optional")
    .option("--group <name>", "by names: the group the spec is filed in (an environment, say); optional, none = the specs in no group (not any group)")
    .option("--api-version <v>", "by names: the API version (v1, v2) of the spec, part of its key; left out = the API version of the one spec the rest of the key matches (several: the error lists them)")
    .option("--spec <name>", "by names: the spec's name in the catalog; needs --repository")
    .option("--repository-provider <provider>", "with --repository: github | gitlab | bitbucket | other (default: github)");
  leaf.hook("preAction", async (thisCommand) => {
    const opts = thisCommand.optsWithGlobals() as SpecOptions;
    const asked = NAMES.some((n) => opts[n] !== undefined);
    const body = readBody(opts.data);
    // `create` must say which spec; `update` only when it moves the monitor (or the body already carries both ids).
    if (!asked && !required) return;
    if (!asked && body.spec_id !== undefined && body.repository_id !== undefined) return;
    const ref = specRefOf(opts);
    const env = (opts.env as Environment | undefined) || resolveEnv();
    const hit = await resolveSpec({ baseUrl: specsBaseUrl(env), token: opts.token || (await resolveAccessToken()), org: checkOrg(opts.org ?? process.env.NB_ASSURANCE_ORG ?? process.env.NB_SPECS_ORG) }, ref);
    thisCommand.setOptionValue("data", JSON.stringify({ ...body, spec_id: hit.spec_id, repository_id: hit.repository_id }));
  });
}

/** Called once on the generated `assurance` group. */
export function attachMonitorSpecOptions(assurance: Command): void {
  const monitors = assurance.commands.find((c) => c.name() === "monitors");
  if (!monitors) return;
  for (const [verb, required] of [["create", true], ["update", false]] as const) {
    const leaf = monitors.commands.find((c) => c.name() === verb);
    if (leaf) attach(leaf, required);
  }
}
