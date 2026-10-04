import { motion, useReducedMotion } from 'motion/react';
import { memo, type KeyboardEvent } from 'react';

import { Tooltip } from '../../components';
import { cx } from '../../components/cx';
import { SPRING } from '../../components/motion';
import { isOwnEvent } from '../../components/roving';
import { useT } from '../../i18n';
import { MODES, useUi, type Mode } from '../../stores/ui';
import { keyOfMode, MODE_LABEL, modeAfterKey } from './model';
import { switchMode } from './switch';
import { useModeEffects } from './useModeEffects';

/** The id of the tool row, which the selected tab controls. */
export const TOOL_ROW_ID = 'mode-tool-row';

/** A text tab (DESIGN v2 2.8): Text-secondary 400, hover Ink, selected Ink 500 with the 2 px Solar underline; the focus ring is inset. */
const TAB =
  'relative flex h-full cursor-pointer items-center px-3 t-label text-text-muted transition-colors duration-fast ' +
  'hover:text-text aria-selected:font-medium aria-selected:text-text';

/** The underline slides to the new tab; with reduced motion it fades in on the new tab instead (no movement). */
function Underline() {
  const reduce = useReducedMotion() === true;
  return (
    <motion.span
      aria-hidden="true"
      data-mode-underline=""
      {...(reduce
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: SPRING.fast }
        : { layoutId: 'mode-underline', transition: SPRING.fast })}
      className="absolute inset-x-3 bottom-0 h-half bg-accent"
    />
  );
}

/**
 * The mode row (DESIGN v2 3.2, ADR-102): Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten as text tabs, 40 high. Left and
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
      className="bg-panel flex h-mode-row min-w-0 items-stretch gap-1 px-4"
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
              aria-selected={selected}
              aria-controls={TOOL_ROW_ID}
              aria-keyshortcuts={keyOfMode(id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => switchMode(id)}
              className={cx(TAB)}
            >
              {t(MODE_LABEL[id])}
              {selected && <Underline />}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
});
