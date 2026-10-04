import { chromeFor, detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { CaptionBar } from './CaptionBar';
import { useWindowState } from './hooks';
import { MenuBar } from './MenuBar';

/**
 * The Windows menu row above the top bar (DESIGN v2 3.2, ADR-102): 32 high, the menus from `menu.json` at the left (from x 8) and the
 * caption buttons, 46 x 32, flush right (hidden in full screen). Empty space drags the window. Other platforms have no such row (macOS
 * has its native bar), so it renders nothing there and the grid does not reserve a track for it.
 */
export function MenuRowSlot() {
  const settingsPlatform = useSettings((state) => state.platform);
  const chrome = chromeFor(settingsPlatform ?? detectPlatform());
  const windowState = useWindowState(chrome);
  if (!chrome.caption) return null;
  return (
    <div data-slot="menu-row" data-tauri-drag-region="deep" className="flex h-menubar shrink-0 items-stretch ps-2">
      <div className="flex items-center">
        <MenuBar />
      </div>
      <span aria-hidden="true" className="flex-auto" />
      {!windowState.fullscreen && <CaptionBar maximized={windowState.maximized} onChanged={windowState.refresh} />}
    </div>
  );
}
