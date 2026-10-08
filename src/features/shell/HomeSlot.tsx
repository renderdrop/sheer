import type { ReactNode } from 'react';

import type { Platform } from '../../api/app';
import { BrandSurface } from '../../components';
import { cx } from '../../components/cx';
import { Home } from '../home/Home';
import { BannerSlot } from './BannerSlot';

export interface HomeSlotProps {
  platform: Platform | null;
  /** macOS, not in full screen: the traffic lights sit at the start of the strip. */
  trafficLightInset: boolean;
  /** The Windows caption buttons, flush right in the strip; `null` elsewhere. */
  captionControls: ReactNode;
}

/**
 * Home (DESIGN v2 3.1): the whole window on a `BrandSurface`. The top 40 strip is the drag region, laid over the nav and the main column (they start at the window top, DESIGN 3.18 H1), with the Windows caption buttons
 * at the right or the macOS traffic-light inset at the left; below it the banner slot and the body (`features/home`).
 */
export function HomeSlot({ platform, trafficLightInset, captionControls }: HomeSlotProps) {
  return (
    <BrandSurface data-slot="home" className="relative flex min-h-0 flex-auto flex-col">
      <div
        role="banner"
        data-slot="home-strip"
        data-tauri-drag-region="deep"
        className={cx('absolute inset-x-0 top-0 z-10 flex h-10 items-stretch', trafficLightInset && 'ps-chrome-inset')}
      >
        <span aria-hidden="true" className="flex-auto" />
        {/* 46 x 28, the size of the menu row's, so the buttons do not jump between Home and the editor (DESIGN v2 3.2). */}
        {captionControls !== null && <div className="h-menubar shrink-0">{captionControls}</div>}
      </div>
      <BannerSlot />
      <Home platform={platform} />
    </BrandSurface>
  );
}
