import {
  Combine,
  Crop,
  FileArchive,
  FileImage,
  Highlighter,
  Image,
  Images,
  LayoutGrid,
  Lock,
  MessageSquareText,
  PenLine,
  Plus,
  Quote,
  Rows2,
  ScanSearch,
  ScanText,
  Scissors,
  Shapes,
  Signature,
  SquareSlash,
  Stamp,
  StickyNote,
  TextCursorInput,
  Type,
  type LucideIcon,
} from 'lucide-react';

import type { PlainKey } from '../../i18n';
import { MODES, TOOLS, type Mode, type ToolId } from '../../stores/ui';

/**
 * The tools every document can start from (F21.3): the pointer tools are left out because their ready state is just an open document.
 * `select` has no tool of its own either (it is every mode's idle tool).
 */
export const EXCLUDED_TOOLS = ['select', 'textSelect', 'hand'] as const satisfies readonly ToolId[];

/** Tools of the mode cards that are not a `ToolId` (actions with an inspector or dialog), and the hub dialogs. */
export const EXTRA_TOOLS = [
  'redact',
  'headerFooter',
  'ocr',
  'protect',
  'split',
  'merge',
  'compress',
  'images',
  'export',
] as const;

export type CatalogueId = Exclude<ToolId, (typeof EXCLUDED_TOOLS)[number]> | (typeof EXTRA_TOOLS)[number];

export interface CatalogueEntry {
  id: CatalogueId;
  /** The mode card the tool belongs to; the Tools view groups by it and a launch ends in it. */
  mode: Mode;
  icon: LucideIcon;
  titleKey: PlainKey;
  subtitleKey: PlainKey;
}

const entry = (
  id: CatalogueId,
  mode: Mode,
  icon: LucideIcon,
  titleKey: PlainKey,
  subtitleKey: PlainKey,
): CatalogueEntry => ({ id, mode, icon, titleKey, subtitleKey });

/** Every tool of the five mode cards plus the hub dialogs, in the order of the cards (the order of the Tools view). */
export const CATALOGUE: readonly CatalogueEntry[] = [
  entry('magnifier', 'read', ScanSearch, 'modes.tool.magnifier', 'tools.sub.magnifier'),
  entry('highlight', 'comment', Highlighter, 'modes.tool.highlight', 'tools.sub.highlight'),
  entry('cite', 'comment', Quote, 'citation.cite', 'tools.sub.cite'),
  entry('note', 'comment', StickyNote, 'modes.tool.note', 'tools.sub.note'),
  entry('text', 'comment', MessageSquareText, 'modes.tool.freeText', 'tools.sub.text'),
  entry('draw', 'comment', PenLine, 'modes.tool.draw', 'tools.sub.draw'),
  entry('shapes', 'comment', Shapes, 'modes.tool.shapes', 'tools.sub.shapes'),
  entry('form', 'fill', TextCursorInput, 'hub.fill', 'tools.sub.form'),
  entry('signature', 'fill', Signature, 'hub.sign', 'tools.sub.signature'),
  entry('pages', 'pages', LayoutGrid, 'modes.tool.organize', 'tools.sub.pages'),
  entry('split', 'pages', Scissors, 'hub.split', 'tools.sub.split'),
  entry('merge', 'pages', Combine, 'hub.merge', 'tools.sub.merge'),
  entry('compress', 'pages', FileArchive, 'hub.compress', 'tools.sub.compress'),
  entry('images', 'pages', Images, 'hub.images', 'tools.sub.images'),
  entry('export', 'pages', FileImage, 'home.tool.export', 'tools.sub.export'),
  entry('editText', 'edit', Type, 'editText.tool', 'tools.sub.editText'),
  entry('textBox', 'edit', Plus, 'modes.tool.addText', 'tools.sub.textBox'),
  entry('image', 'edit', Image, 'modes.tool.addImage', 'tools.sub.image'),
  entry('crop', 'edit', Crop, 'modes.tool.crop', 'tools.sub.crop'),
  entry('headerFooter', 'edit', Rows2, 'modes.tool.headerFooter', 'tools.sub.headerFooter'),
  entry('stamp', 'edit', Stamp, 'stamp.tool', 'tools.sub.stamp'),
  entry('redact', 'edit', SquareSlash, 'modes.tool.redact', 'tools.sub.redact'),
  entry('protect', 'edit', Lock, 'modes.tool.protect', 'tools.sub.protect'),
  entry('ocr', 'edit', ScanText, 'tools.title.ocr', 'tools.sub.ocr'),
];

export const catalogueEntry = (id: CatalogueId): CatalogueEntry | undefined =>
  CATALOGUE.find((candidate) => candidate.id === id);

/** The entries per mode, in the order of MODES, without empty groups. */
export function catalogueByMode(): readonly { mode: Mode; entries: readonly CatalogueEntry[] }[] {
  return MODES.map((mode) => ({ mode, entries: CATALOGUE.filter((candidate) => candidate.mode === mode) })).filter(
    (group) => group.entries.length > 0,
  );
}

/** The `ToolId`s that must have an entry. */
export const CATALOGUED_TOOL_IDS: readonly ToolId[] = TOOLS.filter(
  (tool) => !(EXCLUDED_TOOLS as readonly ToolId[]).includes(tool),
);
