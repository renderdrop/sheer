import {
  Combine,
  Ellipsis,
  Eraser,
  FileArchive,
  FileImage,
  Image,
  PenTool,
  Scissors,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';

import { Icon } from '../../components';
import { useT, type PlainKey } from '../../i18n';
import type { HubCardId } from '../hub/cards';
import { runHubCard } from '../hub/run';
import { useHub } from '../hub/intent';
import { useViewer } from '../viewer/useViewer';
import { ROVING_ATTR, useRovingGroup } from './roving';

interface Tile {
  id: HubCardId | 'more';
  icon: LucideIcon;
  titleKey: PlainKey;
  hintKey: PlainKey;
}

/** The eight tiles of Home (DESIGN 3.18 H4), in the order of the spec; the last one opens the Werkzeuge view. */
const HOME_TILES: readonly Tile[] = [
  { id: 'merge', icon: Combine, titleKey: 'hub.merge', hintKey: 'home.tile.merge' },
  { id: 'split', icon: Scissors, titleKey: 'hub.split', hintKey: 'home.tile.split' },
  { id: 'compress', icon: FileArchive, titleKey: 'hub.compress', hintKey: 'home.tile.compress' },
  { id: 'fill', icon: SquarePen, titleKey: 'hub.fill', hintKey: 'home.tile.fill' },
  { id: 'sign', icon: PenTool, titleKey: 'hub.sign', hintKey: 'home.tile.sign' },
  { id: 'redact', icon: Eraser, titleKey: 'hub.redact', hintKey: 'home.tile.redact' },
  { id: 'images', icon: Image, titleKey: 'hub.images', hintKey: 'home.tile.images' },
  { id: 'more', icon: Ellipsis, titleKey: 'home.tool.more', hintKey: 'home.tile.more' },
];

/** The Werkzeuge view lists every tool: the tiles above without "More tools", plus the export. */
const ALL_TILES: readonly Tile[] = [
  ...HOME_TILES.slice(0, -1),
  { id: 'export', icon: FileImage, titleKey: 'home.tool.export', hintKey: 'home.tool.exportHint' },
];

export interface ToolRowsProps {
  /** The Werkzeuge view: every tool, no "More tools" tile. */
  all?: boolean;
  /** "More tools" leads to the Werkzeuge view. */
  onMore?: () => void;
}

/**
 * The tool tiles (DESIGN 3.18 H4): four columns (two below 1100 wide), gap 16, 88 high (72 compact); icon 24, title 15/20 500 over the
 * subtitle 14/20 Text-secondary. A tile runs the hub card: the file dialog, then the editor in the matching mode. While one runs (or a
 * document is being opened) the others are `aria-disabled`; arrows move through the grid.
 */
export function ToolRows({ all = false, onMore }: ToolRowsProps) {
  const t = useT();
  const busy = useHub((state) => state.busy);
  const opening = useViewer((state) => state.opening);
  const tiles = all ? ALL_TILES : HOME_TILES;
  const roving = useRovingGroup(tiles.map((tile) => tile.id));
  const locked = busy !== null || opening;
  return (
    <ul
      {...roving.groupProps}
      aria-label={t('home.tools.title')}
      data-home-tools=""
      className="home-tool-rows m-0 list-none p-0"
    >
      {tiles.map((tile) => (
        <li key={tile.id}>
          <button
            type="button"
            {...{ [ROVING_ATTR]: tile.id }}
            tabIndex={roving.tabIndexOf(tile.id)}
            aria-disabled={(tile.id !== 'more' && locked) || undefined}
            aria-busy={busy === tile.id || undefined}
            aria-describedby={`home-tile-${tile.id}-sub`}
            onClick={() => {
              if (tile.id === 'more') onMore?.();
              else if (!locked) void runHubCard(tile.id);
            }}
            className="home-tile group/tool flex size-full cursor-pointer items-center rounded-md border border-border-subtle bg-surface text-start transition-colors [transition-duration:var(--motion-fast)] not-aria-disabled:hover:bg-subtle not-aria-disabled:active:scale-(--scale-press) aria-disabled:cursor-not-allowed aria-disabled:opacity-(--opacity-disabled)"
          >
            <Icon icon={tile.icon} size={24} className="shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="home-tile-title">{t(tile.titleKey)}</span>
              <span id={`home-tile-${tile.id}-sub`} className="home-tile-sub text-text-muted">
                {t(tile.hintKey)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
