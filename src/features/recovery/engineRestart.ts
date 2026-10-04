import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';

/** Longest list of names in the toast; the rest is counted. */
const NAMES_MAX = 3;

/**
 * The engine process restarted (ADR-053 section 1): say so once, calmly. Documents that could not be brought back are named from
 * the open tabs; reopening needs the file, which the window never holds, so the tab stays for the user to reopen it with Open.
 */
export function announceEngineRestart(lost: readonly number[]): void {
  const t = translators[useLocaleStore.getState().locale];
  const { byId } = useDocuments.getState();
  const names = lost
    .map((id) => byId[id]?.displayName)
    .filter((name): name is string => name !== undefined && name !== '');
  const shown = names.slice(0, NAMES_MAX).join(', ');
  const rest = names.length - NAMES_MAX;
  const list = rest > 0 ? `${shown} +${rest}` : shown;
  useUi.getState().showToast({
    message: names.length === 0 ? t('engine.restarted') : t('engine.restartedLost', { names: list }),
  });
}
