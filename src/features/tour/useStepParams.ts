import { useMemo } from 'react';

import { useSettings } from '../../stores/settings';
import { modifierLabel } from '../../lib/shortcuts';
import { useT } from '../../i18n';

/** The values the step texts take beyond `steps.json`: `{mod}`, the platform's primary modifier ("Ctrl" or "Cmd"). */
export function useStepParams(): { mod: string } {
  const t = useT();
  const platform = useSettings((state) => state.platform);
  return useMemo(() => ({ mod: modifierLabel(platform, 'primary', t) }), [platform, t]);
}
