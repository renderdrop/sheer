// ADR-139 (P0b): a failing exit code is never hidden by a pipe in the check tooling.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without type declarations
import { exitCodeOf } from '../exit-code.mjs';

const repo = resolve(__dirname, '..', '..');
const bash = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: repo });
const toBashPath = (p: string) => `'${p.split(sep).join('/')}'`;

describe('check.sh step runner', () => {
  const harness = (stepCommand: string) =>
    bash(
      `export SHEER_CHECK_SOURCE_ONLY=1 SHEER_CHECK_PART=web; source ${toBashPath(join(repo, 'scripts', 'check.sh'))}; ` +
        `failing() { false | cat; }; passing() { true | cat; }; ${stepCommand}; ` +
        `echo "FAILED=\${#FAILED[@]}"; rm -rf "$LOG_DIR"`,
    );

  it('records a step whose command fails inside a pipeline as failed', () => {
    const r = harness('step "fake" failing');
    expect(r.stdout).toContain('FAIL  fake');
    expect(r.stdout).toContain('FAILED=1');
  });

  it('keeps a passing pipeline green', () => {
    const r = harness('step "fake" passing');
    expect(r.stdout).toContain('ok    fake');
    expect(r.stdout).toContain('FAILED=0');
  });
});

describe('scripts/*.sh', () => {
  const scripts = readdirSync(join(repo, 'scripts')).filter((f) => f.endsWith('.sh'));
  it.each(scripts)('%s sets pipefail', (file) => {
    expect(readFileSync(join(repo, 'scripts', file), 'utf8')).toMatch(/pipefail/);
  });
});

describe('guard-bash hook, check pipes', () => {
  const guard = (command: string) =>
    spawnSync('bash', [join(repo, '.claude', 'hooks', 'guard-bash.sh')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      encoding: 'utf8',
    });

  it('blocks a check piped into another command', () => {
    for (const c of [
      'npm run check 2>&1 | tail -2',
      'npm run check:fast | grep FAIL',
      'bash scripts/check.sh | tail',
    ]) {
      const r = guard(c);
      expect(r.status, c).toBe(2);
      expect(r.stderr).toContain('pipefail');
    }
  });

  it('allows pipefail, redirection to a file and unrelated pipes', () => {
    for (const c of [
      'set -o pipefail; npm run check 2>&1 | tail -2',
      'npm run check > review/check.log 2>&1',
      'npm run check || echo failed',
      'ls | head',
      // A pipe in another segment of the same line does not touch the check's exit code.
      'git status --short | wc -l; npm run check > review/check.log 2>&1; tail -1 review/check.log',
      'npm run check > review/check.log 2>&1 && grep -c ok review/check.log | head -1',
    ]) {
      expect(guard(c).status, c).toBe(0);
    }
  });
});

describe('exitCodeOf', () => {
  it('passes the child exit code on and never turns a failure into 0', () => {
    expect(exitCodeOf({ status: 0 })).toBe(0);
    expect(exitCodeOf({ status: 3 })).toBe(3);
    expect(exitCodeOf({ status: null, signal: 'SIGTERM' })).toBeGreaterThan(0);
    expect(exitCodeOf({ status: null, signal: null, error: new Error('spawn') })).toBe(1);
  });

  it('matches a real failing child', () => {
    const run = spawnSync(process.execPath, ['-e', 'process.exit(7)']);
    expect(exitCodeOf(run)).toBe(7);
  });
});
