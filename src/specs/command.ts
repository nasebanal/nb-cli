/**
 * `nb specs` - repositories and the API catalog (your own OpenAPI documents). The tree is generated from the contract like
 * every other group (`nb specs specs list`, `nb specs repositories get <id>`, `nb specs groups ...`); the verbs a pipeline
 * wants and the contract cannot express are hand-written and attached to it by `attachSpecsCommands`: `specs push`,
 * `specs pull`, `specs settings` and `repositories upsert`. Each sub-menu of the Evolution screen API management has one resource:
 * Repository Management = `nb specs repositories` (provider, name, component and the one repository setting, `--attachments`),
 * Spec Management = `nb specs specs` (the spec, its description document `docs push|pull|delete`, and, since 2026-11-10, its public badge and report with their links). The key of a spec is its group, its repository row, its API version (v1, v2: a new major version is a new spec) and its name (an environment is a group); the numbered history inside a spec is its revisions. The old direct form (`nb specs push|pull|versions`) stays as hidden aliases.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { resolveAccessToken, resolveEnv, type Environment } from "../config.js";
import { exportGithubOutput, printJson } from "../output.js";
import { detectCi } from "../reports/ci.js";
import { docsDelete, docsPull, docsPush } from "./docs.js";
import { parseHash, parseVersion, pullSpec, specVersions } from "./pull.js";
import { checkServerUrl } from "./servers.js";
import { checkOrg, checkProvider, ciNote, pushSpec, specsBaseUrl, upsertRepository } from "./push.js";
import { onOff, parseSettingsFlags, updateSpecSettings } from "./settings.js";

interface PushOptions {
  file: string;
  apiVersion?: string;
  serverUrl?: string;
  name?: string;
  group?: string;
  description?: string;
  note?: string;
  id?: string;
  org?: string;
  dryRun?: boolean;
  rename?: boolean;
  repository?: string;
  provider?: string;
  component?: string;
  repositoryId?: string;
  env?: string;
  token?: string;
}

export function buildPushCommand(): Command {
  return new Command("push")
    .description("Register an OpenAPI file in the API catalog: a new spec, or a new revision when its content changed. Safe to run on every commit: a file that is already the latest revision uploads nothing")
    .requiredOption("--file <path>", "the OpenAPI document (YAML or JSON, up to 2 MiB)")
    .option("--name <name>", "the spec's name in the catalog (default: the document's info.title, then the file's name)")
    .option("--id <id>", "push to this spec by id: a rename cannot make a second one")
    .option("--rename", "with --id: also rename the spec to --name (default: the document's info.title) when it is called something else")
    .option("--group <name>", "the spec's group, part of its key (the same name may exist in other groups: an environment each): the spec is looked up in this group, and a NEW one is filed there (the group is made when missing). Default: no group, which does not mean any group: a name that exists only in groups is an error that lists them. An existing spec is never moved by a push")
    .option("--api-version <v>", "the spec's API version (v1, v2), part of its key: a new major API version is a new spec. Default: what the document's info.version gives (1.8.0 -> v1, v2.0 -> v2); needed when it gives none (2023-01, latest). A document of another major than an existing spec of that name makes the NEW spec for its API version and leaves the other alone"
    )
    .option("--server-url <url>", "replace the document's top-level `servers` with this one URL before sending (the environment's URL): one OpenAPI file in the repository, one spec per environment. A YAML file is edited as text (comments and order kept) when that can be proven safe, otherwise written again; the contract hash ignores `servers`, so the contract's identity does not change")
    .option("--description <text>", "a new spec's description")
    .option("--note <text>", "what changed, shown in the revision list (default: the commit, branch and CI run)")
    .option("--repository-id <id>", "tie the spec to this repository (the id `nb specs repositories upsert` printed; default: $NB_REPOSITORY_ID). A new spec is created tied to it; a spec with no repository is tied to it; one tied to another repository is left there")
    .option("--repository <name>", "tie the spec to the repository of this name (owner/name): it is registered first, idempotently, and its id used. Instead of --repository-id")
    .option("--provider <provider>", "with --repository: github | gitlab | bitbucket | other (default: github)")
    .option("--component <name>", "with --repository: the part of the repository the spec belongs to (account-api, web...); part of the repository's key. Default: none = the repository as a whole")
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
        apiVersion: opts.apiVersion,
        serverUrl: opts.serverUrl !== undefined ? checkServerUrl(opts.serverUrl) : undefined,
        description: opts.description,
        note: opts.note ?? ciNote(ci, undefined),
        id: opts.id,
        rename: opts.rename,
        // A name asked for wins over the id the pipeline's variable carries.
        repositoryId: opts.repository ? undefined : (opts.repositoryId ?? (process.env.NB_REPOSITORY_ID?.trim() || undefined)),
        repository: opts.repository,
        provider: opts.repository ? checkProvider(opts.provider) : undefined,
        component: opts.repository ? opts.component?.trim() || undefined : undefined,
        dryRun: opts.dryRun,
      });
      printJson(result);
      exportGithubOutput("spec_id", result.id);
      if (result.repository_id && result.repository_id !== "(new)") exportGithubOutput("repository_id", result.repository_id);
      if (result.repository_kept) {
        process.stderr.write(`! ${result.name} is tied to another repository (${result.repository_kept}); a push never moves a spec, so it was left there\n`);
      }
      if (result.servers_edit === "reserialised") process.stderr.write("! --server-url: the YAML file was written again (its comments are not kept in what was pushed); the file on disk is unchanged\n");
      const what = { created: `created (${result.api_version}, rev ${result.version})`, new_version: `new revision ${result.version} of ${result.api_version}`, unchanged: `unchanged (already rev ${result.version} of ${result.api_version}: nothing uploaded)` }[result.action];
      process.stderr.write(`${opts.dryRun ? "(dry run) " : ""}✓ ${result.renamed_from ? `${result.renamed_from} renamed to ` : ""}${result.name} -> ${what}\n`);
    });
}

interface ReadOptions {
  id?: string;
  name?: string;
  group?: string;
  apiVersion?: string;
  repository?: string;
  component?: string;
  provider?: string;
  specVersion?: string;
  hash?: string;
  out?: string;
  org?: string;
  env?: string;
  token?: string;
}

/** The group / repository / API version part of a spec's key, from the options (all absent = the name alone, as before). */
function whereOf(opts: ReadOptions) {
  if (opts.repository === undefined && opts.group === undefined && opts.component === undefined && opts.provider === undefined && opts.apiVersion === undefined) return undefined;
  if (opts.repository === undefined && (opts.component !== undefined || opts.provider !== undefined)) throw new Error("--component and --provider need --repository");
  return { group: opts.group, repository: opts.repository, component: opts.component, apiVersion: opts.apiVersion, provider: opts.repository ? checkProvider(opts.provider) : undefined };
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
    .option("--group <name>", "with --name: the group the spec is in (part of its key); none = no group")
    .option("--api-version <v>", "with --name: the spec's API version (v1, v2), part of its key; left out = the API version of the one spec the rest of the key matches (several: the error lists them)")
    .option("--repository <owner/name>", "with --name: the repository the spec is tied to (part of its key); none = a spec tied to no repository")
    .option("--component <name>", "with --repository: the component part of its key (none = the repository as a whole)")
    .option("--provider <provider>", "with --repository: github | gitlab | bitbucket | other (default: github)")
    .option("--spec-version <n|latest>", "the catalog's revision number (1, 2, 3...), not the API's v1 / v2 and not the CLI's own --version. Default: latest. Pin a number in a pipeline: 'latest' moves")
    .option("--hash <sha256>", "the SHA-256 the document must have (as 'nb specs versions' prints it): the pull fails when it differs")
    .option("--out <file>", "write the document here (default: to standard output, the details to standard error)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as ReadOptions;
      const result = await pullSpec({
        conn: await connection(opts),
        id: opts.id,
        name: opts.name,
        where: whereOf(opts),
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
      process.stderr.write(`✓ ${result.name} rev ${result.version} (sha256 ${result.content_hash.slice(0, 12)}..., ${result.size_bytes} bytes)${opts.out ? ` -> ${opts.out}` : ""}\n`);
    });
}

export function buildVersionsCommand(): Command {
  return new Command("versions")
    .description("List the revisions of a spec in the API catalog, newest first, each with the SHA-256 of its document (what 'nb specs pull --hash' pins)")
    .option("--id <id>", "the spec, by id")
    .option("--name <name>", "the spec, by its name in the catalog (matched ignoring case)")
    .option("--group <name>", "with --name: the group the spec is in (part of its key); none = no group")
    .option("--api-version <v>", "with --name: the spec's API version (v1, v2), part of its key; left out = the API version of the one spec the rest of the key matches (several: the error lists them)")
    .option("--repository <owner/name>", "with --name: the repository the spec is tied to (part of its key); none = a spec tied to no repository")
    .option("--component <name>", "with --repository: the component part of its key (none = the repository as a whole)")
    .option("--provider <provider>", "with --repository: github | gitlab | bitbucket | other (default: github)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as ReadOptions;
      const result = await specVersions({ conn: await connection(opts), id: opts.id, name: opts.name, where: whereOf(opts) });
      printJson(result);
      const latest = result.versions[0];
      process.stderr.write(`✓ ${result.name}: ${result.versions.length} revision${result.versions.length === 1 ? "" : "s"}${latest ? ` (latest rev ${latest.version})` : ""}\n`);
    });
}

