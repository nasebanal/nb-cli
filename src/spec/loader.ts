/**
 * Loads and minimally types the OpenAPI specs that drive the command tree.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/spec/loader.js  -> ../../specs ; src/spec/loader.ts -> ../../specs
const SPECS_DIR = join(__dirname, "..", "..", "specs");

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, unknown> };
  security?: unknown[];
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: unknown[] };
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiSpec {
  info: { title: string; version: string; description?: string };
  servers?: OpenApiServer[];
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

export function specPath(file: string): string {
  return join(SPECS_DIR, file);
}

export function specExists(file: string): boolean {
  return existsSync(specPath(file));
}

export function loadSpec(file: string): OpenApiSpec {
  const path = specPath(file);
  if (!existsSync(path)) {
    throw new Error(
      `Spec not found: ${path}\nRun \`npm run sync-specs\` (local dev) to populate the specs/ directory.`,
    );
  }
  return parse(readFileSync(path, "utf8")) as OpenApiSpec;
}
