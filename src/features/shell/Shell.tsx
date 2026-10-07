import { useEffect } from 'react';

import { ActionKeys } from '../../actions/keys';
import { FocusRing } from '../../components/FocusRing';
import { chromeFor, detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { setMenuState } from '../../api/recents';
import { AboutDialog } from '../about/AboutDialog';
import { SignatureLibraryDialog } from '../signatures/library';
import { SignaturesDialog } from '../sigcheck/SignaturesDialog';
import { SignDialogHost } from '../signatures/sign';
import { ToolAnnouncer } from '../annotations/layer/ToolAnnouncer';
import { RefusalTip } from '../textedit/RefusalTip';
import { TextEditAnnouncer } from '../textedit/TextEditAnnouncer';
import { SettingsPopover } from '../settings/SettingsPopover';
import { ExportCopyDialog } from '../exportCopy/ExportCopyDialog';
import { ExportImagesDialog } from '../exportImages/ExportImagesDialog';
import { OcrDialog } from '../ocr/OcrDialog';
import { ImagesToPdfDialog } from '../imagesToPdf/ImagesToPdfDialog';
import { PrintDialog } from '../print/PrintDialog';
import { JobsHost } from '../jobs/JobsHost';
import { PasswordDialog } from '../password/PasswordDialog';
import { ProtectSheet } from '../protect/ProtectSheet';
import { PropertiesDialog } from '../properties/PropertiesDialog';
import { RedactApplyDialog } from '../redact/RedactApplyDialog';
import { AuthorPromptField } from '../author/AuthorPromptField';
import { UnsavedDialog } from '../save/UnsavedDialog';
import { TourEffects } from '../tour/TourEffects';
import { HistoryEffects } from '../history';
import { ViewerEffects } from '../viewer/useViewer';
import { ToastLayer } from './Toast';
import { CaptionBar } from './CaptionBar';
import { EditorLayout } from './EditorLayout';
import { HomeSlot } from './HomeSlot';
import { Splash } from './Splash';
import { useViewSync, useWindowState } from './hooks';
import { useRegionCycling } from './regions';
import { useShellStructure } from './useShellStructure';

/**
 * The app shell (DESIGN v2 3): either Home (`HomeSlot`, the whole window on the brand surface) or the editor (`EditorLayout`, a work
 * surface with the top bar, the page sidebar, the canvas column and the tool sidebar). Which one shows follows `ui.view`
 * and the open documents (`useViewSync`): no document is Home, opening or activating one is the editor, and `view-home` goes back to Home
 * while the documents stay open. The columns of the editor come from `shellTracks` (src/lib/layout.ts).
 *
 * Every surface has its slot here and nothing overlaps: popovers, tooltips and the drop overlay are the only layers
 * above the grid, each at its own elevation (DESIGN 1.7).
 *
 * The shell itself only decides the structure (`useShellStructure`, booleans that flip at the rules' thresholds) and the platform's
 * chrome. Everything that changes often is followed by the part that shows it, so a page, a zoom step, a render, a drag over the
 * window or a step of the splitter re-renders those parts and never the shell.
 */
export function Shell() {
  const settingsPlatform = useSettings((state) => state.platform);
  // The user agent gives the platform for the first paint; the backend's answer replaces it (see lib/platform.ts).
  const platform = settingsPlatform ?? detectPlatform();
  const chrome = chromeFor(platform);
  const windowState = useWindowState(chrome);
  const structure = useShellStructure();
  useViewSync();
  useRegionCycling();

  // Esc releases the active tool back to Select (DESIGN 2.3). Tooltips and popovers handle Esc before this sees it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) useUi.getState().releaseTool();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const hasDocument = structure.mode === 'document';

  // The macOS menu bar greys the commands that need a document, and Cmd+W closes the window without one. No menu bar elsewhere.
  useEffect(() => {
    setMenuState(hasDocument).catch(() => undefined);
  }, [hasDocument]);

  const trafficLightInset = chrome.trafficLights && !windowState.fullscreen;
  const captionControls = chrome.caption ? (
    <CaptionBar maximized={windowState.maximized} onChanged={windowState.refresh} />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerEffects />
      <TourEffects />
      <ActionKeys />
      <HistoryEffects />
      <PasswordDialog />
      <JobsHost />
      <UnsavedDialog />
      <AuthorPromptField />
      <ProtectSheet />
      <PropertiesDialog />
      <RedactApplyDialog />
      <ExportImagesDialog />
      <OcrDialog />
      <ImagesToPdfDialog />
      <PrintDialog />
      <ExportCopyDialog />
      {/* Portals, so they take no room in the shell, and in Home as in the editor: the settings popover hangs from the toolbar (it opens from its key), the About dialog is a modal. */}
      <ToolAnnouncer />
      <TextEditAnnouncer />
      <RefusalTip />
      <SettingsPopover />
      <AboutDialog />
      <SignatureLibraryDialog />
      <SignaturesDialog />
      <SignDialogHost />
      {hasDocument ? (
        <EditorLayout
          structure={structure}
          platform={platform}
          trafficLightInset={trafficLightInset}
          captionControls={captionControls}
        />
      ) : (
        <HomeSlot platform={platform} trafficLightInset={trafficLightInset} captionControls={captionControls} />
      )}
      <ToastLayer />
      <Splash />
      <FocusRing />
    </div>
  );
}
