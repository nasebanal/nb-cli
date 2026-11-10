/**
 * Which spec (and so which repository row) a CI step is about - the one name resolution every assurance command shares
 * (results and external monitoring work on a SPEC that has a repository; the model is in
 * docs/decisions/2026-11-09-repository-as-parent-of-specs.md of nb-apps, "Amendment 2").
 *
 * Two ways to say it, never mixed:
 *   - by id:    `--spec-id <id>`
 *   - by names: `--repository <name> [--component <name>] [--group <name>] [--api-version <v>] --spec <name>` (provider defaults to
 *     github). The key of a spec is its group, its repository row (provider, name, component), its API VERSION (v1, v2) and its
 *     name: the same name may exist in other groups (an environment each), under other repositories and at other API versions.
 *     The component is optional: none = the repository as a whole. The group is optional too, and NOT a wildcard: none = the specs
 *     that are in no group. The API version is the one deliberate exception to "left out means none": left out, it is the API
 *     version of the one spec the rest of the key matches (and when the rest matches specs of several API versions the error
 *     lists them and asks for --api-version). On a miss the error lists where the name does exist and asks for --group /
 *     --repository / --component / --api-version / --spec-id.
 *
 * Nothing is ever created here (a result does not register a spec or a repository: that is `nb specs ...`). A spec with no
 * repository is refused, because a result or a monitor is reported against the repository the spec is tied to.
 */
import { ApiError, request } from "../http.js";
import { checkApiVersion, sameApiVersion } from "./apiVersion.js";
import { checkProvider, headersOf, reasonOf, type Envelope, type RepositoryProvider, type RepositoryRow, type SpecsConnection } from "./push.js";

export interface SpecRef {
  /** By id. Excludes the names below. */
  specId?: string;
  /** By names: the repository (owner/name for a git host), the optional component, the spec's name. */
  repository?: string;
  component?: string;
  /** By names: the group the spec is filed in (an environment, say); none = the specs in no group. */
  group?: string;
  /** By names: the API version (v1, v2) of the spec. Left out = the API version of the one spec the rest of the key matches. */
  apiVersion?: string;
  spec?: string;
  /** With `repository`: github | gitlab | bitbucket | other (default github). */
  provider?: string;
}

export interface ResolvedSpec {
  spec_id: string;
  spec_name: string;
  /** The repository row the spec is tied to: what a result / monitor is reported against. */
  repository_id: string;
  repository: RepositoryRow;
}

interface SpecItem {
  id: string;
  name: string;
  group_id?: string | null;
  repository_id?: string | null;
  api_version?: string;
}

interface GroupItem {
  id: string;
  name: string;
}

const label = (r: Pick<RepositoryRow, "provider" | "name" | "component">): string => `${r.provider} ${r.name}${r.component ? ` / ${r.component}` : ""}`;

async function get<T>(conn: SpecsConnection, path: string): Promise<T> {
  try {
    return ((await request({ ...headersOf(conn), method: "GET", path })).data as Envelope<T>).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw err;
    if (err instanceof ApiError) throw new Error(`The catalog refused the request: ${reasonOf(err)}`);
    throw err;
  }
}

const noRepository = (s: SpecItem): Error =>
  new Error(`The spec '${s.name}' is tied to no repository: a result or a monitor is reported against the repository a spec is tied to. Tie it first (Spec Management on the screen, or 'nb specs specs update ${s.id} --data '{"repository_id":"<id>"}'').`);

/** A spec found by its key, with the repository row it is tied to (null when it is tied to none). */
export interface LocatedSpec {
  spec: SpecItem;
  repository: RepositoryRow | null;
}

async function groupsOf(conn: SpecsConnection): Promise<GroupItem[]> {
  return (await get<{ data: GroupItem[] }>(conn, "/api/v1/groups")).data;
}

/** Where a spec reads in an error: `group 'prod' / github acme/api / web / v2`. */
function whereOf(s: SpecItem, groups: GroupItem[], repositories: RepositoryRow[]): string {
  const g = s.group_id ? `group '${groups.find((x) => x.id === s.group_id)?.name ?? s.group_id}'` : "no group";
  const r = s.repository_id ? (repositories.find((x) => x.id === s.repository_id) ? label(repositories.find((x) => x.id === s.repository_id)!) : `repository ${s.repository_id}`) : "no repository";
  return `${g} / ${r} / ${s.api_version ?? "v1"}`;
}

/**
 * A spec by its key, without requiring a repository (a spec description document or a pull works on a spec with none): `--spec-id`,
 * or `--spec <name>` with the optional `--repository` [`--component`] `--provider` and `--group`. Whatever is not given is "none":
 * no repository = a spec tied to no repository, no group = a spec in no group. Nothing is created.
 */
