/**
 * Self-update: a passive "new version available" notice and `nb upgrade`.
 *
 * Follows the usual CLI convention (npm, gh, gcloud): the notice is a single
 * line on stderr, shown at most once a day from a cached registry lookup, and
 * silent for non-interactive use (pipes, CI) so scripted output never changes.
 * `NB_NO_UPDATE_NOTIFIER=1` turns it off.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { configDir } from "./config.js";

const PACKAGE = "@nasebanal/cli";
const REGISTRY = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

interface Cache {
  checkedAt: number;
  latest?: string;
}

/** 1 if a > b, -1 if a < b, 0 if equal (plain `x.y.z`; pre-release tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function cachePath(): string {
  return join(configDir(), "update-check.json");
}

function readCache(): Cache | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as Cache;
  } catch {
    return undefined;
  }
}

function writeCache(cache: Cache): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache) + "\n");
  } catch {
    /* best effort */
  }
}

/** Latest published version. Goes to the public registry directly, so a `~/.npmrc` scope mapping cannot hide it. */
export async function fetchLatest(timeoutMs = FETCH_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const res = await fetch(`${REGISTRY}/${PACKAGE.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function notifierEnabled(): boolean {
  return !process.env.NB_NO_UPDATE_NOTIFIER && !process.env.CI && !!process.stderr.isTTY;
}

/**
 * Arrange for the update notice to print when the process exits. Reads the
 * cache synchronously; when it is older than a day, refreshes it afterwards
 * (bounded by a short timeout) so the notice appears from the next run on.
 */
export function startUpdateNotifier(current: string, argv: string[]): { refresh: () => Promise<void> } {
  const noop = { refresh: async () => {} };
  if (!notifierEnabled() || argv.slice(2).some((a) => a === "upgrade" || a === "--version" || a === "-V")) return noop;
  const cache = readCache();
  if (cache?.latest && compareVersions(cache.latest, current) > 0) {
    const latest = cache.latest;
    process.on("exit", () => {
      process.stderr.write(`\nUpdate available: ${current} -> ${latest}. Run \`nb upgrade\` to install it.\n`);
    });
  }
  const stale = !cache || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS;
  return {
    refresh: async () => {
      if (!stale) return;
      const latest = await fetchLatest();
      // Record the attempt even on failure so an offline machine is not retried on every command.
      writeCache({ checkedAt: Date.now(), latest: latest ?? cache?.latest });
    },
  };
}

/** True when `nb` is a dev link to a checkout rather than an npm-installed copy. */
function isLinkedCheckout(): boolean {
  try {
    return !realpathSync(process.argv[1]).includes("node_modules");
  } catch {
    return false;
  }
}

export function buildUpgradeCommand(current: string): Command {
  return new Command("upgrade")
    .description("Upgrade nb to the latest published version")
    .option("--check", "only report whether a newer version exists")
    .action(async (opts: { check?: boolean }) => {
      const latest = await fetchLatest(5000);
      if (!latest) throw new Error("Could not reach the npm registry to look up the latest version.");
      writeCache({ checkedAt: Date.now(), latest });
      if (compareVersions(latest, current) <= 0) {
        process.stdout.write(`nb ${current} is up to date.\n`);
        return;
      }
      process.stdout.write(`Update available: ${current} -> ${latest}\n`);
      if (opts.check) return;
      if (isLinkedCheckout()) {
        process.stdout.write("This nb is linked to a source checkout: `git pull && npm run build` there instead.\n");
        return;
      }
      const r = spawnSync(
        "npm",
        ["install", "-g", `${PACKAGE}@${latest}`, `--@nasebanal:registry=${REGISTRY}/`],
        { stdio: "inherit" },
      );
      if (r.status !== 0) {
        throw new Error(
          `npm install failed. Run it yourself: npm install -g ${PACKAGE}@latest --@nasebanal:registry=${REGISTRY}/`,
        );
      }
    });
}

