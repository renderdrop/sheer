import { memo, useLayoutEffect } from 'react';

import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { ToolRow } from './ToolRow';

/**
 * The tool card (DESIGN 3.18 E4, F21.9): one framed strip of the tools of all five modes on the chrome background, inset 12 left and
 * right, radius md, 1 px `--border-subtle`, no shadow and no tab header. 72 in the grid row (96 with "Show labels") = the 1 px
 * border around the tool strip. It is the editor's "modes and tools" landmark.
 */
export const ModeCard = memo(function ModeCard() {
  const t = useT();
  const labels = useSettings((state) => state.showToolLabels === true);
  // The one token `--mode-card-height` has two values; the root attribute picks one, so the grid follows at once.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.toolLabels = labels ? 'on' : 'off';
    return () => {
      delete root.dataset.toolLabels;
    };
  }, [labels]);
  return (
    <div
      role="region"
      aria-label={t('modes.region')}
      data-slot="mode-card"
      className="mx-(--chrome-gutter) flex h-mode-card min-w-0 flex-col bg-chrome"
    >
      <div
        data-slot="mode-tool-frame"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border-subtle"
      >
        <ToolRow />
      </div>
    </div>
  );
});
