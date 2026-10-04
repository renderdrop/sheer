import { DropBannerRow } from '../jobs/JobsHost';
import { RecoveryBanner } from '../recovery/RecoveryBanner';
import { RedactBanner } from '../redact/RedactBanner';
import { UpdateBannerRow } from '../update/UpdateBanner';
import { FormHost } from '../forms/FormHost';
import { BannerRow, XfaBannerRow } from './Banner';

/**
 * The banner slot (DESIGN v2 3.2): the row at the top of the canvas column, 0 high while nothing has to be said, so pages never sit
 * under it. One F6 stop for every banner (DESIGN 2.3); the banners stack in flow, and each brings its own height. Home has the same
 * slot above its body.
 */
export function BannerSlot() {
  return (
    <div data-region="banner" data-slot="banner" className="flex min-w-0 flex-col">
      <BannerRow />
      <RecoveryBanner />
      <XfaBannerRow />
      <RedactBanner />
      <FormHost />
      <DropBannerRow />
      <UpdateBannerRow />
    </div>
  );
}