interface DocsOptions {
  file?: string;
  out?: string;
  specId?: string;
  spec?: string;
  repository?: string;
  component?: string;
  group?: string;
  apiVersion?: string;
  provider?: string;
  org?: string;
  env?: string;
  token?: string;
}

/** The spec a `docs` verb is about: `--spec-id` (default $NB_SPEC_ID), or `--spec` with the optional repository / component / group. */
function docsRefOf(opts: DocsOptions) {
  const byNames = [opts.spec, opts.repository, opts.component, opts.group, opts.apiVersion].some((v) => v !== undefined && v.trim() !== "");
  if (opts.specId !== undefined && byNames) throw new Error("--spec-id names the spec by itself: do not combine it with --spec, --repository, --component, --group or --api-version");
  if (byNames) return { spec: opts.spec, repository: opts.repository, component: opts.component, group: opts.group, apiVersion: opts.apiVersion, provider: opts.provider };
  const specId = (opts.specId ?? process.env.NB_SPEC_ID)?.trim();
  if (specId) return { specId };
  throw new Error("Say which spec: --spec-id <id> (or set NB_SPEC_ID), or --spec <name> [--repository <name> [--component <name>]] [--group <name>]");
}

function withSpecOptions(cmd: Command): Command {
  return cmd
    .option("--spec-id <id>", "the spec, by its id in the catalog (default: $NB_SPEC_ID). Exclusive with the names below")
    .option("--spec <name>", "by names: the spec's name")
    .option("--repository <owner/name>", "by names: the repository the spec is tied to; none = a spec tied to no repository")
    .option("--component <name>", "by names, with --repository: the component part of its key (none = the repository as a whole)")
    .option("--group <name>", "by names: the group the spec is filed in; none = a spec in no group (not any group)")
    .option("--api-version <v>", "by names: the spec's API version (v1, v2), part of its key; left out = the API version of the one spec the rest of the key matches (several: the error lists them)")
    .option("--provider <provider>", "with --repository: github | gitlab | bitbucket | other (default: github)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)");
}

