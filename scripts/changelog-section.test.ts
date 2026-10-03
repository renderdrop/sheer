import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'sheer-changelog-'));
const file = join(dir, 'CHANGELOG.md');
writeFileSync(
  file,
  '# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-11-01\n\nFive.\n\n### Added\n\n- x\n\n## [0.4.0] - 2026-10-03\n\nFour.\n',
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(arg: string, changelog = file) {
  const r = spawnSync('bash', ['scripts/changelog-section.sh', arg], {
    encoding: 'utf8',
    env: { ...process.env, CHANGELOG_FILE: changelog },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('scripts/changelog-section.sh', () => {
  it('prints one section up to the next heading', () => {
    const r = run('0.5.0');
    expect(r.code).toBe(0);
    expect(r.out).toContain('## [0.5.0] - 2026-11-01');
    expect(r.out).toContain('- x');
    expect(r.out).not.toContain('0.4.0');
  });

  it('accepts a leading v and prints the last section', () => {
    const r = run('v0.4.0');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Four.');
  });

  it('fails for a missing version', () => {
    expect(run('9.9.9').code).toBe(1);
  });

  it('rejects malformed input', () => {
    expect(run('abc').code).toBe(2);
  });

  it('reads the real changelog', () => {
    const r = run('0.4.0', join(process.cwd(), 'CHANGELOG.md'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('M1');
  });
});
