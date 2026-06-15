/**
 * `nb auth` commands.
 *
 * The default `nb auth login` is an interactive Auth0 login (gcloud-style): it
 * opens a browser, you log in, and control returns to the terminal automatically
 * (loopback flow), falling back to a device code on headless boxes. For CI and
 * scripting a NASEBANAL Personal Access Token (`nbpat_…`) is still supported via
 * `--token` / `--token-stdin`, or the `NB_TOKEN` env var (which overrides both).
 */
import { Command } from "commander";
import { createInterface } from "node:readline";
import { loadConfig, saveConfig, resolveToken, resolveEnv, configFilePath, type Config } from "./config.js";
import { login } from "./oauth.js";

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

function storePat(config: Config, token: string): void {
  if (!token) {
    process.stderr.write("No token provided.\n");
    process.exitCode = 1;
    return;
  }
  if (!token.startsWith("nbpat_")) {
    process.stderr.write("warning: token does not start with 'nbpat_'; storing anyway.\n");
  }
  config.token = token;
  delete config.auth;
  saveConfig(config);
  process.stdout.write(`Token saved to ${configFilePath()}\n`);
}

export function buildAuthCommand(): Command {
  const auth = new Command("auth").description("Manage CLI authentication");

  auth
    .command("login")
    .description("Log in via the browser (or store a PAT with --token / --token-stdin)")
    .option("--no-launch-browser", "use the device-code flow instead of opening a browser")
    .option("--token <token>", "store a Personal Access Token (nbpat_…) non-interactively")
    .option("--token-stdin", "read a Personal Access Token from stdin")
    .action(async (opts: { launchBrowser?: boolean; token?: string; tokenStdin?: boolean }) => {
      const config = loadConfig();

      if (opts.token !== undefined) {
        storePat(config, opts.token);
        return;
      }
      if (opts.tokenStdin) {
        storePat(config, await readSecretLine("Paste your NASEBANAL PAT (nbpat_…): "));
        return;
      }

      const tokens = await login({ launchBrowser: opts.launchBrowser !== false });
      config.auth = tokens;
      delete config.token;
      saveConfig(config);
      const expiry = tokens.expires_at ? new Date(tokens.expires_at).toLocaleString() : "n/a";
      process.stdout.write(`\n✓ Logged in. Credentials saved to ${configFilePath()}\n`);
      process.stdout.write(`  Access token expires: ${expiry}${tokens.refresh_token ? " (auto-refreshes)" : ""}\n`);
    });

  auth
    .command("logout")
    .description("Remove stored credentials")
    .action(() => {
      const config = loadConfig();
      delete config.token;
      delete config.auth;
      saveConfig(config);
      process.stdout.write("Credentials removed.\n");
    });

  auth
    .command("status")
    .description("Show the active credential source and target environment")
    .action(() => {
      const config = loadConfig();
      const token = resolveToken(config);
      const source = process.env.NB_TOKEN
        ? "NB_TOKEN env"
        : config.auth
          ? "OAuth login"
          : config.token
            ? "stored PAT"
            : "none";
      const masked = token ? `${token.slice(0, 10)}…${token.slice(-4)}` : "(not set)";
      process.stdout.write(`Environment: ${resolveEnv(config)}\n`);
      process.stdout.write(`Token:       ${masked}  [source: ${source}]\n`);
      if (config.auth?.expires_at) {
        const expired = config.auth.expires_at <= Date.now();
        process.stdout.write(
          `Expires:     ${new Date(config.auth.expires_at).toLocaleString()}` +
            `${expired ? config.auth.refresh_token ? " (expired — will refresh)" : " (expired)" : ""}\n`,
        );
      }
      process.stdout.write(`Config file: ${configFilePath()}\n`);
    });

  return auth;
}
