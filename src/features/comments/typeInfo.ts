import {
  Calendar,
  Check,
  Circle,
  Dot,
  Highlighter,
  Minus,
  MessageSquare,
  MessageSquareQuote,
  MoveUpRight,
  PenLine,
  Shapes,
  Signature,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  X,
  type LucideIcon,
} from 'lucide-react';

import type { AnnotationKind, AnnotationSummary } from '../../api/annotations';
import type { PlainKey } from '../../i18n';
import type { TypeGroup } from './model';

/** What an annotation is called and drawn as in the panel (DESIGN 3.59, "Type labels"): an icon and a word, never colour alone. */
export interface TypeInfo {
  key: PlainKey;
  icon: LucideIcon;
}

const KIND: Record<AnnotationKind, TypeInfo> = {
  highlight: { key: 'annot.type.highlight', icon: Highlighter },
  underline: { key: 'annot.type.underline', icon: Underline },
  strikeout: { key: 'annot.type.strikeout', icon: Strikethrough },
  note: { key: 'annot.type.note', icon: MessageSquare },
  freeText: { key: 'annot.type.freeText', icon: Type },
  ink: { key: 'annot.type.ink', icon: PenLine },
  rect: { key: 'annot.type.rect', icon: Square },
  ellipse: { key: 'annot.type.ellipse', icon: Circle },
  line: { key: 'annot.type.line', icon: Minus },
  signature: { key: 'annot.type.signature', icon: Signature },
  mark: { key: 'annot.type.mark', icon: Check },
  opaque: { key: 'annot.type.opaque', icon: StickyNote },
};

/** The type of a kind alone (the filter lists kinds). */
export const kindInfo = (kind: AnnotationKind): TypeInfo => KIND[kind];

/**
 * The type of an annotation: a highlight with text is a Comment, a mark is its glyph (check mark, cross, dot), signature or
 * initials, a line with an end an arrow. The detail comes from the Rust summary (ADR-057).
 */
export function typeOf(summary: Pick<AnnotationSummary, 'kind' | 'detail' | 'contents'>): TypeInfo {
  const { kind, detail } = summary;
  if (kind === 'highlight' && summary.contents.trim() !== '')
    return { key: 'annot.type.comment', icon: MessageSquareQuote };
  if (kind === 'mark') {
    if (detail === 'check') return { key: 'annot.type.check', icon: Check };
    if (detail === 'cross') return { key: 'annot.type.cross', icon: X };
    if (detail === 'dot') return { key: 'annot.type.dot', icon: Dot };
  }
  if (kind === 'signature' && detail === 'initials') return { key: 'annot.type.initials', icon: Signature };
  if (kind === 'line' && detail === 'arrow') return { key: 'annot.type.arrow', icon: MoveUpRight };
  if (detail === 'date') return { key: 'annot.type.date', icon: Calendar };
  if (detail === 'text') return { key: 'annot.type.text', icon: Type };
  return KIND[kind];
}

/** The text markups: they have a quote. */
export const isTextMarkup = (kind: AnnotationKind): boolean =>
  kind === 'highlight' || kind === 'underline' || kind === 'strikeout';

/** The type groups of the filter (DESIGN 3.5 B10): a subtly distinct Lucide icon each. */
const GROUP: Record<TypeGroup, TypeInfo> = {
  highlight: { key: 'comments.group.highlight', icon: Highlighter },
  note: { key: 'comments.group.note', icon: StickyNote },
  drawing: { key: 'comments.group.drawing', icon: PenLine },
  shape: { key: 'comments.group.shape', icon: Shapes },
  signature: { key: 'comments.group.signature', icon: Signature },
  quote: { key: 'comments.group.quote', icon: MessageSquareQuote },
};

export const groupInfo = (group: TypeGroup): TypeInfo => GROUP[group];
