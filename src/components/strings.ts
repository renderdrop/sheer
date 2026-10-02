/**
 * Text the components generate themselves. Everything else (labels, tooltips) is passed in by the caller.
 * Until the i18n scaffold lands (ROADMAP Phase 3) these are the English defaults; callers may override each one.
 */
export const componentStrings = {
  /** Accessible name of the toolbar overflow button. */
  more: 'More',
  /** `aria-description` of a locked tool. */
  locked: 'Locked',
  /** Tooltip note of a locked tool (DESIGN 3.3). */
  lockedNote: 'Locked · Esc to release',
  /** `aria-valuetext` of a collapsed splitter. */
  collapsed: 'Collapsed',
  /** `aria-valuetext` of an expanded splitter, in pixels. */
  splitterValue: (pixels: number) => `${pixels} pixels`,
} as const;
