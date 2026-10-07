import { TIPS_SEEN_MAX } from '../../api/app';
import type { ToolId } from '../../stores/ui';

/** The tools that have a first-use tip (DESIGN 3.47), by the id stored in the setting `tipsSeen`.
 * The four clip tips have their own ids (ADR-139); the v1.7 text-tip ids `highlight`, `sign`, `pages`, `form` stay in old
 * settings and are ignored. */
export const TIP_IDS = [
  'highlightClip',
  'cite',
  'note',
  'text',
  'draw',
  'shapes',
  'signClip',
  'pagesClip',
  'formClip',
  'insertText',
  'crop',
  'redact',
  'editText',
  'smartlinks',
] as const;
export type TipId = (typeof TIP_IDS)[number];

/** The four situations that show a clip with the text (DESIGN 3.13 C1); every other tip is text only. */
export const CLIP_TIPS = ['highlightClip', 'formClip', 'signClip', 'pagesClip'] as const satisfies readonly TipId[];
export type ClipTipId = (typeof CLIP_TIPS)[number];

export function isClipTip(id: TipId): id is ClipTipId {
  return (CLIP_TIPS as readonly string[]).includes(id);
}

/** At most this many tips show in one session (DESIGN 3.6); "Show tips again" does not lift it. */
export const MAX_TIPS_PER_SESSION = 3;

/** The tool-row items a tip may point at, best first: the slot ids of the F15 tool row (they differ from the tip ids). */
export function toolbarItemsOf(id: TipId): readonly string[] {
  switch (id) {
    case 'signClip':
      return ['signature'];
    case 'insertText':
      return ['textBox'];
    case 'text':
      return ['freeText'];
    case 'smartlinks':
      return ['smartLinks'];
    case 'pagesClip':
      return ['organize'];
    case 'highlightClip':
      return ['highlight', 'underline', 'strikeout'];
    default:
      return [id];
  }
}

/** The first tool-row item a tip points at. */
export function toolbarItemOf(id: TipId): string {
  return toolbarItemsOf(id)[0] ?? id;
}

/** The tip of a tool that has one (the Markup and Shapes variants share their family's tip). */
export function tipOfTool(tool: ToolId): TipId | null {
  switch (tool) {
    case 'highlight':
      return 'highlightClip';
    case 'pages':
      return 'pagesClip';
    case 'cite':
    case 'note':
    case 'text':
    case 'draw':
    case 'shapes':
    case 'crop':
      return tool;
    case 'signature':
      return 'signClip';
    case 'textBox':
      return 'insertText';
    case 'editText':
      return 'editText';
    default:
      return null;
  }
}

/** The tip that turning the tools and modes to these values asks for: the active tool's, else Redact mode's. */
export function tipFor(state: { activeTool: ToolId; redactMode: boolean }): TipId | null {
  return tipOfTool(state.activeTool) ?? (state.redactMode ? 'redact' : null);
}

export interface TipContext {
  /** The settings have been read (before that nothing is known to be unseen). */
  loaded: boolean;
  seen: readonly string[];
  /** Ids already shown in this session, whether or not the setting could be written. */
  session: ReadonlySet<string>;
  tourRunning: boolean;
  /** A tip is visible already. */
  tipVisible: boolean;
  /** Tips shown so far in this session. */
  shownCount?: number;
  /** The `tipsEnabled` setting (DESIGN 3.13 C5); missing means on. */
  enabled?: boolean;
}

/** Whether the tip may show now: unseen, no tour, nothing else visible (DESIGN 3.47 Trigger). */
export function mayShow(id: TipId, context: TipContext): boolean {
  return (
    context.loaded &&
    context.enabled !== false &&
    !context.tourRunning &&
    !context.tipVisible &&
    (context.shownCount ?? 0) < MAX_TIPS_PER_SESSION &&
    !context.seen.includes(id) &&
    !context.session.has(id)
  );
}

/** `seen` with `id` added; beyond `TIPS_SEEN_MAX` the oldest go. */
export function withSeen(seen: readonly string[], id: string): string[] {
  return [...seen.filter((known) => known !== id), id].slice(-TIPS_SEEN_MAX);
}
