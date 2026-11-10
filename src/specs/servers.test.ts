import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkServerUrl, setServers } from "./servers.js";

const yaml = `# the contract
openapi: 3.0.3
info:
  title: Account API
  version: "1"
servers:
  - url: http://localhost:8788
    description: local
  - url: https://api.example.com
# paths follow
paths:
  /health:
    get:
      summary: Health # keep me
      responses:
        "200":
          description: ok
`;

describe("setServers", () => {
  it("replaces the servers block of a YAML file as text, keeping comments and order", () => {
    const out = setServers(yaml, "https://staging.example.com/v1");
    expect(out.method).toBe("text");
    expect(out.text).toContain("# the contract");
    expect(out.text).toContain("# paths follow");
    expect(out.text).toContain("summary: Health # keep me");
    const doc = parse(out.text) as { servers: unknown; paths: unknown; info: unknown };
    expect(doc.servers).toEqual([{ url: "https://staging.example.com/v1" }]);
    expect(Object.keys(parse(out.text) as object)).toEqual(["openapi", "info", "servers", "paths"]);
  });

  it("inserts a servers block before paths when there is none", () => {
    const out = setServers(yaml.replace(/servers:[\s\S]*?(?=# paths follow)/, ""), "https://a.example.com");
    expect(out.method).toBe("text");
    expect((parse(out.text) as { servers: unknown }).servers).toEqual([{ url: "https://a.example.com" }]);
  });

  it("handles a flow-style servers line and servers items at column 0", () => {
    expect((parse(setServers("openapi: 3.0.3\nservers: []\npaths: {}\n", "https://x.example.com").text) as { servers: unknown }).servers).toEqual([{ url: "https://x.example.com" }]);
    const zero = "openapi: 3.0.3\nservers:\n- url: https://old.example.com\npaths: {}\n";
    const out = setServers(zero, "https://new.example.com");
    expect(out.method).toBe("text");
    expect((parse(out.text) as { servers: unknown; paths: unknown })).toEqual({ openapi: "3.0.3", servers: [{ url: "https://new.example.com" }], paths: {} });
  });

  it("edits a JSON file as JSON", () => {
    const out = setServers(JSON.stringify({ openapi: "3.0.3", servers: [{ url: "https://old" }], paths: {} }), "https://new.example.com");
    expect(out.method).toBe("json");
    expect(JSON.parse(out.text)).toEqual({ openapi: "3.0.3", servers: [{ url: "https://new.example.com" }], paths: {} });
  });

  it("refuses a document that is not an object, and a bad URL", () => {
    expect(() => setServers("- a\n- b\n", "https://x.example.com")).toThrow(/OpenAPI object/);
    expect(() => checkServerUrl("not a url")).toThrow(/not a URL/);
    expect(() => checkServerUrl("ftp://x")).toThrow(/http\(s\)/);
    expect(checkServerUrl(" https://x.example.com ")).toBe("https://x.example.com");
  });
});
