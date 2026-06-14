#!/usr/bin/env node
/**
 * `nb` — gcloud-style CLI for NASEBANAL APIs.
 *
 * The command tree under each API group is generated at startup from the
 * OpenAPI specs in `specs/` (synced from nb-api-specs). This file only wires up
 * the global options, the `auth` group, and one command group per catalog entry.
 */
import { Command } from "commander";
import { API_CATALOG } from "./apis.js";
import { buildApiCommand } from "./spec/build.js";
import { buildAuthCommand } from "./auth.js";
import { specExists } from "./spec/loader.js";
import { printError } from "./output.js";

const program = new Command();

program
  .name("nb")
  .description("Command-line interface for NASEBANAL APIs (generated from OpenAPI contracts).")
  .version("0.1.0")
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
  program.addCommand(buildApiCommand(api));
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
