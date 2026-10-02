/** Joins class names, skipping falsy parts. Tailwind classes are static strings in the source so the compiler finds them. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
