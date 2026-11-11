# NASEBANAL CLI

`nb` — a gcloud-style command-line interface for the NASEBANAL APIs.

The command tree is **generated from the OpenAPI contracts** published by
[`nb-api-specs`](https://github.com/nasebanal/nb-api-specs). Every endpoint
becomes a `nb <api> <resource> <verb>` command, so the CLI stays a pure function
of the API contracts — it is the command-line consumer in the NASEBANAL
Contract-Driven Development (CDD) pipeline, alongside the web frontends.

```console
$ nb account me get
$ nb record records list
$ nb target shares accept <id>
$ nb account me tokens create --data '{"name":"ci"}'
```

## Tech Stack

- **Language:** TypeScript (ESM, Node ≥ 20)
- **CLI framework:** commander
- **Spec parsing:** yaml
- **Contracts:** `@nasebanal/api-specs-*` (OpenAPI 3.0) — the same packages backends and frontends consume
- **Authentication:** browser/device-code Auth0 login, or a NASEBANAL Personal Access Token (`nbpat_…`)
- **Testing:** Vitest
- **Distribution:** npm (`npx @nasebanal/cli`); single-binary builds are a planned follow-up

## Reporting CI/CD test results (Assurance)

`nb assurance report upload` reads a test report on the runner, reduces it to a
small summary (counts, coverage-free metrics, the first failures, and for JUnit
the per-test cases) and reports it to a NASEBANAL Assurance **spec**: an API spec of the catalog that is tied to a repository
(see "Which spec a result or a monitor is about" below). The same line works in a pipeline and on a laptop; in CI it needs a
token and the spec's id:

The **kind** is one of a fixed set of perspectives (`unit`, `e2e`, `contract`,
`security`, `load`); the **tool** is a free label (`vitest`, `pytest`, `playwright`,
`specmatic`, `zap`, `locust`, or `trivy`, `k6`, `cypress`...). What a result
means is carried by its kind and its numbers, so a scanner or runner can be swapped
without a change in Assurance. The CLI reads **JUnit XML** (any tool) and
**Locust CSV**; for a tool that writes something else, convert it to JUnit or give the
numbers with `--metric` (for a scanner: `critical`, `high`, `medium`, `low`, `info`).

```bash
export NB_TOKEN=nbpat_…        # a PAT or service-account token (no browser needed)
export NB_SPEC_ID=…            # the spec's id in the catalog (Spec Management, or `nb specs specs list`; a CI variable)

# JUnit XML: vitest (--reporter=junit), pytest (--junitxml), Specmatic, Playwright (--reporter=junit)
nb assurance report upload --file report/junit.xml --kind unit --tool pytest
nb assurance report upload --file results/junit.xml --kind e2e --tool playwright

# By names instead of the id (all checked against the catalog; --component is optional: none = the repository as a whole;
# --group is optional too: none = the specs in no group, an environment is a group)
nb assurance report upload --file results/junit.xml --kind e2e --tool playwright \
  --repository nasebanal/nb-account-api --component account-internal --group Staging --spec "Account API (internal)"

# A result that belongs to the source, not to an environment (unit tests, a security scan), goes to EVERY spec of the repository
# at ONE API version (one per environment), one line each; refused for the other kinds. A repository row whose specs are all at one
# API version needs no --api-version; with several (v1 and v2 side by side) it is required: a release branch feeds its own version only
nb assurance report upload --file report/junit.xml --kind unit --tool vitest --repository nasebanal/nb-account-api --all-specs --api-version v1

# Two scans of one tool of the same spec (ZAP's baseline and full scan): a label tells them apart
nb assurance report upload --file report/baseline-junit.xml --kind security --tool zap --label baseline
nb assurance report upload --file report/full-scan-junit.xml --kind security --tool zap --label full-scan

# The tool's own version is informational and optional
nb assurance report upload --file report/junit.xml --kind unit --tool pytest --tool-version 9.1.0

# Specmatic: the JUnit XML, plus its HTML report for the API coverage (coverage_pct = operations exercised / operations in the spec)
nb assurance report upload --file specmatic/junit/TEST-junit-jupiter.xml --kind contract --tool specmatic \
  --coverage-report specmatic/report/test/html/index.html

# An API at several API versions (v1 and v2 side by side) is one SPEC per API version, so a result needs no version of its own: it
# goes to the spec it belongs to. By names, --api-version is part of the spec's KEY (it selects the spec; it is not a label of the result)
nb assurance report upload --file specmatic/v2/junit.xml --kind contract --tool specmatic \
  --repository nasebanal/nb-account-api --spec "Account API" --api-version v2
# NB_API_VERSION and the result's own api_version are retired (the variable is ignored with a warning); the API versions a result
# must name (the spec's "How results are handled") are gone with them

# Which contract the result was produced against: the SHA-256 of the contract document (the catalog's content_hash; `nb specs specs versions list`
# prints it), so Evolution can tell a result of the current revision from one of an older or an unknown one. Not the API version
# (v1, v2: the spec's) and not the document's info.version (edited by hand): a hash. Informational, not part of the result's identity.
nb assurance report upload --file specmatic/junit.xml --kind contract --tool specmatic --spec-hash 9f2c...64 hex characters
# or let the CLI hash the file the test ran against (a pinned package's spec.yaml hashes to what `nb specs specs push` of it registered)
nb assurance report upload --file specmatic/junit.xml --kind contract --tool specmatic \
  --contract-file node_modules/@nasebanal/api-specs-assurance/spec.yaml
# Evolution matches the hash against the revisions of this spec

# Extra numbers for the suite (repeatable), e.g. ZAP's findings by severity - what the Assurance security gate reads
nb assurance report upload --file zap/report/baseline-junit.xml --kind security --tool zap --metric high=0 --metric medium=3 --metric low=2

# Locust (--csv <prefix>): the *_stats.csv, with its *_failures / *_exceptions / *_stats_history siblings
nb assurance report upload --dir locust/logs/20261001_090000
```

- **Spec (the target of a report):** a result is reported to a **spec of the catalog that is tied to a
  repository**, by its id, `--spec-id <id>` or `$NB_SPEC_ID` (a pipeline's repository variable; it is not
  a secret, and it is not a file in the repository: a copy of a workflow keeps its own variable, so it
  cannot report into another API by accident), or by names, `--repository <owner/name> [--component <name>] [--group <name>] [--api-version <v>] --spec <name>`
  (+ `--repository-provider`, default `github`; no `--component` = the repository as a whole; no `--group` = the specs
  in no group, **not** any group; no `--api-version` = the API version of the one spec the rest of the key leaves, several
  are an error that lists them), which are checked against each other (the spec must be tied to exactly that group,
  repository row and API version; on a miss the error lists where the name does exist). `--all-specs` (with `--repository`
  [`--api-version`], instead of `--spec`) sends a `unit` or `security` result to every spec tied to that repository row at that API
  version. A name asked for wins over the variable; an id and
  names together are refused; with none the command stops before sending anything and says how. **Nothing is created:** a
  spec or a repository that the catalog does not have is an error that points at `nb specs`, and a spec tied to no
  repository is refused (the request carries the spec in the path and its `repository_id` in the body, and Assurance
  checks the pair with the catalog: `422 SPEC_WITHOUT_REPOSITORY` / `REPOSITORY_MISMATCH`). The ids are printed after
  every upload (and, in GitHub Actions, written to `$GITHUB_OUTPUT` as `spec_id` and `repository_id`). `--org <id|personal>`
  (or `$NB_SPECS_ORG`) says whose specs these are; it is sent to the catalog and, for an organization, to Assurance.
  Keep one id per environment (`--env`). **What this replaces:** `--repository-id` / `NB_REPOSITORY_ID` (a clear error says
  so for this release), the old `--component` of a result (the component is now part of the repository's key), `--project`,
  `--project-id`, `--no-create-project`, `--spec-environment` and `--spec-file` are gone: Assurance creates and links
  nothing, the spec and its repository belong to the catalog, and registering them is its own step (`nb specs`).
- **Link to the report in the repository:** the CLI also sends the CI `--provider`
  (`github` | `gitlab` | `other`, detected) and, when the report file is **committed**
  (tracked, unchanged since `HEAD`, and `HEAD` is the reported commit), its path
  relative to the repository root, so Assurance can link to the file at that commit.
  A report that CI has just generated is not in the commit, so no path is sent;
  override with `--report-path`.
  The repository's web address is sent too (`repo_url`, detected from `GITHUB_SERVER_URL` /
  `CI_PROJECT_URL`; override with `--repo-url`), so the link also works on a self-hosted
  GitLab or GitHub Enterprise.
- **Run:** every job of one pipeline run shares a run key (CI: `GITHUB_RUN_ID` +
  attempt, `CI_PIPELINE_ID`; locally `local-<sha>-<day>`), so a unit job and an e2e
  job land in the same run, and re-running a job replaces its own result.
  Commit, branch and CI URL are detected the same way; override with `--run-key`,
  `--commit`, `--branch`, `--ci-url`.
- **Keep the tool's own report (`--attach <file|folder>`):** a CI runner is thrown away
  when the job ends, and the summary above is not the tool's report (Playwright's HTML
  report, Specmatic's report, a JUnit file with everything in it). `--attach` sends the
  original with the result: a file as it is, a folder as a zip made by the CLI (regular
  files only, symbolic links are never followed). Up to 20 MiB per result and 200 MiB per
  repository; the CLI checks the size before anything is sent. It is **opt-in twice** - nothing is
  attached unless you pass it, and the server refuses it (403 `ATTACHMENTS_DISABLED`) until
  the spec has turned on "Attaching original reports" in its settings (off by
  default). Make sure the report holds no secrets or personal data.
  The server only stores it (next to the result's cases, deleted with the result and by
  the repository's retention) and offers it as a **download** to the repository's members in
  Assurance; it is never opened, unzipped or shown in the browser. A failed attachment
  leaves the result reported and the command exits non-zero with the reason.
- **Pass / fail:** JUnit - any failed or errored test fails the suite. Locust - an
  unhandled task exception, or a failure ratio above `--max-fail-ratio` (default
  `$LOCUST_MAX_FAIL_RATIO`, else 0), fails it - the same rule as nb-quickstarts'
  `locust/bin/exit_code.py`. `--status passed|failed` overrides either.
- **Per-test cases (JUnit):** every test is sent with its name, outcome, time and, for a
  failure, its message plus the stack trace, so the Assurance screens can list them. Up to
  5000 cases per suite - over that, failed and skipped tests are kept first and passed ones
  fill the rest; a failure text is clipped to 2000 characters, and about 1 MB of failure text
  is sent in total (names and outcomes always stay). Locust reports have no cases.
- `--dry-run` prints what would be sent and calls nothing.

## Repositories and the API catalog from a pipeline (`nb specs`)

`nb specs` is generated from the catalog's contract like every other group, so it reads
`nb specs <resource> <verb>`: `nb specs specs list`, `nb specs specs versions list <id>`,
`nb specs repositories get <id>`, `nb specs groups list`, and `--org <id|personal>` (or
`$NB_SPECS_ORG`) on each, since the catalog is per owner. The verbs a pipeline wants are
hand-written and sit in the same tree: `specs push`, `specs pull`, `specs settings` and `repositories upsert`.
The old direct form (`nb specs push`, `nb specs pull`, `nb specs versions`) still works, as hidden aliases.

**The commands match the screens.** Each sub-menu of NASEBANAL Evolution's *API management* manages one resource of
the catalog, and `nb specs <resource>` is that resource:

| Evolution screen | Resource | Command group | What it holds |
|---|---|---|---|
| Repository Management | repositories | `nb specs repositories` | `provider`, `name`, `component` and the one repository setting, `attachments_enabled` (`upsert --attachments`, `update --attachments`) |
| Spec Management | specs | `nb specs specs` | the spec (`push`, `update`, `delete`), its description document (`docs push|pull|delete`), the consumer-facing reference publishing (`update`: `reference_access`) and the quality settings: the public badge and report with their links (`settings`) |
| Catalog | (a read-only view of the specs) | `nb specs specs list` / `get` / `versions list` / `docs pull` | what is registered, its revisions and its description document, to read |

The quality settings (public badge and report with their links) are columns of the
**spec**; the repository is where it lives (its identity) and holds one setting, **attachments**: whether a result may
carry the original test report, which comes from the repository's CI. A spec is tied to a repository
optionally, so either can be registered first.

### Environments: one spec per environment, filed in a group

An API deployed to several environments (development, staging, production) is **one OpenAPI file in the
repository and one spec per environment**, each filed in a **group named after the environment**. What
differs between them is where the API is served, which is the document's top-level `servers`: `push
--server-url <url>` replaces it just before sending (see below), and the catalog's **contract hash**
(`latest_contract_hash`, which ignores `servers`) says whether two environments run the same contract.
A promotion is the same file pushed to the next environment's spec; a rollback is an older file pushed
as a new revision of that environment's spec (the history stays one straight line). A spec's key is its
**group, its repository row (provider, name, component), its API version and its name**: the same name may exist in other
groups, which is exactly the case of the same API in two environments.

```bash
# the first run makes the group, the repository and the spec (idempotent; nothing set on a screen is overwritten)
nb specs specs push --file openapi.yaml --group Staging --server-url https://staging.api.example.com/v1 \
  --repository nasebanal/nb-account-api --name "Account API"
# the spec's id goes to the environment's variable (GitHub: Settings > Environments > Staging > Variables)
#   NB_SPEC_ID=<spec_id printed above>
# every later run pushes a new version only if the document changed, and the test jobs report to NB_SPEC_ID
```

In GitHub Actions use **Environments**: the same workflow runs per environment and each environment carries
its own `NB_SPEC_ID`, so the report steps are written once.

### API versions: one spec per API version, one branch per version

The **API version** (`v1`, `v2`) is a property of the **spec**, and a new major API version is a **new spec**. The numbered
history inside a spec is its **revisions** (#1, #2, ...: one per push that changed the document; the catalog's `version`
field). `nb specs specs push` takes the API version from the document: the major of `info.version` (`1.8.0` -> `v1`,
`v2.0` -> `v2`, `1.0.0-rc.1` -> `v1`, `007.1` -> `v7`). A version that has no leading major (`2023-01`, `latest`, `1.x`) needs
`--api-version <v>`; an explicit one always wins. So:

- an additive change (an example, a new field) is a new **revision** of the same spec: bump `info.version` to `1.9.0`, push, and the
  spec is still `v1`;
- a breaking change is a new major (`2.0.0`): the same push makes the **v2 spec** and leaves v1 untouched; pushing a document of
  another major to a spec by `--id` is refused (`API_VERSION_MISMATCH`: register it as its own spec).

**A CI that names the API once: `--follow-version`.** The versions of one API are a family: each later version names the API's first
spec (its initial version) as `initial_spec_id`. Give the id of that FIRST spec and never change it:

```bash
nb specs specs push --file openapi.yaml --id <the API's first spec> --follow-version --server-url "$API_URL"
```

The document goes to the spec of ITS API version of that API (found by the API version, whichever spec of the family the id names).
When the API does not have that version yet the spec is made (named as the first spec is; the catalog keeps the family's group and
repository), so a new major (`2.0.0`) needs no change of the id. API versions are registered **in order**: the next one after the
highest the API has (v1, v2, then v3). A version that skips (v1, then v3) fails with the version that is next, and nothing is
registered (`--dry-run` says the same without writing): register a placeholder of the missing version first, then the real document
is a new revision of that spec afterwards. Needs `@nasebanal/api-specs-specs` 1.5.0 (`initial_spec_id`) on the catalog side.

To maintain several API versions, keep each one on a **branch** of the repository with its own OpenAPI file, and let the same CI
job push and report from whichever branch it runs on:

```bash
# main (v2, info.version 2.x) and release/v1 (v1, info.version 1.x): the same step on both branches
nb specs specs push --file openapi.yaml --group Production --server-url "$API_URL" --repository nasebanal/nb-account-api --name "Account API"
# test results: the spec of the branch's API version. Either the id (a variable per branch, picked in the workflow) ...
nb assurance report upload --file junit.xml --kind e2e --tool playwright --spec-id "${{ github.ref_name == 'main' && vars.NB_SPEC_ID_V2 || vars.NB_SPEC_ID_V1 }}"
# ... or by names, with the branch's API version
nb assurance report upload --file junit.xml --kind e2e --tool playwright \
  --repository nasebanal/nb-account-api --group Production --api-version "$API_VERSION" --spec "Account API"
# a result that belongs to the source goes to every environment of THIS API version only
nb assurance report upload --file junit.xml --kind unit --tool vitest --repository nasebanal/nb-account-api --all-specs --api-version "$API_VERSION"
```

`NB_SPEC_ID` is a per-repository or per-**environment** variable, not a per-branch one: with several API versions either pick
the id in the workflow as above (one variable per API version) or report by names with `--api-version`.

### A repository first (`nb specs repositories upsert`)

A **repository** is where one or more of your APIs are implemented (something that is not in git,
such as a vendor's delivery, is a repository with provider `other`). Its key is the **provider, the
name and the component**: the component is your own name for a part of it (`account-api`, `web`),
optional (none = the repository as a whole, which is a row of its own), and one id says which
repository AND which component. A part of a monorepo is simply another row. Register it once, by
hand or from the screen, and keep the id the catalog issues:

```bash
nb specs repositories upsert --provider github --name nasebanal/nb-recorder-api
# -> {"id":"kMsl4TXEMmeN","provider":"github","name":"nasebanal/nb-recorder-api","component":""}
nb specs repositories upsert --name nasebanal/nb-account-api --component account-internal
nb specs repositories upsert --name nasebanal/nb-recorder-api --attachments on   # applied only when it registers the repository
nb specs repositories update kMsl4TXEMmeN --attachments on                       # change it later (merged into --data)
```

It is idempotent (the same provider, name and component always answer the same id, and nothing
set on a screen is overwritten: `--attachments` is applied only when the call registers the repository), so it is safe to repeat. Give the id to the pipeline as the repository
variable `NB_REPOSITORY_ID` (it is not a secret, and it is not a file in the repository: a copy of
a template would report into another repository); `nb specs specs push` reads it (or takes `--repository-id`) to tie
the spec it registers. Test results do not use it: they are reported to the **spec** (`NB_SPEC_ID`), see below.

### Registering a spec (`nb specs specs push`)

`nb specs specs push --file openapi.yaml` registers an OpenAPI document in the catalog (your own
specs, Evolution): a new spec, or a new revision of the one that has the same name at the same API version (or `--id`).
It is made to run on **every commit**:

- **A spec's key is its group, its repository row, its API version and its name** (a name is unique within a group, a
  repository row, `repository + component`, and an API version; the ones with no group or no repository are unique among
  themselves). So the name is looked up **inside the group you name** with `--group`, **inside the
  repository you name** with `--repository [--component]` and **at the API version of the document** (its `info.version`,
  or `--api-version`; see "API versions" above): another group's, repository's or API version's spec of that
  name is not touched (a document of another major makes the new spec), and a spec with no repository is not adopted by name
  (use `--id` to tie one).
  **A group left out means "no group", not any group**: a name that exists only in groups is an error that
  lists them and asks for `--group` (or `--id`), instead of silently making a second spec. With no
  repository named, the spec that has none wins; a name held by exactly one spec is used; a name held by
  several specs under repositories is refused, listing them.
- **`--server-url <url>`** replaces the document's top-level `servers` with `[{ url }]` before sending: one file
  in the repository, one URL per environment. A JSON file is edited as JSON; a YAML file as **text** (comments and
  order kept) when the edit is proven safe (the document without `servers` must be identical), otherwise it is
  written again (the CLI says so: comments are not kept in what is pushed; the file on disk is never changed).
  The hash used for "unchanged" is of the text that is sent, so the same file to the same environment is
  unchanged on the next run; `--dry-run` shows `server_url`.

- **A retitled document needs `--id`.** Without it the spec is found by its name (the document's
  `info.title`), so a new title registers a second spec next to the old one. `--id <id>` pushes to
  the spec you mean (a pipeline can read the id from `spec_id` of an earlier run), and adding
  `--rename` also renames the spec to `--name` (default: the new `info.title`); the old name is
  printed (`renamed_from` in the JSON). A rename happens only on request, so a name set by hand in
  the catalog is not overwritten on every push, and `--rename` without `--id` is refused.

- **Nothing is uploaded when the file is already the latest revision.** The CLI compares the
  document's SHA-256 with the `content_hash` the catalog keeps for the latest revision before it
  sends anything; the same bytes print `unchanged (already rev N of vM: nothing uploaded)`. (The catalog
  refuses an identical upload itself, `409 UNCHANGED`, which is also taken as "unchanged", for two
  jobs racing.) The comparison is of bytes: a generator that writes a timestamp into the
  document makes a new revision every run, so keep the output stable.
- **No group has to exist.** A spec is registered in no group unless `--group <name>` is given
  (the group is made when missing, on the first run); an existing spec is never moved by a push (the
  catalog moves it, by drag and drop or the select on its page).
- The name is `--name`, else the document's `info.title`, else the file's name. A new revision
  carries a note made from the commit, the branch and the CI run (`--note` replaces it), so
  "which commit made revision 7" has an answer.
- **`--api-version <v>`** names the API version when the document's `info.version` gives none (and always wins over it); a bad
  label is refused before the catalog is read. The result prints `api_version`.
- `--org <id|personal>` (or `$NB_SPECS_ORG`) says whose catalog it is: the catalog is per
  owner and needs `X-Active-Organization-Id`; `personal` (the default) is your own, an
  organization's needs its Enterprise plan. `--dry-run` reads the catalog and says what would
  happen. `NB_SPECS_BASE_URL` points it at another host (local: `http://localhost:8792`).
- **A repository is optional.** `--repository-id <id>` (default `$NB_REPOSITORY_ID`) ties the spec
  to that repository: a new spec is created tied to it, an existing spec that has none is tied to
  it. `--repository <owner/name>` (+ `--provider`, default `github`, and the optional `--component`)
  registers the repository first, idempotently, and uses the id it returns, for a pipeline that would rather not keep an
  id. **A push never moves a spec:** one that is tied to another repository stays there and the
  command says so (`repository_kept` in the JSON). A spec uploaded by hand needs no repository.
- In GitHub Actions the spec's id is written to `$GITHUB_OUTPUT` as `spec_id`, and the repository's
  as `repository_id`.

### A spec's description document (`nb specs specs docs`)

One **Markdown file per spec** (up to 200 KiB, UTF-8), shown rendered in the catalog beside the API reference, like
a developer portal's overview page. It belongs to Spec Management; the catalog only shows it.

```bash
nb specs specs docs push --file README.md --spec-id kMsl4TXEMmeN     # added or replaced (201 / 200)
nb specs specs docs push --file docs/overview.md --spec "Account API" --group Staging --repository nasebanal/nb-account-api
nb specs specs docs pull --spec-id kMsl4TXEMmeN --out README.md      # or to standard output
nb specs specs docs delete --spec-id kMsl4TXEMmeN                    # also when there is none
```

The spec is named like everywhere else: `--spec-id` (default `$NB_SPEC_ID`), or `--spec <name>` with the optional
`--repository [--component]` and `--group`. For these verbs what is left out means none (a spec in no group, tied to no
repository), so a spec that is tied to a repository needs `--repository`. The catalog answers `413` over 200 KiB and `415`
for a body that is not Markdown; a missing file, an empty one and a binary one are refused before anything is sent. (This
group replaces the generated `docs` leaf, whose body would be JSON.)

### A spec's public settings (`nb specs specs settings`)

```bash
nb specs specs settings kMsl4TXEMmeN --public-badge on --report-access login
nb specs specs settings kMsl4TXEMmeN --rotate-quality-public-id     # new badge / report links; the old ones stop
```

One `PATCH /specs/{id}` with only the flags you pass (the same fields as the screen: `public_badge`,
`report_access` = `hidden` / `login` / `public`, `rotate_quality_public_id`); there is no API version rule any more (a spec has
one API version, so a result needs none); it prints the spec, including its `quality_public_id`. A spec starts
private. Attachments are the repository's, not the spec's (`nb specs repositories update <id> --attachments on`). (`nb specs specs update <id> --data '{...}'` does the same with a raw body.)

### Which spec a result or a monitor is about

Test results and external monitoring belong to a **spec that has a repository** (they are reported
against that repository row). A command that needs one takes the spec by id, `--spec-id <id>`, or by
the names of its key, `--repository <name> [--component <name>] [--group <name>] [--api-version <v>] --spec <name>`
(`--provider`, default `github`; no `--component` = the repository as a whole; no `--group` = the specs in no group, not any;
**no `--api-version` is the one exception to "left out means none"**: it is the API version of the one spec the rest of the key
leaves, and when it leaves several the error lists their API versions and asks for `--api-version`);
it never creates a spec or a
repository (`--no-create` has no meaning for specs: register them with `nb specs`), and a spec that is tied to
no repository is refused. The shared resolution is `resolveSpec` in `src/specs/resolve.ts`.

**API quality assessment: screens and commands.** The three screens under *API quality assessment* in
Evolution work on one API's data (Assurance), each of its sub-menus is a command group of `nb assurance`, and
what they work on is a spec:

| Evolution screen | Command | What it does |
|---|---|---|
| Charts | `nb assurance specs quality <id>` (and `nb assurance specs list` / `get`) | the quality dashboard data of a spec |
| Test results | `nb assurance report upload` (to send), `nb assurance specs runs ...`, `nb assurance specs results ...` | register and read results |
| External monitoring | `nb assurance monitors ...` | the monitors of a spec |

```bash
# A monitor is about a spec that has a repository: the spec by id or by names, put into the body as spec_id and repository_id
nb assurance monitors create --spec-id kMsl4TXEMmeN --data '{"url":"https://api.example.com/health","method":"GET","interval_minutes":5,"timeout_ms":10000}'
nb assurance monitors create --repository nasebanal/nb-account-api --spec "Account API" --data @monitor.json
nb assurance monitors update <monitor-id> --spec-id kMsl4TXEMmeN --data '{"enabled":true}'   # moves it to that spec
```

### Reading a revision back (`nb specs specs pull`, `nb specs specs versions list`)

A pipeline can work from the catalog's document instead of a copy kept in a repository (a
contract test with Specmatic against the API's provider side, a stub for a consumer, a client
generator):

```bash
nb specs specs versions list <id>                            # revisions newest first, each with its sha256
nb specs specs pull --name "Billing API" --group Production --repository nasebanal/billing --spec-version 3 --out spec.yaml
nb specs specs pull --id kMsl4TXEMmeN --spec-version 3 --hash <sha256> --out spec.yaml   # pinned: fails if it differs
nb specs specs pull --name "Billing API" > spec.yaml        # latest; the document is all of stdout
```

- **`--spec-version` is the catalog's revision number** (1, 2, 3...: one per `nb specs specs push` that
  changed the document). It is not the API version (`v1`, `v2`: a property of the spec), not the document's own
  `info.version`, and not the CLI's own `nb --version`.
  Absent or `latest` is the newest; **pin a number in a pipeline**, `latest` moves.
