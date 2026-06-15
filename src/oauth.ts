/**
 * Interactive Auth0 login for the CLI (gcloud-style).
 *
 * Two flows, sharing one Auth0 "Native" application (PKCE, no client secret):
 *
 *   1. Loopback (default) — start a throwaway HTTP server on localhost, open the
 *      browser to Auth0 `/authorize`, capture the redirected `?code=…`, and
 *      exchange it for tokens. This is what `gcloud auth login` does.
 *   2. Device code (fallback / `--no-launch-browser`) — print a short user code
 *      and a verification URL, then poll `/oauth/token` until the user finishes
 *      in any browser. For SSH / headless boxes with no local browser.
 *
 * This module is pure transport: it talks to Auth0 and returns tokens. It never
 * reads or writes the on-disk config — persistence lives in `config.ts`, which
 * is also the only caller of `refreshTokens()`.
 *
 * Auth0 setup required (one time, by a tenant admin):
 *   - Create an Application of type **Native** (PKCE, public client).
 *   - Grant types: Authorization Code, Refresh Token, Device Code.
 *   - Allowed Callback URLs: this tenant validates the port, so register every
 *     port in LOOPBACK_PORTS as `http://localhost:<port>/callback`. The CLI binds
 *     the first free one (or the single NB_AUTH0_REDIRECT_PORT if set).
 *   - Enable "Allow Offline Access" on the NASEBANAL API (for refresh tokens).
 *   - Put the resulting Client ID in AUTH0_CLIENT_ID below (it is public — a
 *     native-app client ID is not a secret), or pass NB_AUTH0_CLIENT_ID.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

const AUTH0_DOMAIN = process.env.NB_AUTH0_DOMAIN || "dev-bv0p1636dyofjbmg.us.auth0.com";
const AUTH0_AUDIENCE = process.env.NB_AUTH0_AUDIENCE || "https://api.nasebanal.com";
/** Public Client ID of the Native app (not a secret for public PKCE clients). */
const AUTH0_CLIENT_ID = "EkdU317qo2fXg2DF3n2vUo7NWpUi9Dt2";
const SCOPE = "openid profile email offline_access";

/**
 * Fixed loopback ports the CLI will bind, in order. This tenant validates the
 * callback URL by exact match (port included), so EVERY port listed here must be
 * registered in Auth0 Allowed Callback URLs as `http://localhost:<port>/callback`.
 * The CLI uses the first one that is free. `NB_AUTH0_REDIRECT_PORT` pins one.
 */
const LOOPBACK_PORTS = [8085, 8086, 8087, 8088, 8089];

/** Tokens as persisted in config and returned by every flow here. */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  /** Absolute expiry (epoch ms) derived from `expires_in` at grant time. */
  expires_at?: number;
}

/** Thrown when the loopback flow can't even start, so the caller can fall back. */
export class LoopbackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopbackUnavailableError";
  }
}

function clientId(): string {
  const id = process.env.NB_AUTH0_CLIENT_ID || AUTH0_CLIENT_ID;
  if (!id) {
    throw new Error(
      "Auth0 client ID is not configured. Set NB_AUTH0_CLIENT_ID, or bake the " +
        "Native app's Client ID into AUTH0_CLIENT_ID in src/oauth.ts.",
    );
  }
  return id;
}

