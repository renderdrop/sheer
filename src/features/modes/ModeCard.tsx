import { memo } from 'react';

import { useT } from '../../i18n';
import { ModeRow } from './ModeRow';
import { ToolRow } from './ToolRow';

/**
 * The mode card (DESIGN 3.18 E4): one White card, `--border-subtle`, radius md, no shadow, 104 inside = header 32 (the mode tabs) +
 * tool area 72 (+ 2 border = 106 in the grid row), inset 12 left and right. It is the editor's "modes and tools" landmark.
 */
export const ModeCard = memo(function ModeCard() {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t('modes.region')}
      data-slot="mode-card"
      className="mx-(--chrome-gutter) flex h-mode-card min-w-0 flex-col overflow-hidden rounded-md border border-border-subtle bg-panel"
    >
      <ModeRow />
      <ToolRow />
    </div>
  );
});
