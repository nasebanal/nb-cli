# Contributing to nb-cli

Contributions are welcome. You do not need a NASEBANAL account, an npm token or
any other repository to build and test your change.

## Set up

```bash
git clone https://github.com/nasebanal/nb-cli.git
cd nb-cli
npm install
npm test            # fetches the pinned public API contracts, then Vitest
npm run typecheck
```

`spec-versions.json` pins the API contract versions; the build downloads exactly
those from `api-specs.nasebanal.com`. Everything else is a public dependency.

## Test report formats (`nb assurance report upload`)

The parsers in `src/reports/` read test-result files (JUnit XML, Locust CSV,
Specmatic, ...) and send a summary. When a tool changes its report format, or you
want to support another version:

1. **Add a real sample** of the report under the parser's tests as a fixture.
   Record the tool and version in the test name. Strip hostnames, tokens, user
   names and any other private data first: the file is public.
2. **Make the parser read it**, preferably by accepting old and new shapes in the
   same parser. Split into a per-version implementation only when the formats are
   truly incompatible.
3. **Check what would be sent** without calling any API:

   ```bash
   nb assurance report upload --dry-run --file your-report.xml \
     --kind unit --tool vitest --tool-version 9.1.0 --project demo
   ```

   Paste the `--dry-run` output (without secrets) into the PR description.

A PR without a real sample of the new format will not be merged: the parser
decides what Assurance shows, so it has to be checked against the real thing.

The final step, uploading to a live Assurance project, needs an account; the
maintainers do that during review.

## Pull requests

- One topic per PR. Title and commit messages start with `feature:`, `fix:` or
  `chore:`, in present tense (`fix: read Locust 2.x failure rows`).
- CI (`npm test`, typecheck) must pass.
- Do not edit `specs/` or bump `spec-versions.json` for unrelated work: a
  contract change is adopted in its own PR.
