#!/usr/bin/env bash
# Release @nasebanal/cli to npm, in the two halves that the PR merge splits apart.
#
#   bin/release.sh prepare <version> [--sync-pins] [--dry-run]
#       Before the merge. Checks the tree and the pinned contracts, bumps the version,
#       runs the type check and the tests, then opens the release PR.
#   bin/release.sh publish [--yes] [--dry-run]
#       After you merged that PR. Tags the merge commit (the tag push IS the publish: the
#       Release workflow runs `npm publish --provenance`), waits for the workflow, and
#       checks the version is on npm.
#
# For maintainers: it needs write access to nasebanal/nb-cli (it pushes a branch and a tag). That is the
# whole gate - there is no npm token to know: the Release workflow publishes through npm trusted
# publishing (OIDC), which npm accepts only from this repo's release.yml, so a fork or an outside
# contributor cannot publish with it. (The script checks the permission first and says so.)
#
# Merging is yours to do - this script never merges. It does run git / gh, so it is for you to
# run, not for an agent. --dry-run does every check and prints what it would do, writing nothing.
#
# Steps this replaces: README "Releasing (maintainers)". Why each check exists:
#   - spec pins: the specs host serves only the latest contract, so a stale spec-versions.json
#     makes CI's sync-specs fail with a 404 (it happened for account 1.4.0 -> 1.5.0).
#   - tag == package.json version: the workflow refuses a tag that disagrees.
#   - npm view needs --@nasebanal:registry=<npmjs>: a ~/.npmrc that maps the @nasebanal scope to
#     GitHub Packages (this org's other packages) outranks the default and gives a false 404.
set -euo pipefail

REPO="nasebanal/nb-cli"
PKG="@nasebanal/cli"
NPM_REGISTRY="https://registry.npmjs.org/"
RELEASED_URL="${NB_SPECS_BASE_URL:-https://api-specs.nasebanal.com/specs}/released.json"

cd "$(dirname "$0")/.."

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "• $*"; }
usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

for tool in git gh npm node curl; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but not on PATH"
done

DRY=0
YES=0
SYNC_PINS=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --sync-pins) SYNC_PINS=1 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option: $arg" ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
CMD="${POSITIONAL[0]:-}"
[ -n "$CMD" ] || usage 1

# Run a command, or only print it under --dry-run.
run() {
  if [ "$DRY" -eq 1 ]; then
    echo "  (dry run) $*"
  else
    "$@"
  fi
}

# npm view against the public registry, whatever ~/.npmrc says. Prints nothing on failure.
npm_view() {
  npm view "$@" --prefer-online "--@nasebanal:registry=${NPM_REGISTRY}" 2>/dev/null || true
}

semver_gt() { # a > b ?
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

tag_exists() {
  git rev-parse -q --verify "refs/tags/v$1" >/dev/null 2>&1 || [ -n "$(git ls-remote --tags origin "refs/tags/v$1")" ]
}

published_versions() { npm_view "$PKG" versions --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log([].concat(v).join("\n"))}catch{}})'; }

require_clean_tracked_tree() {
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "tracked files have uncommitted changes - commit or stash them first"
}

# Pushing a branch and a tag needs write access to the repository; say so up front rather than
# failing half way. (Publishing itself is done by the workflow, never from this machine.)
require_write_access() {
  local perm
  perm="$(gh repo view "$REPO" --json viewerPermission -q .viewerPermission 2>/dev/null || true)"
  case "$perm" in
    WRITE|MAINTAIN|ADMIN) info "gh: you have $perm access to $REPO" ;;
    "") die "cannot read your permission on $REPO - run 'gh auth login' first" ;;
    *) die "releasing needs write access to $REPO (you have: $perm). Releases are made by the maintainers; to change the CLI, open a PR from a fork - see README." ;;
  esac
}

# --- the pinned contracts must equal what the specs host serves ----------------------------
check_pins() {
  local released
  released="$(curl -fsS "$RELEASED_URL")" || die "cannot read $RELEASED_URL"
  # Prints one "api pinned released" line per mismatch.
  local diff
  diff="$(RELEASED="$released" node -e '
    const pinned = JSON.parse(require("fs").readFileSync("spec-versions.json", "utf8"));
    const released = JSON.parse(process.env.RELEASED);
    for (const api of Object.keys(pinned)) {
      if (released[api] !== pinned[api]) console.log(`${api} ${pinned[api]} ${released[api] ?? "(not released)"}`);
    }')"
  if [ -z "$diff" ]; then
    info "spec-versions.json matches released.json"
    return 0
  fi
  echo "Pinned contracts that differ from $RELEASED_URL:" >&2
  echo "$diff" | awk '{ printf "    %-14s pinned %-8s released %s\n", $1, $2, $3 }' >&2
  if [ "$SYNC_PINS" -ne 1 ]; then
    die "the specs host serves only the latest version, so CI's sync-specs would 404. Re-run with --sync-pins to adopt the released versions in this release PR."
  fi
  info "adopting the released versions (--sync-pins)"
  if [ "$DRY" -eq 1 ]; then
    echo "  (dry run) would rewrite spec-versions.json to match released.json"
  else
    RELEASED="$released" node -e '
      const fs = require("fs");
      const pinned = JSON.parse(fs.readFileSync("spec-versions.json", "utf8"));
      const released = JSON.parse(process.env.RELEASED);
      for (const api of Object.keys(pinned)) if (released[api]) pinned[api] = released[api];
      fs.writeFileSync("spec-versions.json", JSON.stringify(pinned, null, 2) + "\n");'
  fi
}

