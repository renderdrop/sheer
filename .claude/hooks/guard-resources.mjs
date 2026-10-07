// PreToolUse guard (rule 17, ADR-136): build and test commands are blocked while the machine is short of memory or disk, so a third
// parallel build cannot take the session down (2026-10-07: src-tauri/target at 228 GB, disk full, session lost).
// Input: the hook JSON on stdin. Exit 2 = blocked (stderr is the reason). Measurement failures never block.
// Thresholds: SHEER_MIN_FREE_RAM_GB (8), SHEER_MIN_FREE_DISK_GB (40). Tests inject readings with SHEER_FREE_RAM_GB / SHEER_FREE_DISK_GB.
import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import os from 'node:os';

/** Commands that compile or run test suites. `cargo clean` / `cargo sweep` free space and stay allowed. */
const BUILD =
  /(^|[\s;&|(`])(cargo(\s+\+\S+)?\s+(build|b|test|t|clippy|run|r|check|c|bench|doc|install|tauri)\b|npm\s+(test\b|run\s+(check|check:fast|build|build:acceptance|tauri|test|fixtures:scans|bench|dev)\b)|npx\s+(--no-install\s+)?(vitest|tauri|vite\s+build)\b|vitest\b|bash\s+scripts\/check(-fast)?\.sh|node\s+scripts\/(build-acceptance|ui\/dev)\.mjs)/;

const GB = 1024 ** 3;

function freeRamGb() {
  if (process.env.SHEER_FREE_RAM_GB) return Number(process.env.SHEER_FREE_RAM_GB);
  if (process.platform !== 'darwin') return os.freemem() / GB;
  // macOS counts reclaimable cache as used in os.freemem(); vm_stat's free + inactive + speculative pages is what can be had.
  const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
  const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 4096);
  const pages = (name) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  return ((pages('free') + pages('inactive') + pages('speculative')) * page) / GB;
}

function freeDiskGb(dir) {
  if (process.env.SHEER_FREE_DISK_GB) return Number(process.env.SHEER_FREE_DISK_GB);
  const s = statfsSync(dir);
  return (Number(s.bavail) * Number(s.bsize)) / GB;
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}
const command = String(input?.tool_input?.command ?? '');
if (!BUILD.test(command)) process.exit(0);

const minRam = Number(process.env.SHEER_MIN_FREE_RAM_GB ?? 8);
const minDisk = Number(process.env.SHEER_MIN_FREE_DISK_GB ?? 40);
const problems = [];
try {
  const ram = freeRamGb();
  if (Number.isFinite(ram) && ram < minRam) problems.push(`${ram.toFixed(1)} GB RAM free (needs ${minRam})`);
} catch {
  // Unknown memory: do not block.
}
try {
  const disk = freeDiskGb(process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd());
  if (Number.isFinite(disk) && disk < minDisk) problems.push(`${disk.toFixed(0)} GB disk free (needs ${minDisk})`);
} catch {
  // Unknown disk: do not block.
}
if (problems.length > 0) {
  process.stderr.write(
    `BLOCKED by guard-resources (rule 17, ADR-136): ${problems.join(', ')}. Wait for running builds to finish, ` +
      'or free space with `npm run target:budget` (cargo sweep) and `npm run accept:clean`; then retry.\n',
  );
  process.exit(2);
}
process.exit(0);
