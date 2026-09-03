/**
 * Pre-load sanity check: everything manifest.json names exists, every script
 * parses, and the HTML pages only reference files that are present.
 * Run with `npm run check` before loading the unpacked extension.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.join(import.meta.dirname, '..', 'extension');
const problems = [];
const checked = new Set();

const rel = (p) => path.relative(ROOT, p);

function mustExist(file, why) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) problems.push(`missing ${file} (${why})`);
  return full;
}

function mustParse(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full) || checked.has(full)) return;
  checked.add(full);
  const src = fs.readFileSync(full, 'utf8');
  try {
    // Modules and classic scripts both have to compile; try module first.
    new vm.SourceTextModule(src, { identifier: full });
  } catch (moduleErr) {
    try {
      new vm.Script(src, { filename: full });
    } catch (scriptErr) {
      problems.push(`syntax error in ${file}: ${scriptErr.message}`);
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// --- icons -------------------------------------------------------------------
for (const [size, file] of Object.entries(manifest.icons || {})) mustExist(file, `icons.${size}`);
for (const [size, file] of Object.entries((manifest.action && manifest.action.default_icon) || {})) {
  mustExist(file, `action.default_icon.${size}`);
}

// --- entry points ------------------------------------------------------------
if (manifest.background && manifest.background.service_worker) {
  mustExist(manifest.background.service_worker, 'background.service_worker');
  mustParse(manifest.background.service_worker);
}
for (const key of ['options_page']) {
  if (manifest[key]) mustExist(manifest[key], key);
}
if (manifest.action && manifest.action.default_popup) mustExist(manifest.action.default_popup, 'action.default_popup');

// --- content scripts ---------------------------------------------------------
for (const cs of manifest.content_scripts || []) {
  for (const js of cs.js || []) { mustExist(js, 'content_scripts'); mustParse(js); }
  for (const css of cs.css || []) mustExist(css, 'content_scripts css');
}

// --- follow ES module imports from the worker --------------------------------
function followImports(file, seen = new Set()) {
  const full = path.join(ROOT, file);
  if (seen.has(full) || !fs.existsSync(full)) return;
  seen.add(full);
  const src = fs.readFileSync(full, 'utf8');
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/gm)) {
    const target = path.normalize(path.join(path.dirname(full), m[1]));
    if (!fs.existsSync(target)) { problems.push(`${file} imports missing ${m[1]}`); continue; }
    mustParse(rel(target));
    followImports(rel(target), seen);
  }
}
if (manifest.background && manifest.background.service_worker) followImports(manifest.background.service_worker);

// --- HTML pages reference real assets ----------------------------------------
for (const page of [manifest.options_page, manifest.action && manifest.action.default_popup].filter(Boolean)) {
  const full = path.join(ROOT, page);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(href)) continue;
    const target = path.normalize(path.join(path.dirname(full), href));
    if (!fs.existsSync(target)) problems.push(`${page} references missing ${href}`);
    else if (href.endsWith('.js')) mustParse(rel(target));
  }
}

// --- OAuth placeholder reminder ----------------------------------------------
const notes = [];
const clientId = manifest.oauth2 && manifest.oauth2.client_id;
if (!clientId || /REPLACE_WITH/.test(clientId)) {
  notes.push('manifest.oauth2.client_id is still the placeholder — set it, or use "Browser redirect" sign-in in Options.');
}

// --- report ------------------------------------------------------------------
if (problems.length) {
  console.error('FAIL\n' + problems.map((p) => '  · ' + p).join('\n'));
  process.exit(1);
}
console.log(`OK — ${checked.size} scripts parsed, all manifest references resolve.`);
notes.forEach((n) => console.log('note: ' + n));
