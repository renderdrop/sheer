/**
 * Which pages an export or a print takes (ARCHITECTURE section 5, "Convert and output"; `model::ranges::PageSelection` in Rust).
 * Shared by `exportImages.ts` and `print.ts`.
 */
export type PageSelection =
  | { type: 'all' }
  | { type: 'current'; pageId: number }
  | { type: 'pages'; pages: number[] }
  /** Text like "1-3, 5, 8-", positions in the current order; Rust parses and validates it. */
  | { type: 'ranges'; text: string };
