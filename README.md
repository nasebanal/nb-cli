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
the per-test cases) and reports it to a NASEBANAL Assurance project. The same line works in a pipeline and on a
laptop; in CI it needs only a token:

The **kind** is one of a fixed set of perspectives (`unit`, `e2e`, `contract`,
`security`, `load`); the **tool** is a free label (`vitest`, `pytest`, `playwright`,
`specmatic`, `zap`, `locust`, or `trivy`, `k6`, `cypress`...). What a result
means is carried by its kind and its numbers, so a scanner or runner can be swapped
without a change in Assurance. The CLI reads **JUnit XML** (any tool) and
**Locust CSV**; for a tool that writes something else, convert it to JUnit or give the
numbers with `--metric` (for a scanner: `critical`, `high`, `medium`, `low`, `info`).

```bash
export NB_TOKEN=nbpat_…        # a PAT or service-account token (no browser needed)

# JUnit XML: vitest (--reporter=junit), pytest (--junitxml), Specmatic, Playwright (--reporter=junit)
nb assurance report upload --file report/junit.xml --kind unit --tool pytest
nb assurance report upload --file results/junit.xml --kind e2e --tool playwright --component web

# Two scans of one tool on the same components (ZAP's baseline and full scan): a label tells them apart
nb assurance report upload --file report/baseline-junit.xml --kind security --tool zap --component frontend --label baseline
nb assurance report upload --file report/full-scan-junit.xml --kind security --tool zap --component frontend --label full-scan

# The tool's own version is informational and optional
nb assurance report upload --file report/junit.xml --kind unit --tool pytest --tool-version 9.1.0

# A result may be about several components: repeat the flag (new names are created in the project; none = `default`)
nb assurance report upload --file results/junit.xml --kind e2e --tool playwright --component frontend --component backend

# Specmatic: the JUnit XML, plus its HTML report for the API coverage (coverage_pct = operations exercised / operations in the spec)
nb assurance report upload --file specmatic/junit/TEST-junit-jupiter.xml --kind contract --tool specmatic \
  --coverage-report specmatic/report/test/html/index.html

# One repository, several API versions: label the result (the version is part of the suite's identity, so v1 and v2 of the same name sit side by side)
nb assurance report upload --file specmatic/v2/junit.xml --kind contract --tool specmatic --api-version v2
# unit tests hold for every version: leave --api-version out
# set NB_API_VERSION once (a CI variable per job or branch) instead of repeating the flag; the flag wins, an empty variable means none
NB_API_VERSION=v2 nb assurance report upload --file specmatic/v2/junit.xml --kind contract --tool specmatic
# a project may require a version for some kinds of result (Assurance > Projects > the project's settings): a result of such a kind
# without one is refused with 422 API_VERSION_REQUIRED (the message says to pass --api-version or set NB_API_VERSION)

# Extra numbers for the suite (repeatable), e.g. ZAP's findings by severity - what the Assurance security gate reads
nb assurance report upload --file zap/report/baseline-junit.xml --kind security --tool zap --metric high=0 --metric medium=3 --metric low=2

# Locust (--csv <prefix>): the *_stats.csv, with its *_failures / *_exceptions / *_stats_history siblings
nb assurance report upload --dir locust/logs/20261001_090000
```

- **Project:** found by name, created when missing (`--no-create-project` to fail
  instead). In CI the name defaults to the repository (`GITHUB_REPOSITORY` /
  `CI_PROJECT_PATH`); elsewhere pass `--project`. That is the zero-configuration
  start; once the project exists, **pin it by id** (`--project-id <id>` or
  `NB_ASSURANCE_PROJECT_ID`): the upload then goes straight to that project, nothing
  is looked up by name or created, so renaming the project, a typo, or a renamed
  repository can no longer send results elsewhere. An unknown id is an error, never a
  new project. The id is printed after every upload (and, in GitHub Actions, written
  to `$GITHUB_OUTPUT` as `project_id`). Keep one id per environment (`--env`), and
  take care when copying a workflow to another repository: its id goes with it.
- **Link to the report in the repository:** the CLI also sends the CI `--provider`
  (`github` | `gitlab` | `other`, detected) and, when the report file is **committed**
  (tracked, unchanged since `HEAD`, and `HEAD` is the reported commit), its path
  relative to the repository root, so Assurance can link to the file at that commit.
  A report that CI has just generated is not in the commit, so no path is sent;
  override with `--report-path`.
  The repository's web address is sent too (`repo_url`, detected from `GITHUB_SERVER_URL` /
  `CI_PROJECT_URL`; override with `--repo-url`), so the link also works on a self-hosted
  GitLab or GitHub Enterprise. The CI's repository also replaces the project's `repo`
  (the latest sender wins).
- **Tie the project to its API in the catalog (`--spec-id`, `--spec-environment`):**
  `--spec-id <id>` links the project to a spec of the API catalog (its id in Assurance /
  Specs), `--spec-environment production` says which environment of it the project covers
  (needs `--spec-id`). A new project is created already linked; an existing one is
  changed **only when it differs**, so a pipeline that runs on every commit writes nothing
  once the link is right. Pointing it at another spec clears the old environment unless one
  is given too. The id is not looked up in the catalog (it is another service): a typo shows
  as "no spec" on the project. The link is set after the result is in, so a failure there
  leaves the result reported and says so. `--spec-file <openapi.yaml>` does the whole chain in one command (see below).