export function buildDocsCommand(): Command {
  const docs = new Command("docs").description("The spec's description document: ONE Markdown file per spec (up to 200 KiB), shown rendered in the catalog, like a developer portal's overview page");
  docs.addCommand(
    withSpecOptions(new Command("push").description("Upload a Markdown file as the spec's description document (replaces the one it has)").requiredOption("--file <path>", "the Markdown file (up to 200 KiB, UTF-8)")).action(
      async (_flags: unknown, command: Command) => {
        const opts = command.optsWithGlobals() as DocsOptions;
        const ref = docsRefOf({ ...opts, provider: opts.repository ? checkProvider(opts.provider) : undefined });
        const result = await docsPush({ conn: await connection(opts), ref, file: opts.file as string });
        printJson(result);
        exportGithubOutput("spec_id", result.spec_id);
        process.stderr.write(`✓ ${result.spec_name}: description document ${result.created ? "added" : "replaced"} (${result.size_bytes} bytes)\n`);
      },
    ),
  );
  docs.addCommand(
    withSpecOptions(new Command("pull").description("Print the spec's description document (or write it with --out)").option("--out <file>", "write the document here (default: standard output)")).action(
      async (_flags: unknown, command: Command) => {
        const opts = command.optsWithGlobals() as DocsOptions;
        const ref = docsRefOf({ ...opts, provider: opts.repository ? checkProvider(opts.provider) : undefined });
        const result = await docsPull({ conn: await connection(opts), ref });
        if (opts.out) {
          try {
            writeFileSync(opts.out, result.text);
          } catch (err) {
            throw new Error(`--out: cannot write ${opts.out}: ${(err as Error).message}`);
          }
          printJson({ spec_id: result.spec_id, spec_name: result.spec_name, out: opts.out });
        } else {
          process.stdout.write(result.text);
        }
        process.stderr.write(`✓ ${result.spec_name}: description document (${Buffer.byteLength(result.text, "utf8")} bytes)${opts.out ? ` -> ${opts.out}` : ""}\n`);
      },
    ),
  );
  docs.addCommand(
    withSpecOptions(new Command("delete").description("Remove the spec's description document (safe when there is none)")).action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as DocsOptions;
      const ref = docsRefOf({ ...opts, provider: opts.repository ? checkProvider(opts.provider) : undefined });
      const result = await docsDelete({ conn: await connection(opts), ref });
      printJson(result);
      process.stderr.write(`✓ ${result.spec_name}: description document removed\n`);
    }),
  );
  return docs;
}

