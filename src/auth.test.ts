import { afterEach, describe, expect, it, vi } from "vitest";
import { envTokenHint } from "./output.js";
import { resolveAccessToken } from "./config.js";
import { hostKind, loginIdentity, targetLines } from "./auth.js";

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

describe("targetLines (what `nb auth status` says about where the commands go)", () => {
  const clear = () => {
    for (const k of ["NB_BASE_URL", "NB_ACCOUNT_BASE_URL", "NB_RECORD_BASE_URL", "NB_TARGET_BASE_URL", "NB_ASSURANCE_BASE_URL", "NB_SPECS_BASE_URL"]) vi.stubEnv(k, "");
  };
  const line = (lines: string[], api: string) => lines.find((l) => l.startsWith(api)) ?? "";

  it("names every API with its host and says production for the production environment", () => {
    clear();
    const lines = targetLines("production");
    expect(lines).toHaveLength(5);
    expect(line(lines, "assurance")).toContain("https://api.assurance.nasebanal.com");
    expect(line(lines, "assurance")).toContain("[production]");
    expect(line(lines, "specs")).toContain("[production]");
  });

  it("says local for the local environment, with the local hosts", () => {
    clear();
    const lines = targetLines("local");
    expect(line(lines, "assurance")).toContain("http://localhost:8791");
    expect(line(lines, "assurance")).toContain("[local]");
    expect(line(lines, "specs")).toContain("http://localhost:8792");
  });

  it("shows a host from NB_<API>_BASE_URL over the environment, and which variable it came from", () => {
    clear();
    vi.stubEnv("NB_ASSURANCE_BASE_URL", "http://localhost:8791");
    vi.stubEnv("NB_SPECS_BASE_URL", "http://localhost:8792");
    const lines = targetLines("production");
    expect(line(lines, "assurance")).toContain("[local, from NB_ASSURANCE_BASE_URL]");
    expect(line(lines, "specs")).toContain("[local, from NB_SPECS_BASE_URL]");
    expect(line(lines, "account")).toContain("[production]"); // the others are not moved
  });

  it("shows the deprecated shared NB_BASE_URL as the source for the generated groups, but not for `specs` (it never read it)", () => {
    clear();
    vi.stubEnv("NB_BASE_URL", "http://localhost:8791");
    const lines = targetLines("production");
    expect(line(lines, "assurance")).toContain("from NB_BASE_URL");
    expect(line(lines, "specs")).toContain("[production]");
  });

  it("writes nothing to stderr (the deprecation notice is for a command that calls an API, not for a status)", () => {
    clear();
    vi.stubEnv("NB_BASE_URL", "http://localhost:8791");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    targetLines("production");
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("hostKind (production / local / other, by the host)", () => {
  it("calls *.nasebanal.com production and a host on this machine local", () => {
    expect(hostKind("https://api.assurance.nasebanal.com")).toBe("production");
    expect(hostKind("https://nasebanal.com/x")).toBe("production");
    expect(hostKind("http://api.assurance.nasebanal.com/")).toBe("production");
    expect(hostKind("http://localhost:8791")).toBe("local");
    expect(hostKind("http://127.0.0.1:8792/api")).toBe("local");
  });

  it("does not call anything else production: a stub or a self-hosted copy is other, and so is a look-alike or a bad URL", () => {
    expect(hostKind("https://stub.example.com")).toBe("other");
    expect(hostKind("https://nasebanal.com.evil.example")).toBe("other");
    expect(hostKind("https://notnasebanal.com")).toBe("other");
    expect(hostKind("not a url")).toBe("other");
  });
});

describe("loginIdentity (who `nb auth status` says the login is)", () => {
  const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  it("reads name and email from the ID token the login stored", () => {
    expect(loginIdentity(idToken({ name: "Ada Lovelace", email: "ada@example.com" }))).toBe("Ada Lovelace <ada@example.com>");
  });

  it("falls back to what is there: the email alone, or the nickname when there is no name", () => {
    expect(loginIdentity(idToken({ email: "ada@example.com" }))).toBe("ada@example.com");
    expect(loginIdentity(idToken({ nickname: "ada", email: "ada@example.com" }))).toBe("ada <ada@example.com>");
  });

  it("is null when there is no ID token, or it cannot be read", () => {
    expect(loginIdentity(undefined)).toBeNull();
    expect(loginIdentity("")).toBeNull();
    expect(loginIdentity("not-a-jwt")).toBeNull();
    expect(loginIdentity("h.%%%.s")).toBeNull();
    expect(loginIdentity(idToken({}))).toBeNull();
  });
});
