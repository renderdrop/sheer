import { memo, type KeyboardEvent } from 'react';

import { Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { isOwnEvent } from '../../components/roving';
import { useT } from '../../i18n';
import { MODES, useUi, type Mode } from '../../stores/ui';
import { keyOfMode, MODE_LABEL, modeAfterKey } from './model';
import { switchMode } from './switch';
import { useModeEffects } from './useModeEffects';

/** The id of the tool row, which the selected tab controls. */
export const TOOL_ROW_ID = 'mode-tool-row';

/**
 * A segment of the control (DESIGN 3.5 B3): 28 high, radius sm, Text-secondary 400; hover Segment-hover and Ink; selected White with a
 * 1 px Stone border (3.47:1 on White) and Ink 500. The border is always there (transparent when not selected) so nothing shifts.
 */
const SEGMENT =
  'flex h-segment cursor-pointer items-center gap-0 whitespace-nowrap rounded-sm border border-transparent px-3 t-label text-text-muted ' +
  'transition-colors duration-fast hover:bg-segment-hover hover:text-text ' +
  'aria-selected:border-control-border aria-selected:bg-panel aria-selected:font-medium aria-selected:text-text ' +
  'aria-selected:hover:bg-panel';

/**
 * The mode row (DESIGN v2 3.2, ADR-102): Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten as a segmented control (DESIGN 3.5 B3) on the Sand bar it shares with the tool row, 40 high. Left and
 * Right, Home and End move and activate (roving); Tab goes on to the tool row. The keys 1 to 5 work from anywhere
 * (`useModeEffects`). A switch releases the tool to Auswahl.
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
      className="bg-subtle flex h-mode-row min-w-0 items-center px-4"
    >
      <div className="flex h-control-sm min-w-0 items-center gap-[calc(var(--space-1)/2)] rounded-md p-[calc(var(--space-1)/2)] shadow-(--segment-track-edge)">
        {MODES.map((id: Mode) => {
          const selected = id === mode;
          return (
            <Tooltip key={id} label={t(MODE_LABEL[id])} shortcut={keyOfMode(id)}>
              <button
                type="button"
                role="tab"
                id={`mode-tab-${id}`}
                data-mode={id}
                aria-selected={selected}
                aria-controls={TOOL_ROW_ID}
                aria-keyshortcuts={keyOfMode(id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => switchMode(id)}
                className={cx(SEGMENT)}
              >
                {t(MODE_LABEL[id])}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});
