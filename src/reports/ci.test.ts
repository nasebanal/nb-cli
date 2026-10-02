import { describe, it, expect } from "vitest";
import { detectCi } from "./ci.js";

const noGit = () => ({ sha: null, branch: null });

describe("detectCi", () => {
  it("reads GitHub Actions", () => {
    const ci = detectCi({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "nasebanal/nb-target-api",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SHA: "abc",
      GITHUB_REF_NAME: "main",
    }, noGit);
    expect(ci).toEqual({
      provider: "github",
      runKey: "123-2",
      commitSha: "abc",
      branch: "main",
      ciUrl: "https://github.com/nasebanal/nb-target-api/actions/runs/123",
      project: "nasebanal/nb-target-api",
      repo: "nasebanal/nb-target-api",
    });
  });

  it("defaults the attempt to 1 and honours GITHUB_SERVER_URL", () => {
    const ci = detectCi({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "9", GITHUB_SERVER_URL: "https://ghe.example.com" }, noGit);
    expect(ci.runKey).toBe("9-1");
    expect(ci.ciUrl).toBe("https://ghe.example.com/o/r/actions/runs/9");
  });

  it("reads GitLab CI, prefixing the host for a self-hosted server only", () => {
    const base = { GITLAB_CI: "true", CI_PROJECT_PATH: "group/sub/app", CI_PIPELINE_ID: "77", CI_COMMIT_SHA: "def", CI_COMMIT_REF_NAME: "dev", CI_PIPELINE_URL: "https://gl/p/77" };
    expect(detectCi({ ...base, CI_SERVER_HOST: "gitlab.com" }, noGit)).toMatchObject({ provider: "gitlab", runKey: "77", repo: "group/sub/app", project: "group/sub/app", branch: "dev", ciUrl: "https://gl/p/77" });
    expect(detectCi({ ...base, CI_SERVER_HOST: "git.corp.example" }, noGit).repo).toBe("git.corp.example/group/sub/app");
  });

  it("falls back to git with a per-day key, and to nothing outside a repository", () => {
    const now = new Date("2026-10-01T09:00:00Z");
    expect(detectCi({}, () => ({ sha: "1234567890", branch: "feat" }), now)).toMatchObject({
      provider: "local",
      runKey: "local-1234567-20261001",
      commitSha: "1234567890",
      branch: "feat",
      project: null,
    });
    expect(detectCi({}, noGit, now).runKey).toBe("local-20261001");
  });
});