interface UpsertOptions {
  provider?: string;
  name: string;
  component?: string;
  attachments?: string;
  org?: string;
  env?: string;
  token?: string;
}

export function buildUpsertCommand(): Command {
  return new Command("upsert")
    .description("Register a repository by provider and name and print it, with the id the catalog issued for it. Safe to repeat: the same repository always answers the same id (and nothing set on a screen is overwritten). Run it once by hand, then give the id to the pipeline as NB_REPOSITORY_ID")
    .requiredOption("--name <name>", "the repository: owner/name for github, gitlab and bitbucket; any text for 'other' (a delivery that is not in git)")
    .option("--provider <provider>", "github | gitlab | bitbucket | other (default: github)")
    .option("--component <name>", "the part of the repository (account-api, web...), at most 100 characters; with the provider and the name it is the key, and one id says which repository AND which component. Default: none = the repository as a whole")
    .option("--attachments <on|off>", "a result of this repository may carry the original test report (kept in R2); applied only when this call registers the repository, an existing one is left as it is (change it with `repositories update --attachments`)")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as UpsertOptions;
      const attachments = opts.attachments === undefined ? undefined : onOff("--attachments", opts.attachments);
      const repo = await upsertRepository(await connection(opts), checkProvider(opts.provider), opts.name.trim(), opts.component?.trim() ?? "", attachments);
      const { created, ...row } = repo;
      printJson(row);
      exportGithubOutput("repository_id", repo.id);
      process.stderr.write(`✓ ${repo.provider} ${repo.name}${repo.component ? ` / ${repo.component}` : ""} -> ${repo.id} (${created ? "registered" : "already registered"})\n`);
    });
}

interface SettingsOptions {
  publicBadge?: string;
  reportAccess?: string;
  rotateQualityPublicId?: boolean;
  org?: string;
  env?: string;
  token?: string;
}

