import { TIPS_SEEN_MAX } from '../../api/app';
import type { ToolId } from '../../stores/ui';

/** The tools that have a first-use tip (DESIGN 3.47), by the id stored in the setting `tipsSeen`. */
export const TIP_IDS = [
  'highlight',
  'note',
  'text',
  'draw',
  'shapes',
  'sign',
  'pages',
  'insertText',
  'crop',
  'redact',
] as const;
export type TipId = (typeof TIP_IDS)[number];

/** The toolbar item a tip points at (the tool's id there), where it differs from the tip id. */
export function toolbarItemOf(id: TipId): string {
  switch (id) {
    case 'sign':
      return 'signature';
    case 'insertText':
      return 'textBox';
    default:
      return id;
  }
}

/** The tip of a tool that has one (the Markup and Shapes variants share their family's tip). */
export function tipOfTool(tool: ToolId): TipId | null {
  switch (tool) {
    case 'highlight':
    case 'note':
    case 'text':
    case 'draw':
    case 'shapes':
    case 'pages':
    case 'crop':
      return tool;
    case 'signature':
      return 'sign';
    case 'textBox':
      return 'insertText';
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
}

/** Whether the tip may show now: unseen, no tour, nothing else visible (DESIGN 3.47 Trigger). */
export function mayShow(id: TipId, context: TipContext): boolean {
  return (
    context.loaded &&
    !context.tourRunning &&
    !context.tipVisible &&
    !context.seen.includes(id) &&
    !context.session.has(id)
  );
}

/** `seen` with `id` added; beyond `TIPS_SEEN_MAX` the oldest go. */
export function withSeen(seen: readonly string[], id: string): string[] {
  return [...seen.filter((known) => known !== id), id].slice(-TIPS_SEEN_MAX);
}
