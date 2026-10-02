# NASEBANAL CLI

`nb` — a gcloud-style command-line interface for the NASEBANAL APIs.

The command tree is **generated from the OpenAPI contracts** published by
[`nb-api-specs`](https://github.com/nasebanal/nb-api-specs). Every endpoint
becomes a `nb <api> <resource> <verb>` command, so the CLI stays a pure function
of the API contracts — it is the command-line consumer in the NASEBANAL
Contract-Driven Development (CDD) pipeline, alongside the web frontends.

```console
$ nb account me get
$ nb recorder records list
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
small summary (counts, coverage-free metrics, the first failures) and reports it
to a NASEBANAL Assurance project. The same line works in a pipeline and on a
laptop; in CI it needs only a token:

Only these tool / kind pairs are accepted; anything else is refused before
anything is read or sent (the API enforces the same list):

| `--kind` | `--tool` | Report format |
|---|---|---|
| `unit` | `vitest`, `pytest` | JUnit XML |
| `e2e` | `playwright` | JUnit XML |
| `contract` | `specmatic` | JUnit XML |
| `security` | `zap` | JUnit XML |
| `load` | `locust` | Locust CSV |

```bash
export NB_TOKEN=nbpat_…        # a PAT or service-account token (no browser needed)

# JUnit XML: vitest (--reporter=junit), pytest (--junitxml), Specmatic, Playwright (--reporter=junit)
nb assurance report upload --file report/junit.xml --kind unit --tool pytest
nb assurance report upload --file results/junit.xml --kind e2e --tool playwright --suite web

# Locust (--csv <prefix>): the *_stats.csv, with its *_failures / *_exceptions / *_stats_history siblings
nb assurance report upload --dir locust/logs/20261001_090000
```

- **Project:** found by name, created when missing (`--no-create-project` to fail
  instead). In CI the name defaults to the repository (`GITHUB_REPOSITORY` /
  `CI_PROJECT_PATH`); elsewhere pass `--project`.
- **Run:** every job of one pipeline run shares a run key (CI: `GITHUB_RUN_ID` +
  attempt, `CI_PIPELINE_ID`; locally `local-<sha>-<day>`), so a unit job and an e2e
  job land in the same run, and re-running a job replaces its own result.
  Commit, branch and CI URL are detected the same way; override with `--run-key`,
  `--commit`, `--branch`, `--ci-url`.
- **Pass / fail:** JUnit - any failed or errored test fails the suite. Locust - an
  unhandled task exception, or a failure ratio above `--max-fail-ratio` (default
  `$LOCUST_MAX_FAIL_RATIO`, else 0), fails it - the same rule as nb-quickstarts'
  `locust/bin/exit_code.py`. `--status passed|failed` overrides either.
- `--dry-run` prints what would be sent and calls nothing.

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
npx @nasebanal/cli@0.1.0 account me get
```

The published package bundles the OpenAPI specs, so no `nb-api-specs` checkout is
needed for a registry install.

> **NASEBANAL developers:** if your `~/.npmrc` maps `@nasebanal:registry` to
> GitHub Packages (needed for the private `@nasebanal/shared-navigation` /
> `api-specs-*` packages), it captures this package too. Install with
> `npm install -g @nasebanal/cli --@nasebanal:registry=https://registry.npmjs.org/`.

### Versioning and releases

Versions follow SemVer (0.x until 1.0: breaking changes bump the minor). Each
release bundles a fixed set of API contract versions, recorded in
[`spec-versions.json`](spec-versions.json).

### Releasing (maintainers)

Published to npmjs.org through npm **trusted publishing** (OIDC): no npm token is
stored anywhere. The `Release` workflow (`.github/workflows/release.yml`) is
registered as this package's Trusted Publisher on npmjs.com (repo
`nasebanal/nb-cli`, workflow `release.yml`, no environment).

1. Bump `version` in `package.json` (PR to `main`, squash-merge). If the pinned
   contracts changed, update `spec-versions.json` in the same PR — the specs host
   serves only the latest version, so a stale pin fails `sync-specs` with a 404.
   Check https://api-specs.nasebanal.com/specs/released.json
2. Tag the merge commit: `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag must
   equal `package.json`'s version or the workflow fails.
3. The workflow type-checks, tests and runs `npm publish --provenance`.

Notes:

- A manual `npm publish` needs `--@nasebanal:registry=https://registry.npmjs.org/`
  if your `~/.npmrc` maps the `@nasebanal` scope to GitHub Packages (that mapping
  outranks `publishConfig.registry`; `publishConfig` also pins the scoped key as a
  safeguard). npm also requires a passkey (WebAuthn) 2FA for interactive publishes.
- A freshly published version can 404 on the package document for a few minutes
  while npm's cache catches up; `npm view` with `--prefer-online` or a retry is
  enough.

### From source (contributors)

Requires a sibling `nb-api-specs` checkout (the build syncs specs from it):

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
2. `../nb-api-specs/packages/<api>/spec.yaml` (local monorepo checkout).

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