export async function locateSpec(conn: SpecsConnection, ref: SpecRef): Promise<LocatedSpec> {
  const byId = ref.specId?.trim() || undefined;
  const specName = ref.spec?.trim() || undefined;
  const repositoryName = ref.repository?.trim() || undefined;
  const groupName = ref.group?.trim() || undefined;
  const component = ref.component?.trim() ?? "";
  const apiVersion = ref.apiVersion?.trim() ? checkApiVersion(ref.apiVersion) : undefined;
  if (byId && (repositoryName || specName || component || groupName || apiVersion)) {
    throw new Error("--spec-id names the spec by itself: do not combine it with --repository, --component, --group, --api-version or --spec");
  }
  if (!byId && !specName) throw new Error("Say which spec: --spec-id <id>, or --spec <name> [--repository <name> [--component <name>]] [--group <name>] [--api-version <v>]");
  if (!byId && !repositoryName && (component !== "" || ref.provider)) throw new Error("--component and --provider need --repository");

  if (byId) {
    let spec: SpecItem;
    try {
      spec = await get<SpecItem>(conn, `/api/v1/specs/${encodeURIComponent(byId)}`);
    } catch (err) {
      if (err instanceof ApiError) throw new Error(`No spec with id '${byId}' in the catalog (check --spec-id, and --org: the catalog is per owner).`);
      throw err;
    }
    return { spec, repository: await repositoryOfSpec(conn, spec) };
  }

  if (repositoryName) checkProvider(ref.provider); // refused before anything is sent
  // The groups are read only when one is named (to turn its name into an id); an error reads them best-effort, to name them.
  const groups = groupName ? await groupsOf(conn) : [];
  let groupId: string | null = null;
  if (groupName) {
    const g = groups.find((x) => x.name.toLowerCase() === groupName.toLowerCase());
    if (!g) throw new Error(`No group named '${groupName}' in the catalog${groups.length > 0 ? ` (groups: ${groups.map((x) => x.name).join(", ")})` : ""}.`);
    groupId = g.id;
  }
  const repositories = (await get<{ data: RepositoryRow[] }>(conn, "/api/v1/repositories")).data;
  let repository: RepositoryRow | null = null;
  if (repositoryName) {
    const provider: RepositoryProvider = checkProvider(ref.provider);
    repository = repositories.find((r) => r.provider === provider && r.name.toLowerCase() === repositoryName.toLowerCase() && (r.component ?? "").toLowerCase() === component.toLowerCase()) ?? null;
    if (!repository) {
      throw new Error(`No repository ${label({ provider, name: repositoryName, component })} in the catalog (nothing is created here: 'nb specs repositories upsert'; check --provider and --component, which are part of the key).`);
    }
  }
  const specs = (await get<{ data: SpecItem[] }>(conn, "/api/v1/specs")).data;
  const named = specs.filter((s) => s.name.toLowerCase() === specName!.toLowerCase());
  if (named.length === 0) throw new Error(`No spec named '${specName}' in the catalog (nothing is created here: 'nb specs specs push').`);
  const here = named.filter((s) => (s.group_id ?? null) === groupId && (s.repository_id ?? null) === (repository?.id ?? null));
  // The API version is part of the key; left out, it is the one the rest of the key leaves (several: the error lists them).
  const hits = apiVersion === undefined ? here : here.filter((s) => sameApiVersion(s.api_version ?? "v1", apiVersion));
  if (hits.length > 1) {
    throw new Error(
      `'${specName}' exists at more than one API version in ${groupName ? `group '${groupName}'` : "no group"} / ${repository ? label(repository) : "no repository"}: ${hits.map((s) => s.api_version ?? "v1").join(", ")}. ` +
        "Say which with --api-version (the API version is part of the spec's key; unlike the group and the component, leaving it out is not 'none').",
    );
  }
  const hit = hits[0];
  if (!hit) {
    const asked = `${groupName ? `group '${groupName}'` : "no group"} / ${repository ? label(repository) : "no repository"}${apiVersion ? ` / ${apiVersion}` : ""}`;
    const known = groups.length > 0 ? groups : await groupsOf(conn).catch(() => [] as GroupItem[]);
    throw new Error(
      `No spec named '${specName}' in ${asked}. The name exists in: ${named.map((s) => whereOf(s, known, repositories)).join("; ")}. ` +
        "Say which with --group, --repository (and --component), --api-version, or use --spec-id (a group or repository you leave out means none, not any).",
    );
  }
  return { spec: hit, repository };
}

