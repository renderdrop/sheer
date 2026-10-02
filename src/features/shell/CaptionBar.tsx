import { Copy, Minus, Square, X, type LucideIcon } from 'lucide-react';

import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../../api/window';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { APP_NAME } from '../../config/app';
import { strings } from '../../strings';
import logoUrl from '../../../assets/brand/logo.svg';
import { useWindowFocused } from './hooks';

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
 * One of the three caption buttons: 46 x 32, glyph 16. Not a tab stop (a native caption has none; the keyboard has
 * Alt+F4 and the system's window keys). The click never rejects: outside Tauri there is no window and nothing happens.
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
          : 'hover:bg-control-hover active:bg-control-pressed',
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
 * The Windows caption row (DESIGN 2.2): 32 high, the app icon (16), 8 px, the name in meta type on the left, minimize,
 * maximize or restore, and close on the right. The window has no native decorations (`decorations: false`), so this row
 * is the title bar: it is a drag region (drag, and a double click maximizes, handled by Tauri's `data-tauri-drag-region`
 * script, which needs `core:window:allow-start-dragging` and `-internal-toggle-maximize`). An inactive window dims the title and the glyphs.
 */
export function CaptionBar({ maximized, onChanged }: CaptionBarProps) {
  const focused = useWindowFocused();
  const act = (action: () => Promise<void>) => () => {
    action()
      .catch(() => undefined)
      .finally(onChanged);
  };

  return (
    <div
      data-tauri-drag-region="deep"
      className={cx('flex h-caption shrink-0 items-center', focused ? 'text-text' : 'text-text-disabled')}
    >
      <div className="flex min-w-0 flex-auto items-center gap-1 ps-1-5 text-sm">
        <img src={logoUrl} alt="" className="size-icon-16 shrink-0" draggable={false} />
        <span className={cx('truncate', focused ? 'text-text-muted' : 'text-text-disabled')}>{APP_NAME}</span>
      </div>
      <div role="group" aria-label={strings.windowControls} className="flex h-full shrink-0">
        <CaptionButton label={strings.minimize} icon={Minus} onClick={act(minimizeWindow)} />
        <CaptionButton
          label={maximized ? strings.restore : strings.maximize}
          icon={maximized ? Copy : Square}
          onClick={act(toggleMaximizeWindow)}
        />
        <CaptionButton label={strings.close} icon={X} onClick={act(closeWindow)} danger />
      </div>
    </div>
  );
}
