import { useId, useMemo, type CSSProperties, type ReactNode } from 'react';

import type { Platform } from '../../api/app';
import { WorkSurface } from '../../components';
import { PANEL } from '../../components/tokens';
import { shellTracks, type ShellStructure } from '../../lib/layout';
import { MiniBarSlot } from '../minibar/MiniBarSlot';
import { ModeRow, ToolRow } from '../modes';
import { CanvasSlot } from '../organize/CanvasSlot';
import { BannerSlot } from './BannerSlot';
import { MenuRowSlot } from './MenuRowSlot';
import { LeftPanelSlot } from './LeftPanel';
import { LeftPanelSplitter, MainGrid } from './MainGrid';
import { TopBarSlot } from './TopBarSlot';

const placements = new Map<number | undefined, CSSProperties>();

/**
 * `grid-column` for a slot, as an object that is the same one every time for the same column, which is what lets the memoized
 * panels skip a render when the structure changes around them (there are at most four columns, so the map stays small).
 */
function placement(column: number | undefined): CSSProperties {
  let style = placements.get(column);
  if (style === undefined) {
    style = { gridColumn: column };
    placements.set(column, style);
  }
  return style;
}

export interface EditorLayoutProps {
  structure: ShellStructure;
  platform: Platform | null;
  trafficLightInset: boolean;
  /** The Windows caption buttons; the menu row draws them itself, so this is unused. */
  captionControls?: ReactNode;
}

/**
 * The editor (DESIGN v2 3.2, ADR-102), a `WorkSurface` around everything. Rows: menu row 32 (Windows only) | top bar 56 | mode row 40 |
 * tool row 48 | body. The body's columns are the page sidebar (200 to 320) | splitter 8 | canvas column (banner slot rows, then the
 * canvas, with the mini bar as an overlay child). There is no right column and no rail. Each slot is filled by its own component, so
 * later packages replace one file each. The rows come from `shellTracks` (src/lib/layout.ts), one child per track, in order.
 */
export function EditorLayout({ structure, platform, trafficLightInset }: EditorLayoutProps) {
  const leftPanelId = useId();
  // Where each slot sits depends on the structure alone, not on the panel's width.
  const slots = useMemo(() => {
    const { column } = shellTracks(structure, PANEL.default);
    return {
      left: placement(column.left),
      splitter: placement(column.splitter),
      canvas: placement(column.canvas),
    };
  }, [structure]);
  const rows = useMemo(() => shellTracks(structure, PANEL.default).rows, [structure]);

  return (
    <WorkSurface data-slot="editor" style={{ gridTemplateRows: rows }} className="grid min-h-0 flex-auto">
      {structure.menuRow && <MenuRowSlot />}
      <TopBarSlot
        platform={platform}
        hasDocument
        leftPanelVisible={!structure.leftCollapsed}
        trafficLightInset={trafficLightInset}
      />
      <ModeRow />
      <ToolRow />
      <MainGrid structure={structure}>
        <LeftPanelSlot present={!structure.leftCollapsed} id={leftPanelId} style={slots.left} />
        <LeftPanelSplitter controls={leftPanelId} collapsed={structure.leftCollapsed} style={slots.splitter} />
        <div
          style={slots.canvas}
          className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]"
        >
          <BannerSlot />
          <CanvasSlot />
          <MiniBarSlot />
        </div>
      </MainGrid>
    </WorkSurface>
  );
}
