import { useMemo, type CSSProperties, type ReactNode } from 'react';

import type { Platform } from '../../api/app';
import { WorkSurface } from '../../components';
import { PANEL } from '../../components/tokens';
import { shellTracks, type ShellStructure } from '../../lib/layout';
import { MiniBarSlot } from '../minibar/MiniBarSlot';
import { ToolInspector } from '../inspector/ToolInspectorPanel';
import { ModeCard } from '../modes/ModeCard';
import { CanvasSlot } from '../organize/CanvasSlot';
import { BannerSlot } from './BannerSlot';
import { MenuRowSlot } from './MenuRowSlot';
import { LeftPanelSlot } from './LeftPanel';
import { InspectorSlot } from './InspectorSlot';
import { LeftPanelSplitter, MainGrid } from './MainGrid';
import { StatusBar } from '../statusbar/StatusBar';
import { TopBarSlot } from './TopBarSlot';
import { LEFT_PANEL_ID } from './ids';

export interface EditorLayoutProps {
  structure: ShellStructure;
  platform: Platform | null;
  trafficLightInset: boolean;
  /** The Windows caption buttons; the menu row draws them itself, so this is unused. */
  captionControls?: ReactNode;
}

/** A 12 px band of chrome between the tab strip, the mode card and the body (`--surface-panel`). */
function Gutter() {
  return <div aria-hidden="true" data-slot="gutter" className="bg-chrome" />;
}

/**
 * The editor (DESIGN 3.18 E1), a `WorkSurface` around everything. Rows: menu row 28 (Windows only) | tab strip 42 | gutter 12 | mode card
 * 104 | gutter 12 | body | status bar 30. The body's columns are the left panel (220) | splitter 8 | canvas column (banner slot rows,
 * then the canvas, with the mini bar as an overlay child) | inspector (300, or 0). Each slot is filled by its own component. The rows come
 * from `shellTracks` (src/lib/layout.ts), one child per track, in order. The mode card slot is inset 12 on both sides; the card inside
 * it is the mode package's.
 */
export function EditorLayout({ structure, platform, trafficLightInset }: EditorLayoutProps) {
  const leftPanelId = LEFT_PANEL_ID;
  // Where each slot sits depends on the structure alone, not on the panel's width. Each placement is its own memo on its column, so the
  // memoized panels get the same style object and skip a render when the structure changes around them.
  const { column, rows } = useMemo(() => shellTracks(structure, PANEL.default), [structure]);
  const left = useMemo<CSSProperties>(() => ({ gridColumn: column.left }), [column.left]);
  const splitter = useMemo<CSSProperties>(() => ({ gridColumn: column.splitter }), [column.splitter]);
  const canvas = useMemo<CSSProperties>(() => ({ gridColumn: column.canvas }), [column.canvas]);
  const inspector = useMemo<CSSProperties>(() => ({ gridColumn: column.inspector }), [column.inspector]);

  return (
    <WorkSurface data-slot="editor" style={{ gridTemplateRows: rows }} className="grid min-h-0 flex-auto">
      {structure.menuRow && <MenuRowSlot />}
      <TopBarSlot
        platform={platform}
        hasDocument
        leftPanelVisible={!structure.leftCollapsed}
        trafficLightInset={trafficLightInset}
      />
      <Gutter />
      <div data-slot="mode-card-row" className="bg-chrome flex min-h-0 min-w-0 flex-col">
        <ModeCard />
      </div>
      <Gutter />
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
        <InspectorSlot open={structure.inspector} style={inspector}>
          <ToolInspector />
        </InspectorSlot>
      </MainGrid>
      <StatusBar />
    </WorkSurface>
  );
}
