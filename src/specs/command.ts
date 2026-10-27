/**
 * `nb specs` - the API catalog (your own OpenAPI documents) from the command line. Hand-written: the CLI's generated
 * command tree comes from the pinned contracts, and the catalog's is not among them.
 */
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { exportGithubOutput, printJson } from "../output.js";
import { detectCi } from "../reports/ci.js";
import { parseHash, parseVersion, pullSpec, specVersions } from "./pull.js";
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

interface ReadOptions {
  id?: string;
  name?: string;
  specVersion?: string;
  hash?: string;
  out?: string;
  org?: string;
  env?: string;
  token?: string;
}

async function connection(opts: ReadOptions) {
  const env = (opts.env as Environment | undefined) || resolveEnv();
  const token = opts.token || (await resolveAccessToken());
  return { baseUrl: specsBaseUrl(env), token, org: checkOrg(opts.org ?? process.env.NB_SPECS_ORG) };
}

export function buildPullCommand(): Command {
  return new Command("pull")
    .description("Read a version of a spec's document out of the API catalog, exactly as it was uploaded, and check its SHA-256. For a pipeline that works from the catalog's document (a contract test, a client generator)")
    .option("--id <id>", "the spec, by id (a rename cannot change it)")
    .option("--name <name>", "the spec, by its name in the catalog (matched ignoring case)")
    .option("--spec-version <n|latest>", "the catalog's version number (1, 2, 3...), not the API's v1 / v2 and not the CLI's own --version. Default: latest. Pin a number in a pipeline: 'latest' moves")
    .option("--hash <sha256>", "the SHA-256 the document must have (as 'nb specs versions' prints it): the pull fails when it differs")
    .option("--out <file>", "write the document here (default: to standard output, the details to standard error)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as ReadOptions;
      const result = await pullSpec({
        conn: await connection(opts),
        id: opts.id,
        name: opts.name,
        version: parseVersion(opts.specVersion),
        hash: parseHash(opts.hash),
      });
      const { text, ...details } = result;
      if (opts.out) {
        try {
          writeFileSync(opts.out, text);
        } catch (err) {
          throw new Error(`--out: cannot write ${opts.out}: ${(err as Error).message}`);
        }
        printJson({ ...details, out: opts.out });
      } else {
        process.stdout.write(text);
      }
      exportGithubOutput("spec_id", result.id);
      exportGithubOutput("spec_version", String(result.version));
      exportGithubOutput("spec_hash", result.content_hash);
      process.stderr.write(`✓ ${result.name} v${result.version} (sha256 ${result.content_hash.slice(0, 12)}..., ${result.size_bytes} bytes)${opts.out ? ` -> ${opts.out}` : ""}\n`);
    });
}

export function buildVersionsCommand(): Command {
  return new Command("versions")
    .description("List the versions of a spec in the API catalog, newest first, each with the SHA-256 of its document (what 'nb specs pull --hash' pins)")
    .option("--id <id>", "the spec, by id")
    .option("--name <name>", "the spec, by its name in the catalog (matched ignoring case)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as ReadOptions;
      const result = await specVersions({ conn: await connection(opts), id: opts.id, name: opts.name });
      printJson(result);
      const latest = result.versions[0];
      process.stderr.write(`✓ ${result.name}: ${result.versions.length} version${result.versions.length === 1 ? "" : "s"}${latest ? ` (latest v${latest.version})` : ""}\n`);
    });
}

export function buildSpecsCommand(): Command {
  return new Command("specs")
    .description("The API catalog: your own OpenAPI documents (NASEBANAL Evolution)")
    .addCommand(buildPushCommand())
    .addCommand(buildPullCommand())
    .addCommand(buildVersionsCommand());
}
