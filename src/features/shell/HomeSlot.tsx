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
 * Home (DESIGN v2 3.1): the whole window on a `BrandSurface`. The top 56 strip is the drag region, with the Windows caption buttons
 * at the right or the macOS traffic-light inset at the left; below it the banner slot and the body (`features/home`).
 */
export function HomeSlot({ platform, trafficLightInset, captionControls }: HomeSlotProps) {
  return (
    <BrandSurface data-slot="home" className="flex min-h-0 flex-auto flex-col">
      <div
        data-slot="home-strip"
        data-tauri-drag-region="deep"
        className={cx('flex h-topbar shrink-0 items-stretch', trafficLightInset && 'ps-chrome-inset')}
      >
        <span aria-hidden="true" className="flex-auto" />
        {captionControls}
      </div>
      <BannerSlot />
      <Home platform={platform} />
    </BrandSurface>
  );
}
