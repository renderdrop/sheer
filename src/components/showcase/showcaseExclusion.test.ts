import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isShowcaseLocation } from '../../App';

const src = fileURLToPath(new URL('../../', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'showcase' ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('dev-only component page', () => {
  it('is reached at /dev/components (and the old hash)', () => {
    expect(isShowcaseLocation({ pathname: '/dev/components', hash: '' })).toBe(true);
    expect(isShowcaseLocation({ pathname: '/dev/components/', hash: '' })).toBe(true);
    expect(isShowcaseLocation({ pathname: '/', hash: '#showcase' })).toBe(true);
    expect(isShowcaseLocation({ pathname: '/', hash: '' })).toBe(false);
  });

  it('is imported by production code only through the DEV-guarded lazy import in App.tsx', () => {
    const offenders: string[] = [];
    for (const file of files(src)) {
      const text = readFileSync(file, 'utf8');
      if (/showcase\//i.test(text) && !file.endsWith('App.tsx')) offenders.push(relative(src, file));
    }
    expect(offenders).toEqual([]);
    const app = readFileSync(join(src, 'App.tsx'), 'utf8');
    expect(app).toMatch(/import\.meta\.env\.DEV\s*\?\s*lazy\(\(\) => import\('\.\/components\/showcase\/Showcase'\)\)/);
    expect(app.match(/showcase\/Showcase/g)).toHaveLength(1);
  });
});
