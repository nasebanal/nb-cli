import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { MAX_ATTACHMENT_FILES, buildZip, crc32, listFiles, zipDirectory } from "./zip.js";

/** A just-enough zip reader (central directory only), so the test checks what a real unzip would see. */
function readZip(zip: Buffer): Record<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const rawSize = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflateRawSync(packed) : packed;
    expect(data.length).toBe(rawSize);
    expect(crc32(data)).toBe(crc);
    out[name] = Buffer.from(data);
    at += 46 + nameLen;
  }
  return out;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-zip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("crc32", () => {
  it("matches the standard check values", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("buildZip", () => {
  it("round-trips names (UTF-8 too), compressible and incompressible data, and an empty file", () => {
    const text = Buffer.from("hello ".repeat(500));
    const noise = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 131 + 17) % 251));
    const zip = buildZip([
      { name: "index.html", data: text, mtime: new Date("2026-10-26T12:00:00") },
      { name: "data/レポート.json", data: noise, mtime: new Date("2026-10-26T12:00:00") },
      { name: "empty.txt", data: new Uint8Array(0), mtime: new Date("2026-10-26T12:00:00") },
    ]);
    const files = readZip(zip);
    expect(Object.keys(files)).toEqual(["index.html", "data/レポート.json", "empty.txt"]);
    expect(files["index.html"].equals(text)).toBe(true);
    expect(files["data/レポート.json"].equals(noise)).toBe(true);
    expect(files["empty.txt"].length).toBe(0);
    expect(zip.length).toBeLessThan(text.length + noise.length); // the text was deflated
  });

  it.each(["../x", "a/../x", "/abs", "a\\b", "a//b", ""])("refuses the path %j", (name) => {
    expect(() => buildZip([{ name, data: Buffer.from("x"), mtime: new Date() }])).toThrow(/refusing the path/);
  });

  it("is a zip the system's own unzip accepts", () => {
    let has = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return; // not every runner has unzip; the reader above already checks the structure
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    writeFileSync(join(dir, "src", "a.html"), "<h1>a</h1>".repeat(100));
    writeFileSync(join(dir, "src", "sub", "b.json"), '{"b":1}');
    const out = join(dir, "r.zip");
    writeFileSync(out, zipDirectory(join(dir, "src")));
    expect(execFileSync("unzip", ["-t", out], { encoding: "utf8" })).toContain("No errors detected");
  });
});

describe("zipDirectory", () => {
  it("zips the files under a folder, with forward-slash paths, in a stable order", () => {
    mkdirSync(join(dir, "r", "data"), { recursive: true });
    writeFileSync(join(dir, "r", "index.html"), "<html>ok</html>");
    writeFileSync(join(dir, "r", "data", "one.json"), '{"a":1}');
    const files = readZip(zipDirectory(join(dir, "r")));
    expect(Object.keys(files)).toEqual(["data/one.json", "index.html"]);
    expect(files["index.html"].toString()).toBe("<html>ok</html>");
  });

  it("never follows a symbolic link out of the folder", () => {
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "r", "ok.txt"), "ok");
    writeFileSync(join(dir, "secret.txt"), "TOP SECRET");
    symlinkSync(join(dir, "secret.txt"), join(dir, "r", "link.txt"));
    symlinkSync(dir, join(dir, "r", "up"));
    const files = readZip(zipDirectory(join(dir, "r")));
    expect(Object.keys(files)).toEqual(["ok.txt"]);
    expect(listFiles(join(dir, "r")).map((f) => f.name)).toEqual(["ok.txt"]);
  });

  it("refuses an empty folder, too many files, and a zip bigger than the server takes", () => {
    mkdirSync(join(dir, "empty"));
    expect(() => zipDirectory(join(dir, "empty"))).toThrow(/no files/);

    mkdirSync(join(dir, "many"));
    for (let i = 0; i <= MAX_ATTACHMENT_FILES; i++) writeFileSync(join(dir, "many", `f${i}.txt`), "x");
    expect(() => zipDirectory(join(dir, "many"))).toThrow(/more than 2000 files/);

    mkdirSync(join(dir, "big"));
    // Noise does not deflate, so a small limit is passed instead of writing 20 MiB.
    writeFileSync(join(dir, "big", "n.bin"), randomBytes(5000));
    expect(() => zipDirectory(join(dir, "big"), 1000)).toThrow(/more than the/);
  });
});
