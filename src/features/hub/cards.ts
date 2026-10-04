import {
  FileArchive,
  FileImage,
  Files,
  FolderOpen,
  Images,
  Scissors,
  Signature,
  SquareSlash,
  TextCursorInput,
  type LucideIcon,
} from 'lucide-react';

import type { PlainKey } from '../../i18n';
import type { HubIntent } from './intent';

export const HUB_CARD_IDS = [
  'open',
  'merge',
  'split',
  'compress',
  'images',
  'sign',
  'redact',
  'fill',
  'export',
] as const;
export type HubCardId = (typeof HUB_CARD_IDS)[number];

export interface HubCard {
  id: HubCardId;
  icon: LucideIcon;
  titleKey: PlainKey;
  hintKey: PlainKey;
  /** Shows the "Several files" pill (the shortcut pill of Open is added by the page). */
  multi: boolean;
  /** Runs when the file is open; none for Open, Merge and Images to PDF. */
  intent: HubIntent | null;
}

/** The eight cards in grid order (DESIGN 3.54). */
export const HUB_CARDS: readonly HubCard[] = [
  { id: 'open', icon: FolderOpen, titleKey: 'hub.open', hintKey: 'hub.openHint', multi: false, intent: null },
  { id: 'merge', icon: Files, titleKey: 'hub.merge', hintKey: 'hub.mergeHint', multi: true, intent: null },
  { id: 'split', icon: Scissors, titleKey: 'hub.split', hintKey: 'hub.splitHint', multi: false, intent: 'split' },
  {
    id: 'compress',
    icon: FileArchive,
    titleKey: 'hub.compress',
    hintKey: 'hub.compressHint',
    multi: false,
    intent: 'compress',
  },
  { id: 'images', icon: Images, titleKey: 'hub.images', hintKey: 'hub.imagesHint', multi: true, intent: null },
  { id: 'sign', icon: Signature, titleKey: 'hub.sign', hintKey: 'hub.signHint', multi: false, intent: 'sign' },
  {
    id: 'redact',
    icon: SquareSlash,
    titleKey: 'hub.redact',
    hintKey: 'hub.redactHint',
    multi: false,
    intent: 'redact',
  },
  {
    id: 'fill',
    icon: TextCursorInput,
    titleKey: 'hub.fill',
    hintKey: 'hub.fillHint',
    multi: false,
    intent: 'fill',
  },
  {
    id: 'export',
    icon: FileImage,
    titleKey: 'home.tool.export',
    hintKey: 'home.tool.exportHint',
    multi: false,
    intent: 'export',
  },
];