- **Register the spec file and tie the project to it in one command (`--spec-file`):**
  `nb assurance report upload ... --spec-file openapi.yaml [--spec-name N] [--spec-group G]
  [--spec-org ID] [--spec-environment production]` first runs `nb specs push` on the file,
  then creates / links the project to the spec it returns, then reports the result. The
  catalog's answer never costs the result: if registering the spec fails (a plan without the
  catalog, the limit of specs), the result is still reported, without the link, and the command
  ends with the reason and a non-zero exit. Exclusive with `--spec-id`.
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
  project; the CLI checks the size before anything is sent. It is **opt-in twice** - nothing is
  attached unless you pass it, and the server refuses it (403 `ATTACHMENTS_DISABLED`) until
  the project has turned on "Attaching original reports" in its settings in Assurance (off by
  default). Make sure the report holds no secrets or personal data.
  The server only stores it (next to the result's cases, deleted with the result and by
  the project's retention) and offers it as a **download** to the project's members in
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

## The API catalog from a pipeline (`nb specs push`)

`nb specs push --file openapi.yaml` registers an OpenAPI document in the catalog (your own
specs, Evolution): a new spec, or a new version of the one that has the same name (or `--id`).
It is made to run on **every commit**:

- **A retitled document needs `--id`.** Without it the spec is found by its name (the document's
  `info.title`), so a new title registers a second spec next to the old one. `--id <id>` pushes to
  the spec you mean (a pipeline can read the id from `spec_id` of an earlier run), and adding
  `--rename` also renames the spec to `--name` (default: the new `info.title`); the old name is
  printed (`renamed_from` in the JSON). A rename happens only on request, so a name set by hand in
  the catalog is not overwritten on every push, and `--rename` without `--id` is refused.

- **Nothing is uploaded when the file is already the latest version.** The CLI compares the
  document's SHA-256 with the `content_hash` the catalog keeps for the latest version before it
  sends anything; the same bytes print `unchanged (already vN: nothing uploaded)`. (The catalog
  refuses an identical upload itself, `409 UNCHANGED`, which is also taken as "unchanged", for two
  jobs racing.) The comparison is of bytes: a generator that writes a timestamp into the
  document makes a new version every run, so keep the output stable.
- **No group has to exist.** A spec is registered in no group unless `--group <name>` is given
  (the group is made when missing); an existing spec is never moved by a push (the catalog
  moves it, by drag and drop or the select on its page).
- The name is `--name`, else the document's `info.title`, else the file's name. A new version
  carries a note made from the commit, the branch and the CI run (`--note` replaces it), so
  "which commit made v7" has an answer.
- `--org <id|personal>` (or `$NB_SPECS_ORG`) says whose catalog it is: the catalog is per
  owner and needs `X-Active-Organization-Id`; `personal` (the default) is your own, an
  organization's needs its Enterprise plan. `--dry-run` reads the catalog and says what would
  happen. `NB_SPECS_BASE_URL` points it at another host (local: `http://localhost:8792`).
- In GitHub Actions the spec's id is written to `$GITHUB_OUTPUT` as `spec_id`.

### Reading a version back (`nb specs pull`, `nb specs versions`)

A pipeline can work from the catalog's document instead of a copy kept in a repository (a
contract test with Specmatic against the API's provider side, a stub for a consumer, a client
generator):

```bash
nb specs versions --name "Billing API"                      # versions newest first, each with its sha256
nb specs pull --name "Billing API" --spec-version 3 --out spec.yaml
nb specs pull --id kMsl4TXEMmeN --spec-version 3 --hash <sha256> --out spec.yaml   # pinned: fails if it differs
nb specs pull --name "Billing API" > spec.yaml              # latest; the document is all of stdout
```

- **`--spec-version` is the catalog's version number** (1, 2, 3...: one per `nb specs push` that
  changed the document). It is not the API's URL version (`v1`, `v2`, the label of a test result
  in `nb assurance report upload --api-version`), not the document's own `info.version`, and not
  the CLI's own `nb --version`.
  Absent or `latest` is the newest; **pin a number in a pipeline**, `latest` moves.
- **The document comes back exactly as it was uploaded** (the bytes: a JSON document is not
  parsed and re-printed), and its SHA-256 is checked against the `content_hash` the catalog keeps
  for that version, so a document that did not arrive intact fails. `--hash <sha256>` pins what
  the pipeline expects, so a version that was replaced, or a name that now points at another
  spec, fails instead of testing the wrong thing. `nb specs versions` prints the hashes.
- A spec is named by `--id` (a rename cannot change it) or by `--name` (matched ignoring case).
  `--org <id|personal>` / `$NB_SPECS_ORG` and `NB_SPECS_BASE_URL` work as for `push`. With `--out`
  the details are printed as JSON; without it they go to stderr. In GitHub Actions `spec_id`,
  `spec_version` and `spec_hash` are written to `$GITHUB_OUTPUT`.
- The catalog has no "released" mark yet: unlike the `@nasebanal/api-specs-*` packages, which
  only advance once the provider has deployed, a pull of `latest` can return a version that
  nothing implements. Pinning a version (and its hash) is the safe way to use it today.

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
