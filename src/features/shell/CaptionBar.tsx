import { Copy, Minus, Square, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../../api/window';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import logoUrl from '../../../assets/brand/logo.svg';
import { selectActiveDocument, useDocuments } from '../../stores/documents';
import { useWindowFocused } from './hooks';
import { MenuBar } from './MenuBar';
import { splitForMiddleTruncation } from './status';

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

/** Free room below which the document name is not shown (DESIGN 3.56). */
const NAME_MIN_ROOM = 80;

/** The drag spacer: the active document's name, centred, cut in the middle when it is long, gone when there is no room. */
function DocumentName({ focused }: { focused: boolean }) {
  const name = useDocuments((state) => selectActiveDocument(state)?.displayName ?? null);
  const ref = useRef<HTMLDivElement>(null);
  // Unknown (0) counts as roomy, so the name is there before the first measurement and in tests without layout.
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setRoom(element.clientWidth === 0 ? Number.POSITIVE_INFINITY : element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const parts = name === null || name === '' ? null : splitForMiddleTruncation(name);
  return (
    <div ref={ref} className="flex min-w-0 flex-auto items-center justify-center px-2 text-sm">
      {parts !== null && room >= NAME_MIN_ROOM && (
        <span
          data-caption-name=""
          title={name ?? undefined}
          className={cx('flex min-w-0 max-w-full', focused ? 'text-text-muted' : 'text-text-disabled')}
        >
          <span className="sr-only">{name}</span>
          <span aria-hidden="true" className="min-w-0 truncate">
            {parts.head}
          </span>
          <span aria-hidden="true" className="shrink-0">
            {parts.tail}
          </span>
        </span>
      )}
    </div>
  );
}

export interface CaptionBarProps {
  maximized: boolean;
  /** Called after a caption button acted, so the maximize or restore icon can be re-read. */
  onChanged: () => void;
}

/**
 * The Windows caption row (DESIGN 2.2, 3.56): 32 high, the app icon (16) at 16 px, 8 px, the menu bar, the drag spacer with the
 * document name centred in it (middle-truncated, hidden when less than 80 px are free), then minimize, maximize or restore, and close. The window has no native decorations (`decorations: false`), so this row
 * is the title bar: it is a drag region (drag, and a double click maximizes, handled by Tauri's `data-tauri-drag-region`
 * script, which needs `core:window:allow-start-dragging` and `-internal-toggle-maximize`). An inactive window dims the title and the glyphs.
 */
export function CaptionBar({ maximized, onChanged }: CaptionBarProps) {
  const t = useT();
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
      <div className="flex shrink-0 items-center gap-2 ps-4">
        <img src={logoUrl} alt="" className="size-icon-16 shrink-0" draggable={false} />
        <MenuBar />
      </div>
      <DocumentName focused={focused} />
      <div role="group" aria-label={t('window.controls')} className="flex h-full shrink-0">
        <CaptionButton label={t('window.minimize')} icon={Minus} onClick={act(minimizeWindow)} />
        <CaptionButton
          label={maximized ? t('window.restore') : t('window.maximize')}
          icon={maximized ? Copy : Square}
          onClick={act(toggleMaximizeWindow)}
        />
        <CaptionButton label={t('window.close')} icon={X} onClick={act(closeWindow)} danger />
      </div>
    </div>
  );
}
