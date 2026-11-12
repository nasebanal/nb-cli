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
import { loadConfig, saveConfig, resolveToken, resolveEnv, configFilePath, peekBaseUrlOverride, type Config, type Environment } from "./config.js";
import { API_CATALOG } from "./apis.js";
import { resolveBaseUrl } from "./http.js";
import { loadSpec } from "./spec/loader.js";
import { specsBaseUrl } from "./specs/push.js";
import { login } from "./oauth.js";
import { envTokenHint } from "./output.js";

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
      // The login is saved, but a token exported in this shell still wins: say so now, not after a confusing 401 later.
      const shadowed = envTokenHint();
      if (shadowed) process.stderr.write(`\n! ${shadowed.replace("takes priority over `nb auth login`.", "takes priority over this login.")}\n`);
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
      const env = resolveEnv(config);
      process.stdout.write(`Environment: ${env}\n`);
      process.stdout.write(`Targets (the host each command calls; a NB_<API>_BASE_URL wins over the environment):\n`);
      for (const line of targetLines(env)) process.stdout.write(`  ${line}\n`);
      process.stdout.write(`Token:       ${masked}  [source: ${source}]\n`);
      // The stored `nb auth login` session is shown whether or not it is the credential in use: NB_TOKEN beats it, and a
      // status that hid it would make "am I logged in, and as whom" unanswerable exactly when the two disagree.
      if (config.auth) {
        const who = loginIdentity(config.auth.id_token) ?? "(not readable)";
        const note = source === "OAuth login" ? "in use; from the login, not checked with the server" : "stored, NOT in use: another credential wins";
        process.stdout.write(`Login:       ${who}  [${note}]\n`);
      }
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

/**
 * The word the reader is looking for, next to the URL, decided by the host itself: `*.nasebanal.com` is production, `localhost` /
 * `127.0.0.1` is local, anything else (a stub, a self-hosted copy) is `other`, never claimed to be production.
 */
export function hostKind(url: string): "production" | "local" | "other" {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return "local";
  if (host === "nasebanal.com" || host.endsWith(".nasebanal.com")) return "production";
  return "other";
}

/**
 * What `nb auth status` says about where the commands go: per API, the host the next command would call and whether that is
 * local or production, plus which variable put it there when one did (the environment alone does not tell, because a
 * NB_<API>_BASE_URL beats it).
 */
export function targetLines(env: Environment): string[] {
  const width = Math.max(...API_CATALOG.map((a) => a.name.length));
  return API_CATALOG.map((api) => {
    // `nb specs` verbs read the catalog's host (NB_SPECS_BASE_URL only); every other group resolves from its spec's `servers`.
    const peek = peekBaseUrlOverride(api.name);
    const via =
      api.name === "specs"
        ? process.env.NB_SPECS_BASE_URL?.trim()
          ? { url: specsBaseUrl(env), variable: "NB_SPECS_BASE_URL" }
          : undefined
        : peek;
    const url = api.name === "specs" ? specsBaseUrl(env) : (peek?.url ?? resolveBaseUrl(loadSpec(api.spec).servers, env));
    return `${api.name.padEnd(width)}  ${url}  [${hostKind(url)}${via ? `, from ${via.variable}` : ""}]`;
  });
}

/**
 * Who a `nb auth login` was done as, `Name <email>`, read from the ID token that login stored (the payload is plain base64url JSON).
 * For display only: nothing is authorized on it (the servers verify the access token's signature). null when there is no ID token
 * or it cannot be read.
 */
export function loginIdentity(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { name?: unknown; email?: unknown; nickname?: unknown };
    const email = typeof claims.email === "string" ? claims.email : "";
    const name = typeof claims.name === "string" ? claims.name : typeof claims.nickname === "string" ? claims.nickname : "";
    if (name && email) return `${name} <${email}>`;
    return email || name || null;
  } catch {
    return null;
  }
}
