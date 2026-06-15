/**
 * Persistent CLI configuration (credentials, target environment).
 *
 * Stored as JSON at `$XDG_CONFIG_HOME/nasebanal/config.json` (falling back to
 * `~/.config/nasebanal/config.json`). Two credential shapes can live here:
 *   - `auth` — OAuth tokens from `nb auth login` (browser / device-code flow).
 *   - `token` — a Personal Access Token (`nbpat_…`) for manual / scripted use.
 * `NB_TOKEN` in the environment always overrides both, which is the supported
 * path for CI.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { refreshTokens, type OAuthTokens } from "./oauth.js";

export type Environment = "production" | "local";

export interface Config {
  /** Personal Access Token (`nbpat_…`) — manual / scripted auth. */
  token?: string;
  /** OAuth tokens from interactive `nb auth login`. */
  auth?: OAuthTokens;
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

/**
 * Resolve the active token synchronously, WITHOUT refreshing — for display only
 * (`nb auth status`). Precedence: `NB_TOKEN` env, OAuth access token, stored PAT.
 */
export function resolveToken(config: Config = loadConfig()): string | undefined {
  return process.env.NB_TOKEN || config.auth?.access_token || config.token;
}

/** Refresh OAuth tokens in-place when the access token is expired (or close to). */
async function ensureFreshAuth(config: Config): Promise<OAuthTokens | undefined> {
  const auth = config.auth;
  if (!auth) return undefined;
  const skewMs = 60_000;
  if (!auth.expires_at || auth.expires_at - skewMs > Date.now()) return auth;
  if (!auth.refresh_token) return auth; // can't refresh; let the request 401
  try {
    const next = await refreshTokens(auth.refresh_token);
    // Token rotation may not return a new refresh token — keep the old one.
    const merged: OAuthTokens = { ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
    config.auth = merged;
    saveConfig(config);
    return merged;
  } catch {
    return auth; // refresh failed; surface as a 401 on the actual request
  }
}

/**
 * Resolve the token to send on API requests, refreshing an expired OAuth access
 * token first. Precedence: `NB_TOKEN` env, OAuth (refreshed), stored PAT.
 */
export async function resolveAccessToken(config: Config = loadConfig()): Promise<string | undefined> {
  if (process.env.NB_TOKEN) return process.env.NB_TOKEN;
  if (config.auth) {
    const fresh = await ensureFreshAuth(config);
    return fresh?.access_token;
  }
  return config.token;
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
