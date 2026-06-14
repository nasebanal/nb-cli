#!/usr/bin/env node
/**
 * Sync OpenAPI specs into nb-cli/specs/ for local development and CI.
 *
 * The CLI's command tree is generated from these specs. Source precedence:
 *   1. node_modules/@nasebanal/api-specs-<api>/spec.yaml  (installed package —
 *      the production CDD consumer path; full surface incl. internal endpoints)
 *   2. ../nb-api-specs/packages/<api>/spec.yaml           (local monorepo —
 *      changes visible without a publish, full surface)
 *   3. ${NB_SPECS_BASE_URL}/<api>.yaml                    (public HTTP fetch —
 *      no auth, no monorepo; serves the x-internal-filtered public surface.
 *      Used by CI and by anyone running the OSS CLI from a bare checkout.)
 *
 * In production the published `@nasebanal/api-specs-*` packages are pinned as
 * dependencies (the consumer side of CDD); the HTTP path is the zero-setup
 * fallback that mirrors how the public API reference is distributed.
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const specsDir = join(root, "specs");
const baseUrl = (process.env.NB_SPECS_BASE_URL || "https://api-specs.nasebanal.com/specs").replace(/\/$/, "");

// Keep in sync with src/apis.ts (name -> output filename).
const APIS = ["account", "recorder", "target", "app-template"];

mkdirSync(specsDir, { recursive: true });

let copied = 0;
const missing = [];

for (const api of APIS) {
  const dest = join(specsDir, `${api}.yaml`);
  const localCandidates = [
    join(root, "node_modules", "@nasebanal", `api-specs-${api}`, "spec.yaml"),
    join(root, "..", "nb-api-specs", "packages", api, "spec.yaml"),
  ];
  const src = localCandidates.find((p) => existsSync(p));

  if (src) {
    copyFileSync(src, dest);
    console.log(`  ${api.padEnd(14)} <- ${src.replace(root + "/", "")}`);
    copied++;
    continue;
  }

  // Fall back to the public HTTP endpoint.
  const url = `${baseUrl}/${api}.yaml`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, await res.text());
    console.log(`  ${api.padEnd(14)} <- ${url}`);
    copied++;
  } catch (err) {
    missing.push(`${api} (${err.message})`);
  }
}

console.log(`\nSynced ${copied}/${APIS.length} spec(s) into specs/`);
if (missing.length) {
  console.warn(
    `Missing: ${missing.join(", ")}\n` +
      "  Install the @nasebanal/api-specs-* packages, clone nb-api-specs next to\n" +
      "  nb-cli, or set NB_SPECS_BASE_URL to a reachable specs host.",
  );
  process.exitCode = 1;
}