- **The document comes back exactly as it was uploaded** (the bytes: a JSON document is not
  parsed and re-printed), and its SHA-256 is checked against the `content_hash` the catalog keeps
  for that revision, so a document that did not arrive intact fails. `--hash <sha256>` pins what
  the pipeline expects, so a revision that was replaced, or a name that now points at another
  spec, fails instead of testing the wrong thing. `nb specs specs versions list` prints the hashes.
- A spec is named by `--id` (a rename cannot change it) or by `--name` (matched ignoring case); with `--group` and
  `--repository [--component]` and `--api-version` the name is looked up in that group, repository row and API version (its key), which is
  how the same name in two environments (or at two API versions) is told apart.
  `--org <id|personal>` / `$NB_SPECS_ORG` and `NB_SPECS_BASE_URL` work as for `push`. With `--out`
  the details are printed as JSON; without it they go to stderr. In GitHub Actions `spec_id`,
  `spec_version` and `spec_hash` are written to `$GITHUB_OUTPUT`.
- The catalog has no "released" mark yet: unlike the `@nasebanal/api-specs-*` packages, which
  only advance once the provider has deployed, a pull of `latest` can return a version that
  nothing implements. Pinning a revision (and its hash) is the safe way to use it today.

## Installation

The CLI installs the `nb` command. Node ≥ 20 is required.

