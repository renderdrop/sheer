// Rule 17 / ADR-136: the build environment for node scripts that start cargo (build:acceptance, dev window). Same as
// scripts/build-env.sh: ~/.cargo/bin on PATH, at most six rustc jobs, and locally (not in CI) below-normal priority for this process
// (on Windows its children inherit the class) plus the repo-local sccache in .tools/ when it is installed.
import { existsSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The environment for a cargo child process; also lowers this process's priority (local runs only). */
export function buildEnv(base = process.env) {
  // Windows spells it `Path`; a second `PATH` key would make the child's lookup ambiguous.
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const env = {
    ...base,
    [pathKey]: [join(os.homedir(), '.cargo', 'bin'), base[pathKey] ?? ''].join(delimiter),
    CARGO_BUILD_JOBS: base.CARGO_BUILD_JOBS ?? '6',
  };
  if (base.CI) return env;
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not allowed or not supported: build at normal priority.
  }
  const sccache = ['sccache.exe', 'sccache']
    .map((name) => join(ROOT, '.tools', 'bin', name))
    .find((p) => existsSync(p));
  if (sccache && !base.RUSTC_WRAPPER) {
    env.RUSTC_WRAPPER = sccache;
    env.SCCACHE_DIR = join(ROOT, '.tools', 'sccache');
    env.SCCACHE_CACHE_SIZE = base.SCCACHE_CACHE_SIZE ?? '20G';
  }
  return env;
}
