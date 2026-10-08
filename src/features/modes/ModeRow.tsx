import { memo, type KeyboardEvent } from 'react';

import { Tooltip } from '../../components';
import { isOwnEvent } from '../../components/roving';
import { useT } from '../../i18n';
import { MODES, useUi, type Mode } from '../../stores/ui';
import { keyOfMode, MODE_LABEL, modeAfterKey } from './model';
import { switchMode } from './switch';
import { useModeEffects } from './useModeEffects';

/** The id of the tool row, which the selected tab controls. */
export const TOOL_ROW_ID = 'mode-tool-row';

/**
 * A mode tab as a file-tab register (DESIGN 3.18 E4): 32 high, padding-x 16, 14/20. Inactive: transparent, Text-secondary 400, Ink on
 * hover. Active: Sand with a 1 px border left, top and right, top radius sm and -1 px at the bottom so it merges into the Sand tool area.
 * The border is always there (transparent when inactive) so nothing shifts.
 */
const TAB =
  'group relative flex h-mode-tab -mb-px cursor-pointer items-center whitespace-nowrap rounded-t-sm border border-b-0 border-transparent px-4 text-md text-text-muted ' +
  'transition-colors duration-fast hover:text-text ' +
  'aria-selected:border-border-subtle aria-selected:bg-subtle aria-selected:font-medium aria-selected:text-text';

/** The key chip (1 to 5): always on the active tab, on the others at hover and focus. */
const CHIP =
  'ms-2 hidden h-kbd min-w-kbd items-center justify-center rounded-sm border border-border-subtle bg-panel px-1 text-xs font-medium tabular-nums text-text-muted ' +
  'group-hover:inline-flex group-focus-visible:inline-flex group-aria-selected:inline-flex';

/**
 * The header of the mode card (DESIGN 3.18 E4, ADR-102): Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten as file-tab
 * registers, 32 high. Left and Right, Home and End move and activate (roving); Tab goes on to the tool area. The keys 1 to 5 work
 * from anywhere (`useModeEffects`). A switch releases the tool to Auswahl and closes the tool inspector.
 */
export const ModeRow = memo(function ModeRow() {
  const t = useT();
  const mode = useUi((state) => state.mode);
  useModeEffects();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isOwnEvent(event.currentTarget, event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = modeAfterKey(mode, event.key);
    if (next === null) return;
    event.preventDefault();
    switchMode(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t('modes.label')}
      aria-orientation="horizontal"
      data-slot="mode-row"
      onKeyDown={onKeyDown}
      className="flex h-mode-tab min-w-0 items-end border-b border-border-subtle bg-panel px-1"
    >
      {MODES.map((id: Mode) => {
        const selected = id === mode;
        return (
          <Tooltip key={id} label={t(MODE_LABEL[id])} shortcut={keyOfMode(id)}>
            <button
              type="button"
              role="tab"
              id={`mode-tab-${id}`}
              data-mode={id}
              data-tour-anchor={id === 'comment' || id === 'fill' ? `mode-${id}` : undefined}
              aria-selected={selected}
              aria-controls={TOOL_ROW_ID}
              aria-keyshortcuts={keyOfMode(id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => switchMode(id)}
              className={TAB}
            >
              {t(MODE_LABEL[id])}
              <span aria-hidden="true" data-key-chip="" className={CHIP}>
                {keyOfMode(id)}
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
});