### From the npm registry (end users)

`@nasebanal/cli` is published to the public npm registry — no `git clone`, no
registry configuration, no token:

```bash
npm install -g @nasebanal/cli   # global: the `nb` command on your PATH
nb --version
nb --help

# or run without installing (pin a version for reproducible scripts)
npx @nasebanal/cli@0.2.0 account me get
```

The published package bundles the OpenAPI specs, so no `nb-api-specs` checkout is
needed for a registry install.

> **NASEBANAL developers:** if your `~/.npmrc` maps `@nasebanal:registry` to
> GitHub Packages (needed for the private `@nasebanal/shared-navigation` /
> `api-specs-*` packages), it captures this package too. Install with
> `npm install -g @nasebanal/cli --@nasebanal:registry=https://registry.npmjs.org/`.

### Upgrading

```bash
nb upgrade           # install the latest published version
nb upgrade --check   # only report whether a newer version exists
```

When a newer version is out, interactive runs print a one-line notice on stderr
(`Update available: 0.5.0 -> 0.6.0`). The registry is checked at most once a day
and the result is cached in `~/.config/nasebanal/update-check.json`. Nothing is
printed when stderr is not a terminal or `CI` is set; `NB_NO_UPDATE_NOTIFIER=1`
turns the notice off. A dev link to a source checkout is never overwritten:
`nb upgrade` tells you to `git pull && npm run build` instead.

