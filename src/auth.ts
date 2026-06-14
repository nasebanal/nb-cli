/**
 * `nb auth` commands. Authentication is via a NASEBANAL Personal Access Token
 * (`nbpat_…`), created in the web app under Settings → API tokens (Account API).
 * Interactive Auth0 device-code login is a planned follow-up; for now the CLI
 * accepts a PAT directly, which is also what CI uses via the NB_TOKEN env var.
 */
import { Command } from "commander";
import { createInterface } from "node:readline";
import { loadConfig, saveConfig, resolveToken, resolveEnv, configFilePath } from "./config.js";

function readSecretLine(promptText: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}

export function buildAuthCommand(): Command {
  const auth = new Command("auth").description("Manage CLI authentication");

  auth
    .command("login")
    .description("Store a Personal Access Token (nbpat_…) for future requests")
    .option("--token <token>", "PAT to store (otherwise read from stdin)")
    .action(async (opts: { token?: string }) => {
      const token = opts.token || (await readSecretLine("Paste your NASEBANAL PAT (nbpat_…): "));
      if (!token) {
        process.stderr.write("No token provided.\n");
        process.exitCode = 1;
        return;
      }
      if (!token.startsWith("nbpat_")) {
        process.stderr.write("warning: token does not start with 'nbpat_'; storing anyway.\n");
      }
      const config = loadConfig();
      config.token = token;
      saveConfig(config);
      process.stdout.write(`Token saved to ${configFilePath()}\n`);
    });

  auth
    .command("logout")
    .description("Remove the stored token")
    .action(() => {
      const config = loadConfig();
      delete config.token;
      saveConfig(config);
      process.stdout.write("Token removed.\n");
    });

  auth
    .command("status")
    .description("Show the active token source and target environment")
    .action(() => {
      const config = loadConfig();
      const token = resolveToken(config);
      const source = process.env.NB_TOKEN ? "NB_TOKEN env" : config.token ? "stored config" : "none";
      const masked = token ? `${token.slice(0, 10)}…${token.slice(-4)}` : "(not set)";
      process.stdout.write(`Environment: ${resolveEnv(config)}\n`);
      process.stdout.write(`Token:       ${masked}  [source: ${source}]\n`);
      process.stdout.write(`Config file: ${configFilePath()}\n`);
    });

  return auth;
}
