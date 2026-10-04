import { useId, useMemo, type CSSProperties, type ReactNode } from 'react';

import type { Platform } from '../../api/app';
import { WorkSurface } from '../../components';
import { PANEL } from '../../components/tokens';
import { shellTracks, type ShellStructure } from '../../lib/layout';
import { CanvasSlot } from '../organize/CanvasSlot';
import { BannerSlot } from './BannerSlot';
import { LeftPanelSlot } from './LeftPanel';
import { LeftPanelSplitter, MainGrid } from './MainGrid';
import { ToolSidebarSlot } from './ToolSidebarSlot';
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
  /** The Windows caption buttons for the top bar; `null` elsewhere. */
  captionControls: ReactNode;
}

/**
 * The editor (DESIGN v2 3.2), a `WorkSurface` around everything: rows top bar 56 | body; the body's columns are the page sidebar
 * (200 to 320) | splitter 8 | canvas column (banner slot row, then the canvas) | tool sidebar 280, which is the 56 rail below 1100
 * wide. Each slot is filled by its own component, so later packages replace one file each.
 */
export function EditorLayout({ structure, platform, trafficLightInset, captionControls }: EditorLayoutProps) {
  const leftPanelId = useId();
  // Where each slot sits depends on the structure alone, not on the panel's width.
  const slots = useMemo(() => {
    const { column } = shellTracks(structure, PANEL.default);
    return {
      left: placement(column.left),
      splitter: placement(column.splitter),
      canvas: placement(column.canvas),
      tool: placement(column.tool),
    };
  }, [structure]);

  return (
    <WorkSurface data-slot="editor" className="grid min-h-0 flex-auto grid-rows-[var(--topbar-height)_minmax(0,1fr)]">
      <TopBarSlot
        platform={platform}
        hasDocument
        leftPanelVisible={!structure.leftCollapsed}
        inspectorVisible={structure.inspectorVisible}
        trafficLightInset={trafficLightInset}
        captionControls={captionControls}
      />
      <MainGrid structure={structure}>
        <LeftPanelSlot present={!structure.leftCollapsed} id={leftPanelId} style={slots.left} />
        <LeftPanelSplitter controls={leftPanelId} collapsed={structure.leftCollapsed} style={slots.splitter} />
        <div
          style={slots.canvas}
          className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]"
        >
          <BannerSlot />
          <CanvasSlot />
        </div>
        <ToolSidebarSlot visible={structure.inspectorVisible} style={slots.tool} />
      </MainGrid>
    </WorkSurface>
  );
}