### Versioning and releases

Versions follow SemVer (0.x until 1.0: breaking changes bump the minor). Each
release bundles a fixed set of API contract versions, recorded in
[`spec-versions.json`](spec-versions.json).

### Releasing (maintainers)

Published to npmjs.org through npm **trusted publishing** (OIDC): no npm token is
stored anywhere, and none is needed to run the release script - what gates a release is
**write access to this repository** (the script pushes a branch and a tag; the `Release`
workflow then publishes, and npm accepts that only from this repo's `release.yml`). It does
not work from a fork.

Two commands, split by the PR merge (which stays yours; the script never merges):

```bash
bin/release.sh prepare 0.3.0   # before the merge: checks, version bump, tests, opens the release PR
# ... review and merge the PR ...
git checkout main && git pull
bin/release.sh publish         # after the merge: tags v0.3.0 (asks first), waits for the workflow, checks npm
```

Add `--dry-run` to either to do every check and print what it would do, writing nothing.

What it checks, and why:

- **Pinned contracts equal `released.json`.** The specs host serves only the latest
  version, so a stale `spec-versions.json` fails `sync-specs` with a 404 (it happened for
  `account` 1.4.0 -> 1.5.0). `prepare` stops and lists the differences;
  `prepare <version> --sync-pins` adopts the released versions in the release PR.
  Check https://api-specs.nasebanal.com/specs/released.json
- **Tag equals `package.json`'s version**, or the workflow fails.
- **The version is newer than `main`'s and not on npm yet**, and the tag does not exist.
- If the tag is pushed but the version is not on npm (the workflow failed), `publish` says
  so and prints the `gh run rerun <id> --failed` to carry on - **do not tag again**.

By hand (what the script does): bump `version` in `package.json` and `package-lock.json`
(PR to `main`, squash-merge), tag the merge commit (`git tag vX.Y.Z && git push origin vX.Y.Z`),
and the workflow type-checks, tests and runs `npm publish --provenance`.

#### One-time setup: the Trusted Publisher on npmjs.com

Trusted publishing must be switched on by hand, once per package, by a maintainer of
`@nasebanal/cli` (npm only allows it for a package that already exists, so the first version,
0.1.0, was published by hand). On https://www.npmjs.com/package/@nasebanal/cli/access ->
**Trusted Publisher** -> **GitHub Actions**:

| Field | Value |
|---|---|
| Organization or user | `nasebanal` |
| Repository | `nb-cli` |
| Workflow filename | `release.yml` (the file name only, exact case) |
| Environment name | empty (the workflow uses none) |
| Allowed actions | **tick "Allow `npm publish`"**; leave "Allow `npm dist-tag`" unticked |

Without that tick the publish fails with `npm error 404 ... could not be found or you do not
have permission` on the `PUT` - npm answers 404 for "not allowed", which reads like a missing
package. (This is how the first run of the workflow, for 0.2.0, failed: the setup was not done.)

Notes:

- A manual `npm publish` needs `--@nasebanal:registry=https://registry.npmjs.org/`
  if your `~/.npmrc` maps the `@nasebanal` scope to GitHub Packages (that mapping
  outranks `publishConfig.registry`; `publishConfig` also pins the scoped key as a
  safeguard). npm also requires a passkey (WebAuthn) 2FA for interactive publishes. The
  same override is needed for `npm view @nasebanal/cli` against the public registry.
- A freshly published version can 404 on the package document for a few minutes
  while npm's cache catches up; `npm view` with `--prefer-online` or a retry is
  enough (the script retries for you).

### From source (contributors)

No registry token and no sibling checkout needed: the build fetches the pinned,
public API contracts from `api-specs.nasebanal.com` (see
[Local Development](#local-development)). Contributing: see
[CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/nasebanal/nb-cli.git
cd nb-cli
npm install
npm run build          # sync specs + compile to dist/
npm link               # symlink the `nb` command onto your PATH
nb --help

# undo later with:  npm unlink -g @nasebanal/cli
```

Without linking, you can always run the compiled binary directly
(`node dist/index.js …`) or from source via `npm run dev -- …` (see
[Local Development](#local-development)).

### First run

```bash
nb auth login          # browser login (see Authentication below)
nb account me get      # verify the token works against a real API
```

## Command Mapping

The specs carry no `operationId` yet, so commands are derived deterministically
from each path + method:

| OpenAPI operation | Command |
|-------------------|---------|
| `GET /api/v1/me` (singleton) | `nb account me get` |
| `GET /api/v1/me/tokens` (collection) | `nb account me tokens list` |
| `POST /api/v1/me/tokens` | `nb account me tokens create --data '…'` |
| `DELETE /api/v1/me/tokens/{id}` | `nb account me tokens delete <id>` |
| `POST /api/v1/shares/{id}/accept` (action) | `nb target shares accept <id>` |
| `POST /api/v1/stripe/checkout` | `nb account stripe checkout --data '…'` |

Rules: a path ending in a plural noun is a collection (`list` / `create`); a
singular noun is a singleton (`get`) or, for write methods, an action whose
segment becomes the verb. Path parameters become positional arguments; query
parameters become `--flags`; a request body is `--data <json>` (or `--data @file`).
When two operations collapse to the same command (e.g. `/shares/accept` and
`/shares/{id}/accept`), the more specific one — more path parameters — wins.

> When the specs gain `operationId` / `x-cli-name` hints, `src/spec/build.ts` is
> the single place that consumes them. Adding those hints is the recommended way
> to refine command names without touching the CLI.

## Authentication

`nb auth login` opens a browser, you log in with Auth0, and control returns to
the terminal automatically — the same experience as `gcloud auth login`.

```bash
nb auth login                 # browser login (loopback OAuth + PKCE)
nb auth login --no-launch-browser  # device-code flow (SSH / headless boxes)
nb auth status                # show active credential source + environment
nb auth logout                # remove stored credentials
```

Under the hood this is OAuth 2.0 Authorization Code + PKCE against a shared
Auth0 **Native** application. On login the CLI stores the access token and a
refresh token; expired access tokens are refreshed automatically on the next
command, so you rarely need to log in again.

**PAT / CI auth** is still supported for scripting:

```bash
nb auth login --token nbpat_… # store a Personal Access Token non-interactively
nb auth login --token-stdin   # paste a PAT from stdin (no shell history)
NB_TOKEN=nbpat_… nb …         # env override (wins over everything; no login needed)
```

Create a PAT in the web app under **Settings → API tokens** (Account API).

- Credentials live at `~/.config/nasebanal/config.json` with `0600` permissions.
- Precedence on each request: `NB_TOKEN` env → OAuth tokens → stored PAT.

### Auth0 setup (one time, tenant admin)

The browser flow needs a public **Native** application in Auth0:

1. Create an Application of type **Native** (PKCE, no client secret).
2. Grant types: **Authorization Code**, **Refresh Token**, **Device Code**.
3. Allowed Callback URLs — this tenant validates the port, so register every
   loopback port the CLI may use (the CLI binds the first free one):
   `http://localhost:8085/callback, http://localhost:8086/callback, http://localhost:8087/callback, http://localhost:8088/callback, http://localhost:8089/callback`
   (`NB_AUTH0_REDIRECT_PORT` pins a single port if you prefer.)
4. Enable **Allow Offline Access** on the NASEBANAL API (for refresh tokens).
5. Put the resulting **Client ID** (public, not a secret) into `AUTH0_CLIENT_ID`
   in `src/oauth.ts`, or set `NB_AUTH0_CLIENT_ID` to test before baking it in.

Overridable env vars: `NB_AUTH0_DOMAIN`, `NB_AUTH0_AUDIENCE`,
`NB_AUTH0_CLIENT_ID`, `NB_AUTH0_REDIRECT_PORT`.

## Global Options

| Option | Description |
|--------|-------------|
| `--env <production\|local>` | Target environment; picks the matching `servers` entry from the spec. Also `NB_ENV`. |
| `--token <token>` | Override stored credentials with a PAT for one invocation. |
| `-V, --version` | Print the CLI version. |

The active environment defaults to `production`; `--env local` targets the
`wrangler dev` servers declared in each spec.

## Adding a New API

1. Publish/own its spec in `nb-api-specs` (it ships as `@nasebanal/api-specs-<api>`).
2. Add an entry to `API_CATALOG` in `src/apis.ts` and to the list in `scripts/sync-specs.mjs`.
3. `npm run sync-specs && npm run build` — the command group appears automatically.

## Project Structure

```
nb-cli/
├── src/
│   ├── index.ts            # Entry: global options, auth group, one group per API (★)
│   ├── apis.ts             # API catalog (★ register new APIs here)
│   ├── auth.ts             # `nb auth login | logout | status`
│   ├── oauth.ts            # Auth0 loopback + device-code login, PKCE, token refresh
│   ├── config.ts           # credentials + environment persisted to ~/.config/nasebanal/config.json
│   ├── http.ts             # base-URL resolution + bearer request layer
│   ├── output.ts           # JSON / error formatting
│   └── spec/
│       ├── loader.ts       # read + parse spec YAML from specs/
│       ├── build.ts        # ★ OpenAPI -> commander command tree (the core mapping)
│       └── build.test.ts   # command-mapping tests
├── scripts/
│   └── sync-specs.mjs      # Copy specs into specs/ (local dev convenience)
├── specs/                  # ★ Generated: OpenAPI specs, not committed (see below)
├── package.json
├── tsconfig.json
└── README.md
```

Files marked with ★ are the usual customization targets.

## Development

### Local Development

```bash
npm install
npm run sync-specs      # copy specs from a sibling nb-api-specs checkout into specs/
npm run dev -- --help   # run from source (tsx), e.g. `npm run dev -- account me get`
npm run build           # sync specs + type-check + emit dist/
npm test                # Vitest
npm run typecheck       # tsc --noEmit
```

`sync-specs` resolves each spec from, in order:

1. `node_modules/@nasebanal/api-specs-<api>/spec.yaml` (installed package), then
2. `../nb-api-specs/packages/<api>/spec.yaml` (local monorepo checkout), then
3. the version pinned in `spec-versions.json`, fetched from the public specs host
   (the only source under CI, and what an outside contributor gets).

In production the published `@nasebanal/api-specs-*` packages are pinned as
dependencies — the consumer side of CDD. In local dev we copy straight from the
sibling repo so contract edits are visible without a publish (mirroring how
`@nasebanal/shared-navigation` has both a published and a local-copy path).

### Conventions

- **The command surface is generated, not hand-written** — refine commands by
  improving the contract (e.g. add `operationId`), not by special-casing the CLI.
- **Specs are dependencies, not source** — `specs/` is git-ignored; production
  pins the published `@nasebanal/api-specs-*` packages.
- **Never commit a PAT** — config lives outside the repo; CI uses `NB_TOKEN`.
- **Deploy/release via PR merge and CI** — never publish from a local machine.

## License

MIT
