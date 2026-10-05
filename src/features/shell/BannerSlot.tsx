import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { cx } from '../../components/cx';
import { useT } from '../../i18n';
import { DropBannerRow } from '../jobs/JobsHost';
import { RecoveryBanner } from '../recovery/RecoveryBanner';
import { RedactBanner } from '../redact/RedactBanner';
import { UpdateBannerRow } from '../update/UpdateBanner';
import { MiniBarDock } from '../minibar/MiniBarDock';
import { FormHost } from '../forms/FormHost';
import { SigBanner } from '../sigcheck/SigBanner';
import { useBannerWinner, type BannerKind } from './bannerPriority';
import { BannerRow, XfaBannerRow } from './Banner';

/** How many of the other notices show at once; the rest wait behind them and are counted in a line below (DESIGN v2 3.2). */
export const MAX_NOTICES = 2;

/** The number of children of an element that have content, kept up to date (an absent notice may leave an empty wrapper; it is not counted). */
export function useChildCount(ref: RefObject<HTMLElement | null>): number {
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const read = () => setCount([...element.children].filter((child) => !child.matches(':empty')).length);
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref]);
  return count;
}

/** The notices that do not show: all of them behind a higher banner, or the ones past `MAX_NOTICES`. */
export function queuedCount(mounted: number, winner: BannerKind): number {
  return winner === 'other' ? Math.max(0, mounted - MAX_NOTICES) : mounted;
}

/**
 * The banner slot (DESIGN v2 3.2): the row at the top of the canvas column, 0 high while nothing has to be said, so pages never sit
 * under it. One F6 stop for every banner (DESIGN 2.3); the banners stack in flow, and each brings its own height. Home has the same
 * slot above its body.
 */
export function BannerSlot() {
  const t = useT();
  const winner = useBannerWinner();
  const others = useRef<HTMLDivElement>(null);
  const queued = queuedCount(useChildCount(others), winner);
  return (
    <div data-region="banner" data-slot="banner" className="flex min-w-0 flex-col">
      <RedactBanner />
      <SigBanner />
      <FormHost />
      {/* The other notices queue behind the redact band and the form banner; they stay mounted, so nothing is lost. At most two show. */}
      <div
        ref={others}
        data-banner-others=""
        className={cx(winner === 'other' ? 'flex min-w-0 flex-col [&>*:nth-child(n+3)]:hidden' : 'hidden')}
      >
        <BannerRow />
        <RecoveryBanner />
        <XfaBannerRow />
        <DropBannerRow />
        <UpdateBannerRow />
      </div>
      {queued > 0 && (
        <p role="status" data-banner-queued="" className="t-caption m-0 px-4 pb-2 text-text-muted">
          {t('banner.queued', { count: queued })}
        </p>
      )}
      {/* The second row: the properties mini bar docks here when neither side of the selection has room (DESIGN v2 3.3). */}
      <MiniBarDock />
    </div>
  );
}