# =============================================================================================
prepare() {
  local version="${POSITIONAL[1]:-}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give the new version, e.g.: bin/release.sh prepare 0.3.0"

  require_write_access
  require_clean_tracked_tree
  git fetch -q origin
  local current
  current="$(git show origin/main:package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
  semver_gt "$version" "$current" || die "$version is not newer than the version on origin/main ($current)"
  tag_exists "$version" && die "tag v$version already exists"
  if published_versions | grep -qx "$version"; then die "$version is already on npm"; fi
  info "releasing $current -> $version from origin/main"

  local branch="chore/release-$version"
  git rev-parse -q --verify "refs/heads/$branch" >/dev/null && die "branch $branch already exists locally - delete it or pick another version"

  # Checks run on the code that will be released, so branch from origin/main first.
  run git checkout -b "$branch" origin/main
  if [ "$DRY" -eq 1 ]; then
    echo "  (dry run) checking the pins and running the checks against the current tree instead"
  fi
  check_pins

  if [ "$DRY" -eq 1 ]; then
    info "npm run sync-specs / typecheck / test (skipped in a dry run)"
  else
    info "npm run sync-specs / typecheck / test"
    npm run sync-specs
    npm run typecheck
    npm test
  fi

  info "bumping package.json and package-lock.json to $version"
  run npm version "$version" --no-git-tag-version
  # The README's pinned `npx @nasebanal/cli@<x>` example follows the version.
  run perl -pi -e "s{npx \\Q${PKG}\\E\\@[0-9]+\\.[0-9]+\\.[0-9]+}{npx ${PKG}\\@${version}}g" README.md

  run git add package.json package-lock.json README.md spec-versions.json
  run git commit -q -m "chore: release $version"
  run git push -q -u origin "$branch"
  run gh pr create --repo "$REPO" --base main --head "$branch" \
    --title "chore: release $version" \
    --body "Bump ${PKG} to **${version}** (checked: pinned contracts equal released.json; type check and tests pass).

After merge, publish with \`bin/release.sh publish\` (it tags v${version}, which runs the Release workflow)."

  echo
  if [ "$DRY" -eq 1 ]; then
    echo "✅ Dry run finished - nothing was changed."
  else
    echo "✅ Release PR opened. Merge it, then run:  bin/release.sh publish"
  fi
}

# =============================================================================================
publish() {
  require_write_access
  git fetch -q origin --tags
  [ "$(git branch --show-current)" = "main" ] || die "check out main first (git checkout main && git pull)"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "local main is not origin/main - run: git pull"
  require_clean_tracked_tree

  local version
  version="$(node -p 'require("./package.json").version')"
  if published_versions | grep -qx "$version"; then die "$version is already on npm"; fi
  if tag_exists "$version"; then
    # The tag is pushed but the version is not on npm: the workflow is running, or it failed.
    # Say which, and how to carry on - do not tag again (the tag is the trigger and stays put).
    local last status conclusion
    last="$(gh run list --repo "$REPO" --workflow release.yml --branch "v$version" --limit 1 --json databaseId,status,conclusion -q '.[0] | "\(.databaseId) \(.status) \(.conclusion)"' 2>/dev/null || true)"
    read -r last status conclusion <<<"$last"
    case "$status" in
      in_progress|queued|waiting|pending) die "tag v$version is pushed and its Release run is still going - watch it: gh run watch $last --repo $REPO" ;;
      completed) die "tag v$version is pushed but ${PKG}@$version is not on npm: the Release run ended '$conclusion' (https://github.com/$REPO/actions/runs/$last). Fix the cause, then re-run it - no new tag needed:  gh run rerun $last --repo $REPO --failed" ;;
      *) die "tag v$version already exists but no Release run was found for it - see https://github.com/$REPO/actions" ;;
    esac
  fi

  info "main is at: $(git log --oneline -1)"
  info "package.json says $version; this will create and push tag v$version, which publishes ${PKG}@$version to npm"
  if [ "$DRY" -eq 1 ]; then
    echo "  (dry run) would tag v$version, push it, wait for the Release workflow and check npm"
    return 0
  fi
  if [ "$YES" -ne 1 ]; then
    [ -t 0 ] || die "no terminal to ask on - pass --yes"
    read -r -p "Tag and publish v$version? [y/N] " ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted - nothing was tagged"
  fi

  git tag "v$version"
  git push origin "v$version"
  info "pushed v$version; waiting for the Release workflow"

  local id=""
  for _ in $(seq 1 12); do
    id="$(gh run list --repo "$REPO" --workflow release.yml --branch "v$version" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
    [ -n "$id" ] && break
    sleep 5
  done
  [ -n "$id" ] || die "the Release workflow did not start - see https://github.com/$REPO/actions (the tag is pushed)"
  gh run watch "$id" --repo "$REPO" --exit-status || die "the Release workflow failed - https://github.com/$REPO/actions/runs/$id. The tag v$version stays; fix the cause and re-run it:  gh run rerun $id --repo $REPO --failed   (an npm \"404 ... could not be found or you do not have permission\" on PUT means npm does not accept this workflow: check the package's Trusted Publisher on npmjs.com - repo nasebanal/nb-cli, workflow release.yml, no environment)"

  info "checking npm (a fresh version can 404 for a few minutes)"
  for _ in $(seq 1 12); do
    if [ "$(npm_view "${PKG}@${version}" version)" = "$version" ]; then
      echo
      echo "✅ ${PKG}@${version} is on npm:  npm i -g ${PKG}"
      return 0
    fi
    sleep 15
  done
  die "the workflow succeeded but npm does not show ${PKG}@${version} yet - check again in a few minutes: npm view ${PKG} version --@nasebanal:registry=${NPM_REGISTRY}"
}

case "$CMD" in
  prepare) prepare ;;
  publish) publish ;;
  *) usage 1 ;;
esac
