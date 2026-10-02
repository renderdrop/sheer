import type { CSSProperties } from 'react';

import { shortcutFor } from '../../actions/registry';
import type { Platform } from '../../api/app';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';
import { useViewer } from '../viewer/useViewer';
import { EmptyState } from './EmptyState';

/**
 * The empty state in the main row's only slot, with what it needs from the stores: whether a document is being opened
 * and whether a file is dragged over the window. It subscribes to those itself, so the shell does not.
 */
export function EmptyStateSlot({ platform, style }: { platform: Platform | null; style?: CSSProperties }) {
  const opening = useViewer((state) => state.opening);
  const open = useViewer((state) => state.open);
  const dropActive = useUi((state) => state.dropHover);
  const t = useT();
  const openKey = shortcutFor('open', platform, t);
  return (
    <div style={style} className="flex min-h-0 min-w-0 overflow-auto p-1">
      <EmptyState
        openShortcut={openKey?.label ?? ''}
        openKeyShortcuts={openKey?.aria ?? ''}
        opening={opening}
        onOpen={() => void open()}
        dropActive={dropActive}
      />
    </div>
  );
}
