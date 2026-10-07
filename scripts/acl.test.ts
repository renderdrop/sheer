import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** ACL consistency: handler registered in lib.rs <-> declared in build.rs <-> granted in capabilities (ADR-137). */

export interface Handler {
  name: string;
  /** True when the handler sits behind `#[cfg(feature = "automation")]` (granted by the inline capability, not the JSON). */
  automation: boolean;
}

function stripRustComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

export function parseHandlers(libRs: string): Handler[] {
  const src = stripRustComments(libRs);
  const start = src.indexOf('generate_handler![');
  if (start < 0) throw new Error('generate_handler! not found');
  const body = src.slice(start + 'generate_handler!['.length);
  let depth = 0;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    }
  }
  if (end < 0) throw new Error('generate_handler! list not closed');
  const out: Handler[] = [];
  for (const raw of body.slice(0, end).split(',')) {
    const attrs = [...raw.matchAll(/#\[([^\]]*(?:\([^)]*\))?[^\]]*)\]/g)].map((m) => m[1] ?? '');
    const path = raw.replace(/#\[[^\]]*\]/g, '').trim();
    if (!path) continue;
    const name = path.split('::').pop()?.trim() ?? '';
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unparsable handler entry: ${path}`);
    out.push({ name, automation: attrs.some((a) => a.includes('cfg') && a.includes('automation')) });
  }
  return out;
}

export interface Declared {
  base: string[];
  automation: string[];
}

export function parseDeclared(buildRs: string): Declared {
  const src = stripRustComments(buildRs);
  const vec = /let mut commands = vec!\[([\s\S]*?)\];/.exec(src);
  if (!vec) throw new Error('commands vec! not found in build.rs');
  const strings = (s: string): string[] => [...s.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] ?? '');
  const ext = [...src.matchAll(/commands\.extend\(\[([\s\S]*?)\]\)/g)].flatMap((m) => strings(m[1] ?? ''));
  return { base: strings(vec[1] ?? ''), automation: ext };
}

export function parseGranted(capabilityJson: string): string[] {
  const parsed = JSON.parse(capabilityJson) as { permissions?: unknown[] };
  return (parsed.permissions ?? [])
    .filter((p): p is string => typeof p === 'string' && p.startsWith('allow-'))
    .map((p) => p.slice('allow-'.length).replace(/-/g, '_'));
}

function diff(a: Iterable<string>, b: Iterable<string>): string[] {
  const set = new Set(b);
  return [...a].filter((x) => !set.has(x)).sort();
}

describe('parsers (fixtures)', () => {
  it('parses handlers with module paths and cfg attributes', () => {
    const lib = `
      .invoke_handler(tauri::generate_handler![
        commands::a_one, // note
        commands::sub::b_two,
        #[cfg(feature = "automation")]
        automation::commands::c_three,
        /* x */ d_four,
      ])
      .build(x[1])`;
    expect(parseHandlers(lib)).toEqual([
      { name: 'a_one', automation: false },
      { name: 'b_two', automation: false },
      { name: 'c_three', automation: true },
      { name: 'd_four', automation: false },
    ]);
  });
  it('parses build.rs lists', () => {
    const b = `let mut commands = vec![\n "a_one",\n "b_two",\n];\nif x { commands.extend(["c_three", "e_five"]); }`;
    expect(parseDeclared(b)).toEqual({ base: ['a_one', 'b_two'], automation: ['c_three', 'e_five'] });
  });
  it('parses grants, ignoring core permissions', () => {
    const j = JSON.stringify({ permissions: ['allow-a-one', 'core:window:allow-close', 'allow-b-two'] });
    expect(parseGranted(j)).toEqual(['a_one', 'b_two']);
  });
});

describe('IPC command ACL', () => {
  const root = join(__dirname, '..', 'src-tauri');
  const handlers = parseHandlers(readFileSync(join(root, 'src', 'lib.rs'), 'utf8'));
  const declared = parseDeclared(readFileSync(join(root, 'build.rs'), 'utf8'));
  const capDir = join(root, 'capabilities');
  const granted = readdirSync(capDir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => parseGranted(readFileSync(join(capDir, f), 'utf8')));

  const baseHandlers = handlers.filter((h) => !h.automation).map((h) => h.name);
  const autoHandlers = handlers.filter((h) => h.automation).map((h) => h.name);

  it('registers a sane number of handlers', () => {
    expect(handlers.length).toBeGreaterThan(50);
    expect(new Set(handlers.map((h) => h.name)).size).toBe(handlers.length);
  });
  it('every handler is declared in build.rs', () => {
    expect(diff(baseHandlers, declared.base)).toEqual([]);
    expect(diff(autoHandlers, declared.automation)).toEqual([]);
  });
  it('every declared command is registered', () => {
    expect(diff(declared.base, baseHandlers)).toEqual([]);
    expect(diff(declared.automation, autoHandlers)).toEqual([]);
  });
  it('every handler is granted in capabilities', () => {
    expect(diff(baseHandlers, granted)).toEqual([]);
  });
  it('every grant names a registered command', () => {
    expect(diff(granted, baseHandlers)).toEqual([]);
  });
});
