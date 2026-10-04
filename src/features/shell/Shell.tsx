import { AnimatePresence } from 'motion/react';
import { useEffect, useId, useMemo, type CSSProperties } from 'react';

import { ActionKeys } from '../../actions/keys';
import { WorkSurface } from '../../components';
import { PANEL } from '../../components/tokens';
import { shellTracks } from '../../lib/layout';
import { chromeFor, detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { setMenuState } from '../../api/recents';
import { ExportCopyDialog } from '../exportCopy/ExportCopyDialog';
import { ExportImagesDialog } from '../exportImages/ExportImagesDialog';
import { ImagesToPdfDialog } from '../imagesToPdf/ImagesToPdfDialog';
import { PrintDialog } from '../print/PrintDialog';
import { FormHost } from '../forms/FormHost';
import { DropBannerRow, JobsHost } from '../jobs/JobsHost';
import { PasswordDialog } from '../password/PasswordDialog';
import { ProtectSheet } from '../protect/ProtectSheet';
import { PropertiesDialog } from '../properties/PropertiesDialog';
import { RedactApplyDialog } from '../redact/RedactApplyDialog';
import { RecoveryBanner } from '../recovery/RecoveryBanner';
import { RedactBanner } from '../redact/RedactBanner';
import { UnsavedDialog } from '../save/UnsavedDialog';
import { TabStrip } from '../tabs/TabStrip';
import { CanvasSlot } from '../organize/CanvasSlot';
import { TourEffects } from '../tour/TourEffects';
import { ViewerEffects } from '../viewer/useViewer';
import { UpdateBannerRow } from '../update/UpdateBanner';
import { BannerRow, XfaBannerRow } from './Banner';
import { ToastLayer } from './Toast';
import { CaptionBar } from './CaptionBar';
import { EmptyStateSlot } from './EmptyStateSlot';
import { useWindowState } from './hooks';
import { useRegionCycling } from './regions';
import { InspectorSlot } from './Inspector';
import { LeftPanelSlot } from './LeftPanel';
import { LeftPanelSplitter, MainGrid } from './MainGrid';
import { ToolbarSlot } from './ToolbarSlot';
import { useShellStructure } from './useShellStructure';
import { ViewerStatusBar } from './ViewerStatusBar';

const placements = new Map<number | undefined, CSSProperties>();

/**
 * `grid-column` for a slot, as an object that is the same one every time for the same column. A slot that moves from
 * column 2 to 3 gets another style; one that stays put gets the very object it had, which is what lets the memoized panels
 * skip a render when the structure changes around them (there are at most seven columns, so the map stays small).
 */
function placement(column: number | undefined): CSSProperties {
  let style = placements.get(column);
  if (style === undefined) {
    style = { gridColumn: column };
    placements.set(column, style);
  }
  return style;
}

/**
 * The app shell (DESIGN 2): from top to bottom the Windows caption row (Windows only), the toolbar row, the banner row
 * (only while there is something to say), the main row and the status bar. The main row is a grid whose columns come from
 * `shellTracks` (src/lib/layout.ts): left panel, splitter, canvas, inspector, with the collapse rules of the spec.
 * Without a document the main row holds the empty state alone; the toolbar keeps its slot with every item `aria-disabled`.
 *
 * Every surface has its slot here and nothing overlaps: popovers, tooltips and the drop overlay are the only layers
 * above the grid, each at its own elevation (DESIGN 1.7).
 *
 * The shell itself only decides the structure: which slots exist (`useShellStructure`, booleans that flip at the rules'
 * thresholds) and the platform's chrome. Everything that changes often is followed by the part that shows it: the
 * toolbar by `ToolbarSlot`, the canvas and the status bar by the open document's page, zoom and image, the grid by the
 * panel width, the banner by the error. So a page, a zoom step, a render, a drag over the window or a step of the splitter
 * re-renders those parts and never the shell, its toolbar or its left panel.
 */
export function Shell() {
  const settingsPlatform = useSettings((state) => state.platform);
  // The user agent gives the platform for the first paint; the backend's answer replaces it (see lib/platform.ts).
  const platform = settingsPlatform ?? detectPlatform();
  const chrome = chromeFor(platform);
  const windowState = useWindowState(chrome);
  const structure = useShellStructure();
  const leftPanelId = useId();
  useRegionCycling();

  // Esc releases the active tool back to Select (DESIGN 2.3). Tooltips and popovers handle Esc before this sees it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) useUi.getState().releaseTool();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Where each slot sits depends on the structure alone, not on the panel's width.
  const slots = useMemo(() => {
    const { column } = shellTracks(structure, PANEL.default);
    return {
      left: placement(column.left),
      splitter: placement(column.splitter),
      canvas: placement(column.canvas),
      inspector: placement(column.inspector),
    };
  }, [structure]);

  const hasDocument = structure.mode === 'document';

  // The macOS menu bar greys the commands that need a document, and Cmd+W closes the window without one. No menu bar elsewhere.
  useEffect(() => {
    setMenuState(hasDocument).catch(() => undefined);
  }, [hasDocument]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerEffects />
      <TourEffects />
      <ActionKeys />
      {chrome.caption && <CaptionBar maximized={windowState.maximized} onChanged={windowState.refresh} />}
      <ToolbarSlot
        platform={platform}
        hasDocument={hasDocument}
        leftPanelVisible={!structure.leftCollapsed}
        inspectorVisible={structure.inspectorVisible}
        trafficLightInset={chrome.trafficLights && !windowState.fullscreen}
      />
      <TabStrip />
      <PasswordDialog />
      <JobsHost />
      <UnsavedDialog />
      <ProtectSheet />
      <PropertiesDialog />
      <RedactApplyDialog />
      <ExportImagesDialog />
      <ImagesToPdfDialog />
      <PrintDialog />
      <ExportCopyDialog />
      {/* One F6 stop for every banner (DESIGN 2.3); the wrapper adds no box of its own. */}
      <div data-region="banner" className="contents">
        <BannerRow />
        <RecoveryBanner />
        <XfaBannerRow />
        <RedactBanner />
        <FormHost />
        <DropBannerRow />
        <UpdateBannerRow />
      </div>
      <MainGrid structure={structure}>
        {/* The empty state fades out on its own (it stays in its slot, inert, until it is gone) while the document comes in. */}
        <AnimatePresence initial={false}>
          {!hasDocument && <EmptyStateSlot key="empty" platform={platform} style={slots.canvas} />}
        </AnimatePresence>
        {hasDocument && (
          <WorkSurface className="contents">
            <LeftPanelSlot present={!structure.leftCollapsed} id={leftPanelId} style={slots.left} />
            <LeftPanelSplitter controls={leftPanelId} collapsed={structure.leftCollapsed} style={slots.splitter} />
            <CanvasSlot style={slots.canvas} />
            <InspectorSlot present={structure.inspectorReserved} style={slots.inspector} />
          </WorkSurface>
        )}
      </MainGrid>
      <ViewerStatusBar />
      <ToastLayer />
    </div>
  );
}
