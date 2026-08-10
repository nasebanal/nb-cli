#!/usr/bin/env node
/**
 * Sync OpenAPI specs into nb-cli/specs/ for local development and CI.
 *
 * The CLI's command tree is generated from these specs, so which bytes land
 * here decides what the CLI is. `spec-versions.json` pins that: it names one
 * released contract version per API, and CI fetches exactly those.
 *
 * Pinning is the whole point. This repo is public and cannot install the
 * private `@nasebanal/api-specs-*` packages, so it used to fetch
 * `<api>.yaml` — a moving target that follows whatever nb-api-specs last
 * published. On 2026-08-08 account 1.2.0 added `DELETE /api/v1/me`, the fetch
 * silently picked it up, and the build broke on a contract this repo never
 * adopted. Nobody noticed for two days, because nothing in a PR had changed.
 *
 * Source precedence:
 *   1. node_modules/@nasebanal/api-specs-<api>/spec.yaml  (installed package,
 *      if someone with registry access installed it)
 *   2. ../nb-api-specs/packages/<api>/spec.yaml           (sibling checkout —
 *      lets a spec change be tried here before it is published)
 *   3. ${NB_SPECS_BASE_URL}/<api>-<version>.yaml          (pinned public fetch)
 *
 * 1 and 2 are working copies and can be anything, so they are LOCAL ONLY —
 * under CI the pinned URL is the only source, and a mismatched local copy is
 * reported rather than silently used.
 *
 * To adopt a new contract, bump `spec-versions.json`. Renovate watches
 * `/specs/renovate/<api>.json` and opens that bump as a PR, so the adoption is
 * reviewed like any other dependency change.
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const specsDir = join(root, "specs");
const baseUrl = (process.env.NB_SPECS_BASE_URL || "https://api-specs.nasebanal.com/specs").replace(/\/$/, "");

const pinned = JSON.parse(readFileSync(join(root, "spec-versions.json"), "utf8"));
const APIS = Object.keys(pinned);

/**
 * `info.version` of a spec file, without pulling in a YAML parser.
 *
 * The intervening lines are the rest of the `info` block, which includes folded
 * `description: >-` text — and that text contains blank lines, so the skip has
 * to tolerate empty lines as well as indented ones.
 */
function specVersion(path) {
  const m = /^info:\r?\n(?:(?:[ \t]+.*)?\r?\n)*?[ \t]+version:[ \t]*["']?([^"'\s]+)/m.exec(
    readFileSync(path, "utf8"),
  );
  return m?.[1] ?? null;
}

mkdirSync(specsDir, { recursive: true });

let copied = 0;
const missing = [];

for (const api of APIS) {
  const version = pinned[api];
  const dest = join(specsDir, `${api}.yaml`);

  const localSrc = [
    join(root, "node_modules", "@nasebanal", `api-specs-${api}`, "spec.yaml"),
    join(root, "..", "nb-api-specs", "packages", api, "spec.yaml"),
  ].find((p) => existsSync(p));

  if (localSrc && !process.env.CI) {
    const found = specVersion(localSrc);
    if (found !== version) {
      console.warn(
        `  ${api.padEnd(14)} !! local copy is ${found}, pinned is ${version} — using the local copy.\n` +
          `  ${"".padEnd(14)}    Bump spec-versions.json to adopt it; CI will use ${version}.`,
      );
    }
    copyFileSync(localSrc, dest);
    console.log(`  ${api.padEnd(14)} <- ${localSrc.replace(root + "/", "")} (${found})`);
    copied++;
    continue;
  }

  const url = `${baseUrl}/${api}-${version}.yaml`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, await res.text());
    console.log(`  ${api.padEnd(14)} <- ${url}`);
    copied++;
  } catch (err) {
    missing.push(`${api}@${version} (${err.message})`);
  }
}

console.log(`\nSynced ${copied}/${APIS.length} spec(s) into specs/`);
if (missing.length) {
  console.warn(
    `Missing: ${missing.join(", ")}\n` +
      "  A pinned version must exist on the specs host. Check spec-versions.json\n" +
      "  against https://api-specs.nasebanal.com/specs/released.json, or set\n" +
      "  NB_SPECS_BASE_URL to a reachable host.",
  );
  process.exitCode = 1;
}
