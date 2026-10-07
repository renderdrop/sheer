// `npm run build:acceptance` (ADR-131): the acceptance build, which answers every native dialog from a queue. Same as
// `tauri build --no-bundle --config src-tauri/tauri.acceptance.conf.json --features automation` with its own target directory, so it
// never overwrites (or is mistaken for) a release build. A script because npm scripts cannot set an environment variable on
// both Windows and macOS without a dependency.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './build-env.mjs';

// Rule 17: trim the build folders to their budget first (cargo-sweep, keeps them warm).
spawnSync(process.execPath, [fileURLToPath(new URL('./target-budget.mjs', import.meta.url))], { stdio: 'inherit' });

// Absolute: cargo runs inside src-tauri, where a relative path would land in src-tauri/src-tauri.
const target = fileURLToPath(new URL('../src-tauri/target-acceptance', import.meta.url));
// Six jobs, below-normal priority, sccache (rule 17, ADR-136).
const env = { ...buildEnv(), CARGO_TARGET_DIR: target };
const args = [
  'tauri',
  'build',
  '--no-bundle',
  '--config',
  'src-tauri/tauri.acceptance.conf.json',
  '--features',
  'automation',
];
const run = spawnSync('npx', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(run.status ?? 1);
