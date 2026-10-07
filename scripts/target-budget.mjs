// `npm run target:budget` (rule 17, ADR-136): keeps the cargo build folders inside their budget with cargo-sweep (oldest artifacts
// first), so builds stay warm instead of starting cold after `cargo clean`. src-tauri/target ≤ 60 GB, src-tauri/target-acceptance
// ≤ 15 GB. Local only; a no-op with a hint when cargo-sweep is not installed in .tools/ (`npm run tools:install`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './build-env.mjs';
import { exitCodeOf } from './exit-code.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sweep = ['cargo-sweep.exe', 'cargo-sweep']
  .map((name) => join(ROOT, '.tools', 'bin', name))
  .find((p) => existsSync(p));
if (!sweep) {
  console.log('target budget: cargo-sweep is not installed (npm run tools:install); skipped');
  process.exit(0);
}

const project = join(ROOT, 'src-tauri');
const budgets = [
  { dir: join(project, 'target'), max: '60GB' },
  { dir: join(project, 'target-acceptance'), max: '15GB' },
];
let rc = 0;
for (const { dir, max } of budgets) {
  if (!existsSync(dir)) continue;
  // cargo-sweep finds the target folder through `cargo metadata`, which honours CARGO_TARGET_DIR.
  const env = { ...buildEnv(), CARGO_TARGET_DIR: dir };
  const run = spawnSync(sweep, ['sweep', '--maxsize', max, project], { env, encoding: 'utf8' });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-2).join(' | ');
  console.log(
    `target budget: ${dir.slice(ROOT.length)} ≤ ${max}: ${exitCodeOf(run) === 0 ? 'ok' : 'failed'}${out ? ` (${out})` : ''}`,
  );
  if (exitCodeOf(run) !== 0) rc = 1;
}
process.exit(rc);
