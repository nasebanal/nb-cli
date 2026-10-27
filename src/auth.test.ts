import { afterEach, describe, expect, it, vi } from "vitest";
import { envTokenHint } from "./output.js";
import { resolveAccessToken } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("which credential wins", () => {
  it("NB_TOKEN in the environment wins over a stored login: the CI path, and the reason for the hint below", async () => {
    vi.stubEnv("NB_TOKEN", "nbpat_from_env");
    const config = { auth: { access_token: "jwt.from.login", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: "", token_type: "Bearer", id_token: "i" } };
    expect(await resolveAccessToken(config as never)).toBe("nbpat_from_env");
  });

  it("without NB_TOKEN the stored login is used", async () => {
    vi.stubEnv("NB_TOKEN", "");
    const config = { auth: { access_token: "jwt.from.login", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: "", token_type: "Bearer", id_token: "i" } };
    expect(await resolveAccessToken(config as never)).toBe("jwt.from.login");
  });
});

describe("envTokenHint", () => {
  it("is there only when NB_TOKEN is set, and says how to get out of it", () => {
    vi.stubEnv("NB_TOKEN", "");
    expect(envTokenHint()).toBeNull();
    vi.stubEnv("NB_TOKEN", "nbpat_x");
    expect(envTokenHint()).toMatch(/NB_TOKEN is set.*unset NB_TOKEN/s);
  });
});
