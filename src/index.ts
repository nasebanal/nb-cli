#!/usr/bin/env node
/**
 * `nb` — gcloud-style CLI for NASEBANAL APIs.
 *
 * The command tree under each API group is generated at startup from the
 * OpenAPI specs in `specs/` (synced from nb-api-specs). This file only wires up
 * the global options, the `auth` group, and one command group per catalog entry.
 */
import { createRequire } from "node:module";
import { Command } from "commander";
import { API_CATALOG } from "./apis.js";
import { buildApiCommand } from "./spec/build.js";
import { buildAuthCommand } from "./auth.js";
import { specExists } from "./spec/loader.js";
import { printError } from "./output.js";
import { buildReportUploadCommand } from "./reports/upload.js";

// Single source of truth for the version: package.json (dist/ and src/ both sit
// next to it). A hard-coded string here drifts from the release tag.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("nb")
  .description("Command-line interface for NASEBANAL APIs (generated from OpenAPI contracts).")
  .version(version)
  .option("--env <env>", "target environment: production | local")
  .option("--token <token>", "override the stored PAT for this invocation")
  .showHelpAfterError();

program.addCommand(buildAuthCommand());

for (const api of API_CATALOG) {
  if (!specExists(api.spec)) {
    // Spec not synced yet — register a stub that explains how to fix it rather
    // than crashing the whole CLI.
    program
      .command(api.name)
      .description(`${api.summary} (spec not loaded)`)
      .allowUnknownOption()
      .action(() => {
        printError(
          new Error(
            `Spec '${api.spec}' is missing. Run \`npm run sync-specs\` (local dev) or reinstall the package.`,
          ),
        );
        process.exitCode = 1;
      });
    continue;
  }
  const group = buildApiCommand(api);
  // `assurance report` already holds the generated availability report; the
  // hand-written `upload` (test-result files -> a project) joins it.
  if (api.name === "assurance") {
    const report = group.commands.find((c) => c.name() === "report") ?? group.command("report").description("Reports");
    report.addCommand(buildReportUploadCommand());
  }
  program.addCommand(group);
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}

void main();