async function repositoryOfSpec(conn: SpecsConnection, spec: SpecItem): Promise<RepositoryRow | null> {
  if (!spec.repository_id) return null;
  try {
    return await get<RepositoryRow>(conn, `/api/v1/repositories/${encodeURIComponent(spec.repository_id)}`);
  } catch (err) {
    if (err instanceof ApiError) throw new Error(`The spec '${spec.name}' points at repository '${spec.repository_id}', which the catalog does not have.`);
    throw err;
  }
}

export async function resolveSpec(conn: SpecsConnection, ref: SpecRef): Promise<ResolvedSpec> {
  const byId = ref.specId?.trim() || undefined;
  const repositoryName = ref.repository?.trim() || undefined;
  const specName = ref.spec?.trim() || undefined;
  const groupName = ref.group?.trim() || undefined;
  const component = ref.component?.trim() ?? "";
  const apiVersionAsked = !!ref.apiVersion?.trim();
  if (byId && (repositoryName || specName || component || groupName || apiVersionAsked)) {
    throw new Error("--spec-id names the spec by itself: do not combine it with --repository, --component, --group, --api-version or --spec");
  }
  if (!byId && !repositoryName && !specName && component === "" && !groupName && !apiVersionAsked) {
    throw new Error("Say which spec: --spec-id <id>, or --repository <name> [--component <name>] [--group <name>] [--api-version <v>] --spec <name>");
  }
  if (!byId && !repositoryName) throw new Error("--repository is required with --spec (--component is optional: none = the repository as a whole; --group too: none = no group)");
  if (!byId && !specName) throw new Error("--spec is required with --repository");

  const { spec, repository } = await locateSpec(conn, ref);
  if (!repository) throw noRepository(spec);
  return { spec_id: spec.id, spec_name: spec.name, repository_id: repository.id, repository };
}

/**
 * Every spec tied to one repository row AND one API version, whatever its group (`--all-specs`: a result that belongs to the source,
 * such as a unit test run, is recorded for each environment's spec of that repository at that API version: a `release/v1` branch
 * does not feed the v2 specs). Names only: `--repository` [`--component`] [`--provider`] [`--api-version`]. Without `--api-version`
 * it is the API version the repository row has, when it has one; with specs of several, the error lists them and asks.
 */
export async function resolveRepositorySpecs(conn: SpecsConnection, ref: Pick<SpecRef, "repository" | "component" | "provider" | "apiVersion">): Promise<ResolvedSpec[]> {
  const repositoryName = ref.repository?.trim();
  if (!repositoryName) throw new Error("--all-specs needs --repository <name> [--component <name>]");
  const component = ref.component?.trim() ?? "";
  const provider: RepositoryProvider = checkProvider(ref.provider);
  const repositories = (await get<{ data: RepositoryRow[] }>(conn, "/api/v1/repositories")).data;
  const repository = repositories.find((r) => r.provider === provider && r.name.toLowerCase() === repositoryName.toLowerCase() && (r.component ?? "").toLowerCase() === component.toLowerCase());
  if (!repository) throw new Error(`No repository ${label({ provider, name: repositoryName, component })} in the catalog (nothing is created here: 'nb specs repositories upsert').`);
  const all = (await get<{ data: SpecItem[] }>(conn, "/api/v1/specs")).data.filter((s) => s.repository_id === repository.id);
  if (all.length === 0) throw new Error(`No spec is tied to ${label(repository)}: register one ('nb specs specs push --repository ...') before reporting results.`);
  const versions = [...new Set(all.map((s) => (s.api_version ?? "v1").toLowerCase()))].sort();
  const asked = ref.apiVersion?.trim() ? checkApiVersion(ref.apiVersion) : undefined;
  if (asked === undefined && versions.length > 1) {
    throw new Error(`${label(repository)} has specs at several API versions (${versions.join(", ")}): say which one gets the result with --api-version (a release branch feeds its own API version only).`);
  }
  const specs = asked === undefined ? all : all.filter((s) => sameApiVersion(s.api_version ?? "v1", asked));
  if (specs.length === 0) throw new Error(`No spec of ${label(repository)} is at API version '${asked}' (it has: ${versions.join(", ")}).`);
  const groups = await groupsOf(conn).catch(() => [] as GroupItem[]);
  return [...specs]
    .sort((a, b) => (groups.find((g) => g.id === a.group_id)?.name ?? "").localeCompare(groups.find((g) => g.id === b.group_id)?.name ?? "") || a.name.localeCompare(b.name))
    .map((s) => ({ spec_id: s.id, spec_name: s.name, repository_id: repository.id, repository }));
}
