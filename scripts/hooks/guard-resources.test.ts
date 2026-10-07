// Rule 17 / ADR-136: guard-resources blocks build and test commands while RAM or disk is short; guard-bash blocks foreground waits
// longer than 2 minutes. Runs the real wrappers (bash → node / bash) with hook JSON on stdin, as Claude Code does; exit 2 = blocked.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');

function run(hook: string, tool_input: Record<string, unknown>, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(repo, '.claude', 'hooks', hook)], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input, cwd: repo }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr };
}

const plenty = { SHEER_FREE_RAM_GB: '32', SHEER_FREE_DISK_GB: '400' };

describe('guard-resources hook (rule 17)', () => {
  it('blocks builds and tests below 8 GB free RAM or 40 GB free disk', () => {
    const lowRam = run('guard-resources.sh', { command: 'npm run check' }, { ...plenty, SHEER_FREE_RAM_GB: '6' });
    expect(lowRam.status).toBe(2);
    expect(lowRam.stderr).toContain('guard-resources');
    expect(
      run('guard-resources.sh', { command: 'cargo test --lib' }, { ...plenty, SHEER_FREE_DISK_GB: '20' }).status,
    ).toBe(2);
    expect(
      run(
        'guard-resources.sh',
        { command: 'cd src-tauri && cargo +stable clippy' },
        { ...plenty, SHEER_FREE_RAM_GB: '1' },
      ).status,
    ).toBe(2);
    expect(
      run('guard-resources.sh', { command: 'npx vitest run src/x.test.ts' }, { ...plenty, SHEER_FREE_DISK_GB: '5' })
        .status,
    ).toBe(2);
    expect(
      run('guard-resources.sh', { command: 'npm run build:acceptance' }, { ...plenty, SHEER_FREE_RAM_GB: '7.5' })
        .status,
    ).toBe(2);
  });

  it('allows builds with enough resources, and non-build commands and space-freeing commands always', () => {
    expect(run('guard-resources.sh', { command: 'npm run check:fast' }, plenty).status).toBe(0);
    const starved = { SHEER_FREE_RAM_GB: '1', SHEER_FREE_DISK_GB: '1' };
    expect(run('guard-resources.sh', { command: 'git status && ls review' }, starved).status).toBe(0);
    expect(run('guard-resources.sh', { command: 'cargo sweep --maxsize 60GB src-tauri' }, starved).status).toBe(0);
    expect(
      run('guard-resources.sh', { command: 'cargo clean --manifest-path src-tauri/Cargo.toml' }, starved).status,
    ).toBe(0);
    expect(run('guard-resources.sh', { command: 'npm run accept:clean' }, starved).status).toBe(0);
  });
});

describe('guard-bash foreground waits (rule 17)', () => {
  it('blocks a sleep or a sleep loop longer than 2 minutes in the foreground', () => {
    expect(run('guard-bash.sh', { command: 'sleep 300' }).status).toBe(2);
    expect(run('guard-bash.sh', { command: 'for i in $(seq 1 110); do sleep 5; done; echo waited' }).status).toBe(2);
    expect(run('guard-bash.sh', { command: 'for i in {1..30}; do sleep 10; done' }).status).toBe(2);
  });

  it('allows short waits and any wait that runs in the background', () => {
    expect(run('guard-bash.sh', { command: 'sleep 20 && gh run list' }).status).toBe(0);
    expect(run('guard-bash.sh', { command: 'for i in $(seq 1 20); do curl -s x && break; sleep 5; done' }).status).toBe(
      0,
    );
    expect(
      run('guard-bash.sh', { command: 'for i in $(seq 1 110); do sleep 5; done', run_in_background: true }).status,
    ).toBe(0);
  });
});
