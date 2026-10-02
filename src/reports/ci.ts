/**
 * Where a report came from, taken from the CI environment so a pipeline step
 * needs no flags: GitHub Actions and GitLab CI are recognised; anywhere else
 * falls back to git (and a per-day key, so a local re-run replaces rather than
 * piles up). Every value can still be overridden on the command line.
 */
import { execFileSync } from "node:child_process";

export interface CiInfo {
  provider: "github" | "gitlab" | "local";
  /** Stable per pipeline run: every job of one run must send the same key. */
  runKey: string | null;
  commitSha: string | null;
  branch: string | null;
  ciUrl: string | null;
  /** Default project name and repository. */
  project: string | null;
  repo: string | null;
}

export interface GitInfo {
  sha: string | null;
  branch: string | null;
}

export function readGit(): GitInfo {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  return { sha: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") };
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v : null);

export function detectCi(env: NodeJS.ProcessEnv, git: () => GitInfo = readGit, now: Date = new Date()): CiInfo {
  if (env.GITHUB_ACTIONS === "true") {
    const repo = nonEmpty(env.GITHUB_REPOSITORY);
    const runId = nonEmpty(env.GITHUB_RUN_ID);
    const server = nonEmpty(env.GITHUB_SERVER_URL) ?? "https://github.com";
    return {
      provider: "github",
      runKey: runId ? `${runId}-${nonEmpty(env.GITHUB_RUN_ATTEMPT) ?? "1"}` : null,
      commitSha: nonEmpty(env.GITHUB_SHA),
      branch: nonEmpty(env.GITHUB_REF_NAME),
      ciUrl: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
      project: repo,
      repo,
    };
  }
  if (env.GITLAB_CI === "true") {
    const path = nonEmpty(env.CI_PROJECT_PATH);
    const host = nonEmpty(env.CI_SERVER_HOST);
    return {
      provider: "gitlab",
      runKey: nonEmpty(env.CI_PIPELINE_ID),
      commitSha: nonEmpty(env.CI_COMMIT_SHA),
      branch: nonEmpty(env.CI_COMMIT_REF_NAME),
      ciUrl: nonEmpty(env.CI_PIPELINE_URL),
      project: path,
      repo: path && host && host !== "gitlab.com" ? `${host}/${path}` : path,
    };
  }
  const { sha, branch } = git();
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return {
    provider: "local",
    runKey: sha ? `local-${sha.slice(0, 7)}-${day}` : `local-${day}`,
    commitSha: sha,
    branch,
    ciUrl: null,
    project: null,
    repo: null,
  };
}
