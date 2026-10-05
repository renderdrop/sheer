import { useMemo, type CSSProperties, type ReactNode } from 'react';

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
import { LEFT_PANEL_ID } from './ids';

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
  const leftPanelId = LEFT_PANEL_ID;
  // Where each slot sits depends on the structure alone, not on the panel's width. Each placement is its own memo on its column, so the
  // memoized panels get the same style object and skip a render when the structure changes around them.
  const { column, rows } = useMemo(() => shellTracks(structure, PANEL.default), [structure]);
  const left = useMemo<CSSProperties>(() => ({ gridColumn: column.left }), [column.left]);
  const splitter = useMemo<CSSProperties>(() => ({ gridColumn: column.splitter }), [column.splitter]);
  const canvas = useMemo<CSSProperties>(() => ({ gridColumn: column.canvas }), [column.canvas]);

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
        <LeftPanelSlot present={!structure.leftCollapsed} id={leftPanelId} style={left} />
        <LeftPanelSplitter controls={leftPanelId} collapsed={structure.leftCollapsed} style={splitter} />
        <div
          style={canvas}
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
