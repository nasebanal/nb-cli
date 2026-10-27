/**
 * `nb specs` - the API catalog (your own OpenAPI documents) from the command line. Hand-written: the CLI's generated
 * command tree comes from the pinned contracts, and the catalog's is not among them.
 */
import { Command } from "commander";
import { resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { exportGithubOutput, printJson } from "../output.js";
import { detectCi } from "../reports/ci.js";
import { checkOrg, ciNote, pushSpec, specsBaseUrl } from "./push.js";

interface PushOptions {
  file: string;
  name?: string;
  group?: string;
  description?: string;
  note?: string;
  id?: string;
  org?: string;
  dryRun?: boolean;
  env?: string;
  token?: string;
}

export function buildPushCommand(): Command {
  return new Command("push")
    .description("Register an OpenAPI file in the API catalog: a new spec, or a new version when its content changed. Safe to run on every commit: a file that is already the latest version uploads nothing")
    .requiredOption("--file <path>", "the OpenAPI document (YAML or JSON, up to 2 MiB)")
    .option("--name <name>", "the spec's name in the catalog (default: the document's info.title, then the file's name)")
    .option("--id <id>", "push to this spec by id: a rename cannot make a second one")
    .option("--group <name>", "file a NEW spec in this group (made when missing); default none. An existing spec is never moved by a push")
    .option("--description <text>", "a new spec's description")
    .option("--note <text>", "what changed, shown in the version list (default: the commit, branch and CI run)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .option("--dry-run", "read the catalog and say what would happen; write nothing")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as PushOptions;
      const env = (opts.env as Environment | undefined) || resolveEnv();
      const token = opts.token || (await resolveAccessToken());
      const ci = detectCi(process.env);
      const result = await pushSpec({
        conn: { baseUrl: specsBaseUrl(env), token, org: checkOrg(opts.org ?? process.env.NB_SPECS_ORG) },
        file: opts.file,
        name: opts.name,
        group: opts.group,
        description: opts.description,
        note: opts.note ?? ciNote(ci, undefined),
        id: opts.id,
        dryRun: opts.dryRun,
      });
      printJson(result);
      exportGithubOutput("spec_id", result.id);
      const what = { created: "created (v1)", new_version: `new version v${result.version}`, unchanged: `unchanged (already v${result.version}: nothing uploaded)` }[result.action];
      process.stderr.write(`${opts.dryRun ? "(dry run) " : ""}✓ ${result.name} -> ${what}\n`);
    });
}

export function buildSpecsCommand(): Command {
  return new Command("specs").description("The API catalog: your own OpenAPI documents (NASEBANAL Evolution)").addCommand(buildPushCommand());
}
