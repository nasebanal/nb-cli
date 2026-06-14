/**
 * Catalog of NASEBANAL APIs the CLI knows about.
 *
 * Each entry maps a top-level command group (`nb <name> ...`) to the OpenAPI
 * spec that drives its sub-commands. Specs are loaded from the local `specs/`
 * directory (synced from nb-api-specs in dev, or shipped with the published
 * package). Base URLs are resolved from the spec's own `servers` block, so this
 * catalog only needs to declare which spec file backs which command group.
 */
export interface ApiEntry {
  /** Top-level command group, e.g. `account` -> `nb account ...`. */
  name: string;
  /** Spec filename under `specs/`. */
  spec: string;
  /** One-line description shown in `nb --help`. */
  summary: string;
}

export const API_CATALOG: ApiEntry[] = [
  { name: "account", spec: "account.yaml", summary: "User profiles, subscriptions, billing, and API tokens" },
  { name: "recorder", spec: "recorder.yaml", summary: "Records and tags (NASEBANAL Recorder)" },
  { name: "target", spec: "target.yaml", summary: "Targets, cells, and shares (NASEBANAL Target)" },
  { name: "app-template", spec: "app-template.yaml", summary: "Reference API surface (App Template)" },
];
