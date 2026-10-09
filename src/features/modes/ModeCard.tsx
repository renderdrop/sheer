import { memo, useLayoutEffect } from 'react';

import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { ModeRow } from './ModeRow';
import { ToolRow } from './ToolRow';

/**
 * The mode card (DESIGN 3.18 E4): one contour on the chrome background (F20.9, F20.11), radius md at the bottom, no shadow, inset 12 left and
 * right. 106 in the grid row = 1 transparent top line + header 32 (the mode tabs, which draw the top of the contour themselves: the active
 * tab has a border on top and sides) + the framed tool area 72 + 1 bottom border. The frame has a border left, right and bottom only, so
 * the active tab and the frame never draw two lines on top of each other. It is the editor's "modes and tools" landmark.
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
      className="mx-(--chrome-gutter) flex h-mode-card min-w-0 flex-col bg-chrome pt-px"
    >
      <ModeRow />
      <div
        data-slot="mode-tool-frame"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-md border border-t-0 border-border-subtle"
      >
        <ToolRow />
      </div>
    </div>
  );
});
