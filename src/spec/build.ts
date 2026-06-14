/**
 * Turns an OpenAPI spec into a gcloud-style commander command tree.
 *
 * Mapping (deterministic, since the specs carry no operationId yet):
 *   - The URL path, minus a leading `/api/v1`, becomes a noun hierarchy.
 *   - Path parameters (`{id}`) become positional arguments, not command names.
 *   - A path ending in a plural noun is a collection; a singular noun is either a
 *     singleton resource or an action. The HTTP method + that distinction picks
 *     the leaf verb:
 *       GET   collection -> list      GET   singleton -> get
 *       GET/…/{id}       -> get       DELETE/…/{id}   -> delete
 *       POST  collection -> create    PUT -> replace   PATCH -> update
 *       write singular segment        -> the segment itself is the verb (action)
 *   - Query parameters become `--flag` options; a request body is `--data <json>`.
 *
 * e.g.  GET    /api/v1/me                -> nb account me get
 *       GET    /api/v1/me/tokens         -> nb account me tokens list
 *       POST   /api/v1/me/tokens         -> nb account me tokens create --data '…'
 *       DELETE /api/v1/me/tokens/{id}    -> nb account me tokens delete <id>
 *       POST   /api/v1/shares/{id}/accept-> nb target shares accept <id>
 *       POST   /api/v1/stripe/checkout   -> nb account stripe checkout --data '…'
 *
 * When two operations collapse to the same command (e.g. `/shares/accept` and
 * `/shares/{id}/accept`), the more specific one — more path parameters — wins,
 * deterministically, regardless of spec order.
 *
 * When the specs gain operationId / x-cli-name hints, this is the single place
 * that consumes them — the command surface stays a pure function of the contract.
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import type { ApiEntry } from "../apis.js";
import { loadSpec, type HttpMethod, type OpenApiOperation, type OpenApiSpec } from "./loader.js";
import { resolveBaseUrl, request } from "../http.js";
import { resolveToken, resolveEnv, type Environment } from "../config.js";
import { printJson } from "../output.js";

const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

function stripBasePath(path: string): string {
  return path.replace(/^\/api\/v1(?=\/|$)/, "") || "/";
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** Rough plurality test — good enough to tell collections from singletons/actions. */
function isPlural(segment: string): boolean {
  return /s$/.test(segment) && !/ss$/.test(segment);
}

const PLURAL_VERB: Record<HttpMethod, string> = {
  get: "list",
  post: "create",
  put: "replace",
  patch: "update",
  delete: "delete",
};

/** Command-name chain for an operation, e.g. ["me", "tokens", "list"]. */
function commandChain(method: HttpMethod, path: string): string[] {
  const segments = stripBasePath(path).split("/").filter(Boolean);
  const nonParam = segments.filter((s) => !s.startsWith("{"));
  const last = segments[segments.length - 1] ?? "";

  // Item access by path parameter: /records/{id}, /me/tokens/{id}
  if (last.startsWith("{")) {
    const verb = method === "get" ? "get" : PLURAL_VERB[method];
    return [...nonParam, verb];
  }

  const leafSegment = nonParam[nonParam.length - 1] ?? "";
  const prefix = nonParam.slice(0, -1);

  if (method === "get") {
    return [...nonParam, isPlural(leafSegment) ? "list" : "get"];
  }
  // Write methods on a collection -> CRUD verb; on a singular segment -> action.
  if (isPlural(leafSegment)) {
    return [...nonParam, PLURAL_VERB[method]];
  }
  return [...prefix, leafSegment];
}

/** Find or create an intermediate group command under `parent`. */
function group(parent: Command, name: string): Command {
  const existing = parent.commands.find((c) => c.name() === name);
  if (existing) return existing;
  const cmd = new Command(name).description(`${name} commands`);
  parent.addCommand(cmd);
  return cmd;
}

function readData(value: string): unknown {
  const raw = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`--data must be valid JSON (or @file containing JSON); got: ${value}`);
  }
}

function attachLeaf(
  parent: Command,
  name: string,
  pathTemplate: string,
  method: HttpMethod,
  op: OpenApiOperation,
  servers: OpenApiSpec["servers"],
): void {
  const leaf = new Command(name);
  leaf.description(op.summary || `${method.toUpperCase()} ${pathTemplate}`);

  const params = pathParams(pathTemplate);
  for (const p of params) leaf.argument(`<${p}>`, `path parameter: ${p}`);

  const queryParams = (op.parameters ?? []).filter((p) => p.in === "query");
  for (const q of queryParams) {
    leaf.option(`--${q.name} <value>`, q.description || `query parameter: ${q.name}`);
  }

  const acceptsBody = method !== "get" && method !== "delete";
  if (acceptsBody || op.requestBody) {
    leaf.option("--data <json>", "request body as JSON (or @file to read from a file)");
  }

  leaf.action(async (...args: unknown[]) => {
    // commander passes: ...positionalArgs, options, command
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, params.length) as string[];
    const opts = command.optsWithGlobals() as Record<string, string | undefined>;

    const env: Environment = (opts.env as Environment) || resolveEnv();
    const token = (opts.token as string | undefined) || resolveToken();
    const baseUrl = resolveBaseUrl(servers, env);

    let realPath = pathTemplate;
    params.forEach((p, i) => {
      realPath = realPath.replace(`{${p}}`, encodeURIComponent(positionals[i]));
    });

    const query: Record<string, string | undefined> = {};
    for (const q of queryParams) query[q.name] = opts[q.name];

    const body = opts.data !== undefined ? readData(opts.data) : undefined;

    const res = await request({ baseUrl, path: realPath, method, query, body, token });
    printJson(res.data);
  });

  parent.addCommand(leaf);
}

interface Operation {
  chain: string[];
  path: string;
  method: HttpMethod;
  op: OpenApiOperation;
}

/** Build the top-level command group for one API from its spec. */
export function buildApiCommand(api: ApiEntry): Command {
  const spec = loadSpec(api.spec);
  const root = new Command(api.name).description(api.summary || spec.info.title);

  // Collect, then dedupe by command chain so the most specific operation (the
  // one with the most path parameters) wins regardless of declaration order.
  const byChain = new Map<string, Operation>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const entry: Operation = { chain: commandChain(method, path), path, method, op };
      const key = entry.chain.join(" ");
      const existing = byChain.get(key);
      if (!existing || pathParams(path).length > pathParams(existing.path).length) {
        byChain.set(key, entry);
      }
    }
  }

  for (const { chain, path, method, op } of byChain.values()) {
    const leafName = chain[chain.length - 1];
    let parent = root;
    for (const segment of chain.slice(0, -1)) parent = group(parent, segment);
    attachLeaf(parent, leafName, path, method, op, spec.servers);
  }

  return root;
}
