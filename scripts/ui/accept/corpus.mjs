// The owner's private test corpus (review/owner/, git-ignored; ADR-133). Scripts name files by ID (`owner-pdf-E4`, `corpus-07`) and
// personal probe text by key (`corpus-05/address-line`); the only mapping is the untracked review/owner/INDEX.md
// (tables `| ID | file |` and `| key | text |`). When the index or an entry is missing the script prints why and exits 0 (skip).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../review/owner');

/** Table rows of INDEX.md as a Map first column -> second column (header and separator rows dropped). */
export function parseIndex(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\||\|\s*$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2 || /^-+$/.test(cells[0]) || cells[0] === 'ID' || cells[0] === 'Key') continue;
    rows.set(cells[0], cells[1]);
  }
  return rows;
}

function loadIndex() {
  const file = join(OWNER, 'INDEX.md');
  return existsSync(file) ? parseIndex(readFileSync(file, 'utf8')) : null;
}

function skip(why) {
  console.log(`SKIPPED: ${why} (ADR-133: the owner corpus is private and untracked)`);
  process.exit(0);
}

/** Repo-relative path of a corpus file by ID; skips the whole script when it cannot be resolved. */
export function corpusFile(id) {
  const index = loadIndex();
  if (!index) skip('review/owner/INDEX.md is missing');
  const name = index.get(id);
  if (!name) skip(`${id} is not listed in review/owner/INDEX.md`);
  if (!existsSync(join(OWNER, 'corpus', name))) skip(`the file of ${id} is not in review/owner/corpus`);
  return `review/owner/corpus/${name}`;
}

/** Probe text by key (e.g. `corpus-05/address-line`); skips the whole script when it is not listed. */
export function corpusProbe(key) {
  const index = loadIndex();
  if (!index) skip('review/owner/INDEX.md is missing');
  const text = index.get(key);
  if (text === undefined) skip(`probe ${key} is not listed in review/owner/INDEX.md`);
  return text;
}
