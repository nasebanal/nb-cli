/**
 * Persistent CLI configuration (PAT, target environment).
 *
 * Stored as JSON at `$XDG_CONFIG_HOME/nasebanal/config.json` (falling back to
 * `~/.config/nasebanal/config.json`). The token is the user's Personal Access
 * Token (`nbpat_…`) issued by the Account API. `NB_TOKEN` in the environment
 * always overrides the stored token, which is the supported path for CI.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";

export type Environment = "production" | "local";

export interface Config {
  token?: string;
  /** Which `servers` entry of each spec to target. */
  env?: Environment;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "nasebanal");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // Tighten perms in case the file already existed with a looser mode.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

/** Resolve the active token: `NB_TOKEN` env wins, else the stored token. */
export function resolveToken(config: Config = loadConfig()): string | undefined {
  return process.env.NB_TOKEN || config.token;
}

/** Resolve the active environment: `NB_ENV` env wins, else stored, else production. */
export function resolveEnv(config: Config = loadConfig()): Environment {
  const fromEnv = process.env.NB_ENV;
  if (fromEnv === "local" || fromEnv === "production") return fromEnv;
  return config.env ?? "production";
}

export function configFilePath(): string {
  return configPath();
}
