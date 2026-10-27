/**
 * A minimal zip writer for `--attach <folder>`: regular files only, deflate, no dependency.
 *
 * What it will not do is as deliberate as what it does: a symbolic link is never followed (a report folder must
 * not smuggle in a file from elsewhere), nothing is stored under a name that climbs out of the folder, and the
 * size and file count are checked BEFORE anything is read, so a huge folder fails fast instead of eating memory.
 * The server never unzips what it receives, so these are the only checks on the way in.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 2000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what a zip entry carries (2-second resolution, from 1980). */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

export interface ZipEntry {
  /** The path inside the zip: relative, forward slashes. */
  name: string;
  data: Uint8Array;
  mtime: Date;
}

/** Every regular file under `dir`, as `{ name, abs, size, mtime }`, in a stable order. Links and special files are skipped. */
export function listFiles(dir: string): { name: string; abs: string; size: number; mtime: Date }[] {
  const out: { name: string; abs: string; size: number; mtime: Date }[] = [];
  const walk = (abs: string, rel: string[]) => {
    for (const entry of readdirSync(abs).sort()) {
      const full = join(abs, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full, [...rel, entry]);
      else if (stat.isFile()) out.push({ name: [...rel, entry].join(posix.sep), abs: full, size: stat.size, mtime: stat.mtime });
      if (out.length > MAX_ATTACHMENT_FILES) throw new Error(`--attach: more than ${MAX_ATTACHMENT_FILES} files in the folder`);
    }
  };
  walk(dir, []);
  return out;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (e.name === "" || e.name.startsWith("/") || e.name.includes("\\") || e.name.split("/").some((s) => s === ".." || s === "")) {
      throw new Error(`--attach: refusing the path '${e.name}'`);
    }
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const packed = deflateRawSync(raw);
    // Store as is when deflate does not help (already-compressed images and the like).
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { date, time } = dosDateTime(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flag: names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

/** A folder as a zip, or a refusal: too many files, or more than the server takes. */
export function zipDirectory(dir: string, limit: number = MAX_ATTACHMENT_BYTES): Buffer {
  const files = listFiles(dir);
  if (files.length === 0) throw new Error(`--attach: no files in ${dir}`);
  // Before reading anything: a folder this much bigger than the limit cannot shrink to it (deflate rarely does better than 10:1 on reports).
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > limit * 20) throw new Error(`--attach: ${dir} is ${Math.round(total / 1048576)} MiB; attach only the report (at most ${limit / 1048576} MiB zipped)`);
  const zip = buildZip(files.map((f) => ({ name: f.name, data: readFileSync(f.abs), mtime: f.mtime })));
  if (zip.length > limit) throw new Error(`--attach: the zip of ${dir} is ${(zip.length / 1048576).toFixed(1)} MiB, more than the ${limit / 1048576} MiB the server takes`);
  return zip;
}

/** The platform's separator never reaches the zip. */
export const toPosix = (p: string) => p.split(sep).join(posix.sep);