export function buildSettingsCommand(): Command {
  return new Command("settings")
    .description("Change a spec's public settings (the Spec screen's public badge and report with their links), and print the spec. Only the flags you pass change; the rest is left as it is. Attachments are the repository's: `nb specs repositories update --attachments`")
    .argument("<id>", "the spec's id")
    .option("--public-badge <on|off>", "the quality badge is readable without a login while it is on")
    .option("--report-access <hidden|login|public>", "who may read the quality report: nobody, anyone signed in with the link, or anyone with the link")
    .option("--rotate-quality-public-id", "issue a new token for the public badge and report links: every old link stops working")
    .option("--org <id>", "the organization whose catalog it is (an id), or 'personal' (default; or $NB_SPECS_ORG)")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as SettingsOptions;
      const patch = parseSettingsFlags(opts);
      const spec = await updateSpecSettings(await connection(opts), id, patch);
      printJson(spec);
      process.stderr.write(`✓ ${spec.name}: ${Object.keys(patch).join(", ")} updated\n`);
    });
}

/**
 * The generated `repositories update` takes the whole body as `--data`; this adds `--attachments <on|off>` to it (the repository's
 * one setting) and puts `attachments_enabled` into the body just before the generated action sends it. Without the flag the body
 * is sent as it is.
 */
export function attachRepositoryAttachments(repositories: Command): void {
  const leaf = repositories.commands.find((c) => c.name() === "update");
  if (!leaf) return;
  leaf.option("--attachments <on|off>", "a result of this repository may carry the original test report (kept in R2); merged into --data as attachments_enabled");
  leaf.hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals() as { attachments?: string; data?: string };
    if (opts.attachments === undefined) return;
    const attachments = onOff("--attachments", opts.attachments);
    let body: Record<string, unknown> = {};
    if (opts.data !== undefined) {
      const raw = opts.data.startsWith("@") ? readFileSync(opts.data.slice(1), "utf8") : opts.data;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`--data must be a JSON object (or @file containing one); got: ${opts.data}`);
      }
    }
    thisCommand.setOptionValue("data", JSON.stringify({ ...body, attachments_enabled: attachments }));
  });
}

/** The hand-written verbs on the generated `specs` group, in the same `<resource> <verb>` shape as the rest of the tree. */
export function attachSpecsCommands(group: Command): Command {
  const child = (name: string): Command => {
    const existing = group.commands.find((c) => c.name() === name);
    if (existing) return existing;
    const made = new Command(name).description(`${name} commands`);
    group.addCommand(made);
    return made;
  };
  const specsResource = child("specs");
  // The contract's docs routes generate a `docs` leaf (a JSON body for PUT): the description document is Markdown, so the hand-written
  // `docs push|pull|delete` group takes its place.
  const generated = specsResource.commands.findIndex((c) => c.name() === "docs");
  if (generated >= 0) (specsResource.commands as Command[]).splice(generated, 1);
  specsResource.addCommand(buildPushCommand()).addCommand(buildPullCommand()).addCommand(buildSettingsCommand()).addCommand(buildDocsCommand());
  child("repositories").addCommand(buildUpsertCommand());
  attachRepositoryAttachments(child("repositories"));
  // The old direct form (`nb specs push`) keeps working for pipelines already written that way; it is not advertised.
  group.addCommand(buildPushCommand(), { hidden: true });
  group.addCommand(buildPullCommand(), { hidden: true });
  group.addCommand(buildVersionsCommand(), { hidden: true });
  return group;
}

/** The old standalone `nb specs push|pull|versions` group, as it was before the tree was generated (the tests drive it). */
export function buildSpecsCommand(): Command {
  return new Command("specs")
    .description("The API catalog: your own OpenAPI documents (NASEBANAL Evolution)")
    .addCommand(buildPushCommand())
    .addCommand(buildPullCommand())
    .addCommand(buildVersionsCommand());
}
