# nb-cli

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
- **Authentication:** NASEBANAL Personal Access Token (`nbpat_…`), shared with the web apps
- **Testing:** Vitest
- **Distribution:** npm (`npx @nasebanal/cli`); single-binary builds are a planned follow-up

## Directory Structure

```
nb-cli/
├── src/
│   ├── index.ts            # Entry: global options, auth group, one group per API (★)
│   ├── apis.ts             # API catalog (★ register new APIs here)
│   ├── auth.ts             # `nb auth login | logout | status`
│   ├── config.ts           # PAT + environment persisted to ~/.config/nasebanal/config.json
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

## Local Development

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

## Authentication

`nb` authenticates with a NASEBANAL Personal Access Token (`nbpat_…`), the same
token type the web apps issue. Create one in the web app under
**Settings → API tokens** (Account API), then:

```bash
nb auth login                 # paste the PAT (or: nb auth login --token nbpat_…)
nb auth status                # show active token source + environment
nb auth logout                # remove the stored token
```

- The token is stored at `~/.config/nasebanal/config.json` with `0600` permissions.
- **CI / scripting:** set `NB_TOKEN=nbpat_…` in the environment — it overrides the
  stored token and needs no `nb auth login`.
- Interactive Auth0 device-code login is a planned follow-up.

## Global Options

| Option | Description |
|--------|-------------|
| `--env <production\|local>` | Target environment; picks the matching `servers` entry from the spec. Also `NB_ENV`. |
| `--token <token>` | Override the stored PAT for one invocation. |
| `-V, --version` | Print the CLI version. |

The active environment defaults to `production`; `--env local` targets the
`wrangler dev` servers declared in each spec.

## Adding a New API

1. Publish/own its spec in `nb-api-specs` (it ships as `@nasebanal/api-specs-<api>`).
2. Add an entry to `API_CATALOG` in `src/apis.ts` and to the list in `scripts/sync-specs.mjs`.
3. `npm run sync-specs && npm run build` — the command group appears automatically.

## Conventions

- **The command surface is generated, not hand-written** — refine commands by
  improving the contract (e.g. add `operationId`), not by special-casing the CLI.
- **Specs are dependencies, not source** — `specs/` is git-ignored; production
  pins the published `@nasebanal/api-specs-*` packages.
- **Never commit a PAT** — config lives outside the repo; CI uses `NB_TOKEN`.
- **Deploy/release via PR merge and CI** — never publish from a local machine.
