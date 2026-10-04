import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import type { ActionId } from '../../actions/registry';
import type { PlainKey } from '../../i18n';
import type { CreationKind } from '../../stores/tools';
import { MODES, type Mode } from '../../stores/ui';

/**
 * The mode row and the tool row (DESIGN v2 3.2, ADR-102, FEEDBACK F14): which modes exist, what a tool-row slot is, and the pure
 * rules of the row (the keys 1 to 5, the three-step overflow). No DOM and no store here, so the rules are testable alone.
 */

/** The catalog name of each mode, in tab order (Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten). */
export const MODE_LABEL: Readonly<Record<Mode, PlainKey>> = {
  read: 'modes.read',
  comment: 'modes.comment',
  fill: 'modes.fill',
  pages: 'modes.pages',
  edit: 'modes.edit',
};

/** The mode a digit key stands for: 1 to 5 in tab order; any other key is none. */
export function modeOfKey(key: string): Mode | null {
  if (!/^[1-5]$/.test(key)) return null;
  return MODES[Number(key) - 1] ?? null;
}

/** The key of a mode: its position in the tab order, from 1. */
export const keyOfMode = (mode: Mode): string => String(MODES.indexOf(mode) + 1);

/** The mode that Left, Right, Home or End moves to from `current` (wrapping), or `null` for another key. */
export function modeAfterKey(current: Mode, key: string): Mode | null {
  const at = MODES.indexOf(current);
  const last = MODES.length - 1;
  switch (key) {
    case 'ArrowLeft':
      return MODES[at <= 0 ? last : at - 1] ?? null;
    case 'ArrowRight':
      return MODES[at >= last ? 0 : at + 1] ?? null;
    case 'Home':
      return MODES[0] ?? null;
    case 'End':
      return MODES[last] ?? null;
    default:
      return null;
  }
}

/** An entry of a slot's variant menu (a rotation direction, a saved signature, a shape). */
export interface VariantDef {
  id: string;
  label: string;
  icon: LucideIcon;
  /** A decorative element in the icon's place (a signature preview). */
  leading?: ReactNode;
  /** Shown as chosen. */
  on?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** Which annotation kinds a colour tool's swatch row sets: one for most, the four shapes for Formen. */
export interface ColourDef {
  kinds: readonly CreationKind[];
}

/**
 * One slot of the tool row. `tool` stays active until Esc or Auswahl (ADR-056); `action` runs once and is never active.
 * The main part runs `run`; a slot with `variants` and/or `colour` also has the 20-wide chevron part.
 */
export interface SlotDef {
  /** Also the `data-toolbar-item` (the tour and the smoke tests find the item by it). */
  id: string;
  label: string;
  icon: LucideIcon;
  kind: 'tool' | 'action';
  /** The tool is the active one. */
  on: boolean;
  /** Why it cannot be used now (the tooltip says so); it stays focusable. */
  disabledReason?: string;
  /** A tooltip line: the key to hold, a hint. */
  hint?: string;
  /** The registry action whose shortcut the tooltip shows. */
  actionId?: ActionId;
  variants?: readonly VariantDef[];
  colour?: ColourDef;
  /** The chevron menu ends with the shape recognition switch (Zeichnen, DESIGN 3.5 B11). */
  recogniseSwitch?: boolean;
  /** The tool's own options (Zuschneiden, the insert tools, Schwärzen): the chevron part opens them while the tool is on. */
  Options?: ComponentType;
  run: () => void;
}

/** The three steps of the overflow (DESIGN v2 3.2): all labels, the inactive items icon-only, items leaving into "Mehr". */
export type FitStep = 1 | 2 | 3;

export interface Fit {
  step: FitStep;
  /** Step 3: how many items have left, from the right (never the active tool). */
  hidden: number;
}

export const FIT_START: Fit = { step: 1, hidden: 0 };

/**
 * The next, tighter fit when the row still overflows, or `null` when nothing is left to give up. `movable` is the number of items
 * that may leave (all but the active tool).
 */
export function tighter(fit: Fit, movable: number): Fit | null {
  if (fit.step === 1) return { step: 2, hidden: 0 };
  if (fit.step === 2) return movable > 0 ? { step: 3, hidden: 1 } : null;
  return fit.hidden < movable ? { step: 3, hidden: fit.hidden + 1 } : null;
}

/** The ids that left into "Mehr": `hidden` items from the right, skipping the active tool. */
export function hiddenIds(ids: readonly string[], activeId: string | null, hidden: number): ReadonlySet<string> {
  const out = new Set<string>();
  for (let index = ids.length - 1; index >= 0 && out.size < hidden; index -= 1) {
    const id = ids[index];
    if (id !== undefined && id !== activeId) out.add(id);
  }
  return out;
}
