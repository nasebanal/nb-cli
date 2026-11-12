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

export function configDir(): string {
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

let warnedSharedBaseUrl = false;

/**
 * The host a command group talks to when the environment names one, or undefined (then the spec's own `servers` entry for the
 * active environment is used). `NB_<API>_BASE_URL` is that API's alone (`NB_ASSURANCE_BASE_URL`, `NB_RECORD_BASE_URL`, ...: the
 * API is the command group's name, as in `NB_<API>_ORG`). The older `NB_BASE_URL` is still read as a fallback, but it applies
 * to EVERY API at once (pointing it at one local Worker sends `nb record` there too), so it is deprecated and says so, once, on stderr.
 * Origin only: the spec's path is appended. A trailing slash is dropped; an empty value counts as unset.
 */
export function baseUrlOverride(apiName: string): string | undefined {
  const found = peekBaseUrlOverride(apiName);
  if (found?.variable === "NB_BASE_URL" && !warnedSharedBaseUrl) {
    warnedSharedBaseUrl = true;
    process.stderr.write(
      `nb: NB_BASE_URL applies to every API and is deprecated; set NB_${apiName.toUpperCase()}_BASE_URL (the host of the ${apiName} API) instead.\n`,
    );
  }
  return found?.url;
}

/** The same lookup without the deprecation notice, and with the variable that supplied the host (for `nb auth status`). */
export function peekBaseUrlOverride(apiName: string): { url: string; variable: string } | undefined {
  const clean = (v: string | undefined) => v?.trim().replace(/\/$/, "") || undefined;
  const ownName = `NB_${apiName.toUpperCase()}_BASE_URL`;
  const own = clean(process.env[ownName]);
  if (own) return { url: own, variable: ownName };
  const shared = clean(process.env.NB_BASE_URL);
  return shared ? { url: shared, variable: "NB_BASE_URL" } : undefined;
}

/** Tests: forget that the deprecation was already said. */
export function resetBaseUrlWarning(): void {
  warnedSharedBaseUrl = false;
}
