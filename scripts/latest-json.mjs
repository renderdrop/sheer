// Writes latest.json for the updater (ADR-053 section 3) from the signed packages in a directory.
//   node scripts/latest-json.mjs <artifact-dir> <version>
// Needs `<file>.sig` beside each `*-setup.exe` and `*.app.tar.gz`. URLs are fixed to the GitHub release's download path.
import fs from 'node:fs';
import path from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !version || !/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/latest-json.mjs <artifact-dir> <semver version>');
  process.exit(2);
}
const base = `https://github.com/renderdrop/sheer/releases/download/v${version}/`;
const platforms = {};
const entry = (name) => ({
  signature: fs.readFileSync(path.join(dir, `${name}.sig`), 'utf8').trim(),
  url: base + encodeURIComponent(name),
});
for (const name of fs.readdirSync(dir)) {
  if (name.endsWith('-setup.exe') && fs.existsSync(path.join(dir, `${name}.sig`))) {
    platforms['windows-x86_64'] = entry(name);
  } else if (name.endsWith('.app.tar.gz') && fs.existsSync(path.join(dir, `${name}.sig`))) {
    platforms['darwin-aarch64'] = entry(name);
    platforms['darwin-x86_64'] = entry(name);
  }
}
if (Object.keys(platforms).length === 0) {
  console.error('error: no signed package found');
  process.exit(1);
}
const manifest = { version, notes: `Sheer ${version}`, pub_date: new Date().toISOString(), platforms };
fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
