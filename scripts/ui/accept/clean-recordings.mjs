// `npm run accept:clean` (rule 17, ADR-136): after each acceptance (once the designer round has read them) the screenshots and
// recordings under review/ are deleted. review/owner/ (the owner corpus) is never touched; PDFs and other files stay.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REVIEW = join(ROOT, 'review');
const OWNER = join(REVIEW, 'owner');
const RECORDING = /\.(png|jpe?g|webp|gif|apng|bmp|mp4|webm|mov|avi|mkv)$/i;

let files = 0;
let bytes = 0;
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (path === OWNER) continue;
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && RECORDING.test(entry.name)) {
      bytes += statSync(path).size;
      rmSync(path);
      files += 1;
    }
  }
}
walk(REVIEW);
console.log(
  `accept:clean: ${files} recordings deleted under ${relative(ROOT, REVIEW) || 'review'}/ (${(bytes / 1024 ** 2).toFixed(1)} MB); review/owner/ untouched`,
);
