import { useState } from 'react';

import { openDefaultAppsSettings } from '../../api/app';
import type { AppError } from '../../api/errors';
import { Button } from '../../components';
import { APP_NAME } from '../../config/app';
import { errorText, useT } from '../../i18n';
import { useSettings } from '../../stores/settings';

/**
 * The default PDF app row: opens the OS page where the user picks the app (Windows only; macOS has no such page, so the row
 * is hidden there and wherever the platform is unknown). A failure is shown in an alert line. Not part of the settings panel
 * any more (DESIGN 3.6): the Hilfe menu hosts it.
 */
export function DefaultAppRow() {
  const t = useT();
  const platform = useSettings((state) => state.platform);
  const [error, setError] = useState<AppError | null>(null);
  if (platform !== 'windows') return null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setError(null);
          openDefaultAppsSettings().catch((e: AppError) => setError(e));
        }}
      >
        {t('settings.defaultApp.button', { app: APP_NAME })}
      </Button>
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-error-text">
          {errorText(t, error)}
        </p>
      )}
    </div>
  );
}
