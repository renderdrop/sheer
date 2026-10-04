/**
 * Path commands of vector signature art (ADR-051, src-tauri/src/signatures/vector.rs): `M` start, `L` line, `C` cubic Bézier
 * (two control points, then the end), `Z` close. Art space is 1 000 units high, y down, filled with the nonzero rule.
 */
export type PathCmd =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

/** Most paths (one per stroke or glyph) and most commands in all. */
export const MAX_PATHS = 64;
export const MAX_COMMANDS = 20_000;

const ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, C: 6, Z: 0 };

/** Validates one command; `null` if it is not one. */
export function parsePathCmd(value: unknown): PathCmd | null {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return null;
  const arity = ARITY[value[0]];
  if (arity === undefined || value.length !== arity + 1) return null;
  for (let i = 1; i <= arity; i += 1) {
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) return null;
  }
  return value.slice() as unknown as PathCmd;
}

/** Validates the paths of vector art (counts, shape of every command, each path starts with `M`); `null` if they are not. */
export function parsePaths(value: unknown): PathCmd[][] | null {
  if (!Array.isArray(value) || value.length > MAX_PATHS) return null;
  let total = 0;
  const paths: PathCmd[][] = [];
  for (const path of value as unknown[]) {
    if (!Array.isArray(path) || path.length === 0) return null;
    total += path.length;
    if (total > MAX_COMMANDS) return null;
    const commands: PathCmd[] = [];
    for (const item of path as unknown[]) {
      const command = parsePathCmd(item);
      if (command === null) return null;
      commands.push(command);
    }
    if (commands[0]?.[0] !== 'M') return null;
    paths.push(commands);
  }
  return paths;
}
