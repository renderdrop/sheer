import { DropBannerRow } from '../jobs/JobsHost';
import { RecoveryBanner } from '../recovery/RecoveryBanner';
import { RedactBanner } from '../redact/RedactBanner';
import { UpdateBannerRow } from '../update/UpdateBanner';
import { MiniBarDock } from '../minibar/MiniBarDock';
import { FormHost } from '../forms/FormHost';
import { SigBanner } from '../sigcheck/SigBanner';
import { useBannerWinner } from './bannerPriority';
import { BannerRow, XfaBannerRow } from './Banner';

/**
 * The banner slot (DESIGN v2 3.2): the row at the top of the canvas column, 0 high while nothing has to be said, so pages never sit
 * under it. One F6 stop for every banner (DESIGN 2.3); the banners stack in flow, and each brings its own height. Home has the same
 * slot above its body.
 */
export function BannerSlot() {
  const winner = useBannerWinner();
  return (
    <div data-region="banner" data-slot="banner" className="flex min-w-0 flex-col">
      <RedactBanner />
      <SigBanner />
      <FormHost />
      {/* The other notices queue behind the redact band and the form banner; they stay mounted, so nothing is lost. */}
      <div className={winner === 'other' ? 'flex min-w-0 flex-col' : 'hidden'}>
        <BannerRow />
        <RecoveryBanner />
        <XfaBannerRow />
        <DropBannerRow />
        <UpdateBannerRow />
      </div>
      {/* The second row: the properties mini bar docks here when neither side of the selection has room (DESIGN v2 3.3). */}
      <MiniBarDock />
    </div>
  );
}
