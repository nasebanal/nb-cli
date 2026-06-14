/**
 * Thin HTTP layer: resolves the base URL from a spec's `servers`, attaches the
 * bearer token, and performs the request. Kept deliberately small — the command
 * builder owns request shaping; this just sends bytes.
 */
import type { Environment } from "./config.js";
import type { OpenApiServer } from "./spec/loader.js";

export interface RequestOptions {
  baseUrl: string;
  path: string;
  method: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  token?: string;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Pick the server URL matching the active environment. */
export function resolveBaseUrl(servers: OpenApiServer[] | undefined, env: Environment): string {
  if (!servers || servers.length === 0) {
    throw new Error("Spec declares no servers; cannot resolve a base URL.");
  }
  const isLocal = (s: OpenApiServer) => /localhost|127\.0\.0\.1/.test(s.url);
  const match = env === "local" ? servers.find(isLocal) : servers.find((s) => !isLocal(s));
  return (match ?? servers[0]).url.replace(/\/$/, "");
}

export async function request(opts: RequestOptions): Promise<ApiResponse> {
  const url = new URL(opts.baseUrl + opts.path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const init: RequestInit = { method: opts.method.toUpperCase(), headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Request to ${url.host} failed: ${(err as Error).message}`);
  }

  const text = await res.text();
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as raw text */
    }
  }

  if (!res.ok) {
    throw new ApiError(`${res.status} ${res.statusText}`, res.status, data);
  }
  return { status: res.status, ok: true, data };
}
