import { Copy, Minus, Square, X, type LucideIcon } from 'lucide-react';

import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../../api/window';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';

const CAPTION_BUTTON =
  'inline-flex h-full w-caption-button shrink-0 cursor-default items-center justify-center bg-transparent ' +
  'transition-[background-color,color]';

interface CaptionButtonProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** The close button: red on hover and press, with a white glyph (DESIGN 2.2). */
  danger?: boolean;
}

/**
 * One of the three caption buttons: 46 wide and as high as the row that holds them (28, `--menubar-height`), glyph 16. Not a tab stop (a native caption has none; the
 * keyboard has Alt+F4 and the system's window keys). The click never rejects: outside Tauri there is no window and nothing happens.
 */
function CaptionButton({ label, icon, onClick, danger = false }: CaptionButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      className={cx(
        CAPTION_BUTTON,
        danger
          ? 'hover:bg-win-close hover:text-on-close active:bg-win-close active:text-on-close'
          : 'hover:bg-subtle active:bg-pressed',
      )}
    >
      <Icon icon={icon} />
    </button>
  );
}

export interface CaptionBarProps {
  maximized: boolean;
  /** Called after a caption button acted, so the maximize or restore icon can be re-read. */
  onChanged: () => void;
}

/**
 * The Windows caption controls (DESIGN v2 3.2): minimize, maximize or restore, and close, flush right in the menu row of the editor and in the
 * top strip of Home (in a 28 high box). The window has no native decorations (`decorations: false`); the strip around them is the drag region
 * (drag, and a double click maximizes, handled by Tauri's `data-tauri-drag-region` script, which needs `core:window:allow-start-dragging`
 * and `-internal-toggle-maximize`). The menu row (`MenuRowSlot`) holds them in the editor.
 */
export function CaptionBar({ maximized, onChanged }: CaptionBarProps) {
  const t = useT();
  const act = (action: () => Promise<void>) => () => {
    action()
      .catch(() => undefined)
      .finally(onChanged);
  };

  return (
    <div role="group" aria-label={t('window.controls')} className="flex h-full shrink-0">
      <CaptionButton label={t('window.minimize')} icon={Minus} onClick={act(minimizeWindow)} />
      <CaptionButton
        label={maximized ? t('window.restore') : t('window.maximize')}
        icon={maximized ? Copy : Square}
        onClick={act(toggleMaximizeWindow)}
      />
      <CaptionButton label={t('window.close')} icon={X} onClick={act(closeWindow)} danger />
    </div>
  );
}
