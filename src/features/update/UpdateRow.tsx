import { CircleAlert } from 'lucide-react';

import { Button } from '../../components';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { SegmentedControl } from '../settings/SegmentedControl';
import { useUpdate } from './store';

/**
 * The Updates row of the settings popover (DESIGN 3.49): Off (the default) or On over a hint that names GitHub and what it sees.
 * Switching On checks at once; while On a status line (`role=status`) and "Check now" follow. An unconfigured build says nothing here
 * (About tells it).
 */
export function UpdateRow({ labelId }: { labelId: string }) {
  const t = useT();
  const mode = useSettings((state) => state.updates ?? 'off');
  const check = useUpdate((state) => state.check);
  const choose = (next: 'off' | 'on') => {
    void useSettings.getState().update({ updates: next });
    if (next === 'on') void useUpdate.getState().checkNow();
  };
  const status =
    check === 'checking'
      ? t('update.checking')
      : check === 'upToDate'
        ? t('update.upToDate')
        : check === 'available'
          ? t('update.foundNewer')
          : check === 'failed'
            ? t('update.checkFailed')
            : '';
  return (
    <>
      <SegmentedControl
        labelledBy={labelId}
        value={mode}
        options={[
          { value: 'off', label: t('settings.updates.off') },
          { value: 'on', label: t('settings.updates.on') },
        ]}
        onChange={choose}
      />
      {mode === 'on' && (
        <div className="flex items-center gap-2">
          <span
            role="status"
            className={`flex min-w-0 flex-auto items-center gap-2 text-sm ${check === 'failed' ? 'text-error-text' : 'text-text-muted'}`}
          >
            {check === 'failed' && <Icon icon={CircleAlert} size={12} />}
            {status}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={check === 'checking'}
            onClick={() => void useUpdate.getState().checkNow()}
          >
            {t('update.checkNow')}
          </Button>
        </div>
      )}
    </>
  );
}
