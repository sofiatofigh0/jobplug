/**
 * Bundle extension/ into a single jobplug-extension.zip at the repo root.
 *
 * Written for the Codespaces workflow: downloading one file out of a remote
 * container is reliable, downloading a 25-file tree is not. Pure Node, no
 * dependencies and no `zip` binary required.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.join(import.meta.dirname, '..');
const srcDir = path.join(root, 'extension');
const outPath = path.join(root, 'jobplug-extension.zip');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

/** DOS timestamp, fixed so the same input always produces the same archive. */
const DOS_TIME = 0x6000;   // 12:00:00
const DOS_DATE = 0x5A21;   // 2025-01-01

const files = walk(srcDir);
const locals = [];
const central = [];
let offset = 0;

for (const file of files) {
  const nameBuf = Buffer.from(file.name, 'utf8');
  const deflated = zlib.deflateRawSync(file.data, { level: 9 });
  // Only use deflate when it actually helps; otherwise store.
  const useDeflate = deflated.length < file.data.length;
  const body = useDeflate ? deflated : file.data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(file.data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0, 6);             // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(file.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);            // extra length
  locals.push(local, nameBuf, body);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);              // version made by
  dir.writeUInt16LE(20, 6);              // version needed
  dir.writeUInt16LE(0, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(file.data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt16LE(0, 30);              // extra
  dir.writeUInt16LE(0, 32);              // comment
  dir.writeUInt16LE(0, 34);              // disk start
  dir.writeUInt16LE(0, 36);              // internal attrs
  dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs (unix 0644)
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`Wrote jobplug-extension.zip — ${files.length} files, ${kb(fs.statSync(outPath).size)}`);
if (JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8')).key) {
  console.log('manifest carries a pinned key, so the extension ID is stable wherever this is unzipped.');
} else {
  console.log('note: no pinned key — run `npm run pin-id` first if you want a stable extension ID.');
}
console.log('\nDownload it, unzip, then load the unzipped folder via chrome://extensions -> Load unpacked.');