const base64url = (buf: Buffer): string => buf.toString("base64url");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Best-effort browser launch. Always also print the URL so manual paste works. */
function openBrowser(url: string): void {
  const { platform } = process;
  const [cmd, args] =
    platform === "darwin"
      ? (["open", [url]] as const)
      : platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(cmd, [...args], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no browser available — manual URL is already printed */
    });
    child.unref();
  } catch {
    /* ignore — manual URL is already printed */
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function toTokens(data: TokenResponse): OAuthTokens {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    id_token: data.id_token,
    token_type: data.token_type,
    scope: data.scope,
    expires_at: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

async function postForm(path: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://${AUTH0_DOMAIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json().catch(() => ({}))) as TokenResponse;
}

function tokenError(data: { error?: string; error_description?: string }, fallback: string): Error {
  return new Error(`${fallback}: ${data.error ?? "unknown"}${data.error_description ? ` — ${data.error_description}` : ""}`);
}

// ---------------------------------------------------------------------------
// Loopback flow
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>NASEBANAL CLI</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">
<h1>✓ Logged in</h1><p>You can close this tab and return to your terminal.</p></body>`;

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** Resolve with the auth `code` once Auth0 redirects to our loopback server. */
function waitForCode(server: Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the browser login to complete."));
    }, timeoutMs);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      res.writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(error ? `Login failed: ${error}. You can close this tab.` : SUCCESS_HTML);
      clearTimeout(timer);
      if (error) return reject(tokenError({ error }, "Authorization failed"));
      if (state !== expectedState) return reject(new Error("State mismatch — possible CSRF; aborting."));
      if (!code) return reject(new Error("No authorization code in the callback."));
      resolve(code);
    });
  });
}

export async function loopbackLogin(): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));
  const server = createServer();

  const pinned = Number(process.env.NB_AUTH0_REDIRECT_PORT) || 0;
  const candidates = pinned ? [pinned] : LOOPBACK_PORTS;
  let bound = false;
  for (const candidate of candidates) {
    try {
      await listen(server, candidate);
      bound = true;
      break;
    } catch {
      /* port busy — try the next one */
    }
  }
  if (!bound) {
    throw new LoopbackUnavailableError(
      `Could not bind any loopback callback port (tried ${candidates.join(", ")}).`,
    );
  }

  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://localhost:${port}/callback`;

  const authorizeUrl = new URL(`https://${AUTH0_DOMAIN}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri,
    scope: SCOPE,
    audience: AUTH0_AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  process.stderr.write(
    `Opening your browser to log in. If it doesn't open, visit this URL:\n\n  ${authorizeUrl.toString()}\n\n`,
  );
  openBrowser(authorizeUrl.toString());

  try {
    const code = await waitForCode(server, state, 5 * 60_000);
    const data = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: clientId(),
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    if (!data.access_token) throw tokenError(data, "Token exchange failed");
    return toTokens(data);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Device code flow
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

export async function deviceCodeLogin(): Promise<OAuthTokens> {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId(), scope: SCOPE, audience: AUTH0_AUDIENCE }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as DeviceCodeResponse;
  if (!res.ok || !data.device_code) throw tokenError(data, "Could not start device login");

  process.stderr.write(
    `\nTo log in, visit:\n\n  ${data.verification_uri}\n\nand enter the code:\n\n  ${data.user_code}\n\n`,
  );
  if (data.verification_uri_complete) {
    process.stderr.write(`Or open this URL directly (code pre-filled):\n\n  ${data.verification_uri_complete}\n\n`);
    openBrowser(data.verification_uri_complete);
  }
  process.stderr.write("Waiting for you to finish in the browser…\n");

  let intervalMs = (data.interval ?? 5) * 1000;
  const deadline = Date.now() + data.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = await postForm("/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId(),
      device_code: data.device_code,
    });
    if (token.access_token) return toTokens(token);
    switch (token.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += 5_000;
        break;
      default:
        throw tokenError(token, "Device login failed");
    }
  }
  throw new Error("Device login expired before it was approved. Run `nb auth login` again.");
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Interactive login. Tries loopback; falls back to device code when it can't. */
export async function login(opts: { launchBrowser: boolean }): Promise<OAuthTokens> {
  if (!opts.launchBrowser) return deviceCodeLogin();
  try {
    return await loopbackLogin();
  } catch (err) {
    if (err instanceof LoopbackUnavailableError) {
      process.stderr.write(`${err.message}\nFalling back to device-code login.\n`);
      return deviceCodeLogin();
    }
    throw err;
  }
}

/** Exchange a refresh token for a fresh access token. Called by config.ts. */
export async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const data = await postForm("/oauth/token", {
    grant_type: "refresh_token",
    client_id: clientId(),
    refresh_token: refreshToken,
  });
  if (!data.access_token) throw tokenError(data, "Token refresh failed");
  return toTokens(data);
}
