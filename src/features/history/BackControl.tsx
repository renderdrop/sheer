import { ArrowLeft } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { currentPlatform } from '../../actions/keys';
import { formatBinding } from '../../actions/shortcut';
import { IconButton } from '../../components';
import { useT } from '../../i18n';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useSettings } from '../../stores/settings';
import { back, historyBinding } from './actions';
import { useHistory } from './useHistory';

/** From this window width the control carries the page it returns to (DESIGN 3.11 L7). */
export const LABEL_MIN_WIDTH = 1100;

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useLayoutEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * The Back control of the top bar's centre group (DESIGN 3.11 L7): Ghost 28, `arrow-left`, and from 1100 px of window width the
 * page it returns to. Its slot is 96 wide and always there, so the group never shifts. A label that does not fit is dropped (icon
 * only, no ellipsis); with nothing to go back to the control is disabled and its tooltip says so.
 */
export function BackControl() {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? currentPlatform();
  const docId = useDocuments(selectActiveId);
  const { canBack, backLabel } = useHistory(docId);
  const windowWidth = useWindowWidth();
  const wide = windowWidth >= LABEL_MIN_WIDTH;
  const label = wide && backLabel !== null ? t('nav.back.label', { label: backLabel }) : null;
  const slot = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<{ key: string; fits: boolean } | null>(null);
  const key = `${label ?? ''}|${windowWidth}`;
  const unmeasured = measured?.key !== key;
  const shown = label !== null && (unmeasured || measured?.fits !== false);

  // A label that does not fit the slot is not shown (never clipped or ellipsised): it is measured once per label and width.
  useLayoutEffect(() => {
    const host = slot.current;
    const span = text.current;
    if (!unmeasured || host === null || span === null) return;
    const used = span.getBoundingClientRect().right - host.getBoundingClientRect().left;
    const room = host.clientWidth;
    setMeasured({ key, fits: room <= 0 || used <= room });
  }, [key, unmeasured]);
  const shortcut = formatBinding(historyBinding('back', platform), platform, t);

  return (
    <div ref={slot} data-slot="history-back" className="flex w-(--space-24) shrink-0 items-center">
      <IconButton
        size="sm"
        icon={ArrowLeft}
        iconSize={16}
        label={canBack ? t('nav.back') : t('nav.back.empty')}
        shortcut={canBack ? shortcut.label : undefined}
        keyShortcuts={shortcut.aria}
        disabled={!canBack || docId === null}
        focusableWhenDisabled
        className="w-full justify-start"
        data-toolbar-item="history-back"
        onClick={() => docId !== null && back(docId)}
      >
        {shown && (
          <span ref={text} className="t-caption ms-1 tabular-nums whitespace-nowrap">
            {label}
          </span>
        )}
      </IconButton>
    </div>
  );
}
