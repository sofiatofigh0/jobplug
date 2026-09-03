/**
 * Pin the extension ID.
 *
 * Chrome derives an unpacked extension's ID from its folder path, so the ID
 * changes every time the folder moves — and both OAuth paths bake that ID in
 * (the Chrome-app client is bound to it; the PKCE redirect URI contains it).
 * Re-unzipping a download to a new location therefore breaks sign-in.
 *
 * Adding a `key` to the manifest makes the ID a function of that key instead,
 * so it survives moving, re-downloading and re-cloning. This generates the key
 * once, writes the public half into manifest.json, and keeps the private half
 * in key.pem (gitignored) in case you ever want to pack a .crx.
 *
 *   npm run pin-id            generate and write (refuses to clobber)
 *   npm run pin-id -- --force replace an existing key
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const pemPath = path.join(root, 'key.pem');
const force = process.argv.includes('--force');

/** Chrome's rule: first 128 bits of SHA-256(SPKI DER), hex digits mapped 0-f -> a-p. */
function extensionId(der) {
  const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.key && !force) {
  const der = Buffer.from(manifest.key, 'base64');
  console.log(`manifest.json already carries a key.\nExtension ID: ${extensionId(der)}`);
  console.log('\nPass --force to replace it (this changes the ID and invalidates your OAuth client).');
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const id = extensionId(der);

// `key` must come before the rest for readability, but JSON order is cosmetic.
const rebuilt = { manifest_version: manifest.manifest_version, name: manifest.name, version: manifest.version, key: der.toString('base64') };
for (const [k, v] of Object.entries(manifest)) if (!(k in rebuilt)) rebuilt[k] = v;

fs.writeFileSync(manifestPath, JSON.stringify(rebuilt, null, 2) + '\n');
fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log(`Extension ID pinned: ${id}`);
console.log(`
  · manifest.json now carries the public key — this is safe to commit, and
    committing it keeps the same ID on every machine you load it from.
  · key.pem holds the private key. It is gitignored. You only need it to pack
    a .crx; losing it does not break anything above.

Use ${id} as the Item ID (Chrome-app client) or in the redirect URI
https://${id}.chromiumapp.org/ (browser-redirect client).`);
