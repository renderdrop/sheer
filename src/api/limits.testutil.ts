import { readFileSync } from 'node:fs';

/**
 * The numeric constants of src-tauri/src/limits.rs, by name (`pub const NAME: <number type> = <product of numbers and names>;`),
 * for the tests that tie a mirror in the frontend to the backend's value.
 */
export function rustConstants(): Map<string, number> {
  const source = readFileSync(new URL('../../src-tauri/src/limits.rs', import.meta.url), 'utf8');
  const found = new Map<string, number>();
  for (const [, name, expression] of source.matchAll(/^pub const (\w+): (?:u32|u64|i16|f32|f64|usize) = ([^;]+);/gm)) {
    if (name === undefined || expression === undefined) continue;
    const value = expression
      .split('*')
      .map((factor) => factor.trim())
      .map((factor) => (/^-?[\d_.]+$/.test(factor) ? Number(factor.replaceAll('_', '')) : found.get(factor)))
      .reduce<number | undefined>(
        (product, factor) => (product === undefined || factor === undefined ? undefined : product * factor),
        1,
      );
    if (value !== undefined) found.set(name, value);
  }
  return found;
}
