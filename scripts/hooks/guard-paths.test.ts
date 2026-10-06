// ADR-127: the guard-paths PreToolUse hook blocks writes outside the repo and the Claude temp folder, and reads outside the repo.
// Runs the real wrapper (bash → node) with hook JSON on stdin, as Claude Code does; exit 2 = blocked.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const hook = join(repo, '.claude', 'hooks', 'guard-paths.sh');
const outside = process.platform === 'win32' ? 'C:\\Users\\Someone\\Desktop' : '/Users/someone/Desktop';

function run(tool_name: string, tool_input: Record<string, string>) {
  const r = spawnSync('bash', [hook], {
    input: JSON.stringify({ tool_name, tool_input, cwd: repo }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr };
}

describe('guard-paths hook (ADR-127)', () => {
  it('blocks rm -rf on a folder outside the repo', () => {
    const r = run('Bash', { command: `rm -rf "${outside}/autosave"` });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('guard-paths');
  });

  it('blocks a redirect into a file outside the repo', () => {
    expect(run('Bash', { command: `echo hi > "${outside}/notes.txt"` }).status).toBe(2);
  });

  it('blocks Write and Remove-Item outside the repo, and reads outside review/owner', () => {
    expect(run('Write', { file_path: join(outside, 'x.txt'), content: 'x' }).status).toBe(2);
    expect(run('PowerShell', { command: `Remove-Item -Recurse -Force '${outside}\\old'` }).status).toBe(2);
    expect(run('Bash', { command: `ls "${outside}"` }).status).toBe(2);
    expect(run('Bash', { command: 'mv review/a.png ../elsewhere.png' }).status).toBe(2);
  });

  it('treats a sed script as a script, but still checks the file sed edits', () => {
    expect(run('Bash', { command: "sed -i '/^ci_log:/a \\  - x' STATE.md" }).status).toBe(0);
    expect(run('Bash', { command: "sed -i 's/a/b/' /Users/someone/notes.txt" }).status).toBe(2);
  });

  it('allows work inside the repo, review/owner, the Claude temp folder and /dev/null', () => {
    expect(
      run('Bash', { command: 'rm -f review/x.png && cat review/owner/corpus/a.pdf > /dev/null 2>&1' }).status,
    ).toBe(0);
    expect(run('Write', { file_path: join(repo, 'docs', 'x.md'), content: 'x' }).status).toBe(0);
    expect(run('Write', { file_path: join(tmpdir(), 'claude', 'scratch', 'x.txt'), content: 'x' }).status).toBe(0);
    expect(
      run('Bash', { command: "cat >> docs/x.md <<'EOF'\nsee C:\\Users\\Someone\\Desktop\nEOF\ngit status" }).status,
    ).toBe(0);
  });
});
