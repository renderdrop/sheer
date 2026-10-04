import { useT } from '../../i18n';
import { Button } from '../../components';
import { useUpdate } from './store';

/**
 * "Check for updates" in the About dialog (DESIGN 3.49): one explicit request, which is the consent for that single check, whatever the
 * Updates setting says. The result is read politely below; a build with the placeholder signing key says that updates are not configured.
 */
export function AboutUpdate() {
  const t = useT();
  const check = useUpdate((state) => state.check);
  const version = useUpdate((state) => state.info?.version ?? '');
  const message =
    check === 'checking'
      ? t('update.checking')
      : check === 'upToDate'
        ? t('update.upToDate')
        : check === 'available'
          ? t('update.available', { version })
          : check === 'failed'
            ? t('update.checkFailed')
            : check === 'unconfigured'
              ? t('update.unconfigured')
              : '';
  return (
    <>
      <Button variant="secondary" disabled={check === 'checking'} onClick={() => void useUpdate.getState().checkNow()}>
        {t('about.checkUpdates')}
      </Button>
      <p role="status" className={`m-0 w-full text-sm ${check === 'failed' ? 'text-error-text' : 'text-text-muted'}`}>
        {message}
      </p>
    </>
  );
}
