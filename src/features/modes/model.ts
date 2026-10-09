import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import type { ActionId } from '../../actions/registry';
import type { PlainKey } from '../../i18n';
import type { CreationKind } from '../../stores/tools';
import type { Mode } from '../../stores/ui';

/**
 * The mode row and the tool row (DESIGN v2 3.2, ADR-102, FEEDBACK F14): which modes exist, what a tool-row slot is, and the pure
 * rules of the row (the three-step fit). No DOM and no store here, so the rules are testable alone.
 */

/** The catalog name of each mode, in tab order (Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten). */
export const MODE_LABEL: Readonly<Record<Mode, PlainKey>> = {
  read: 'modes.read',
  comment: 'modes.comment',
  fill: 'modes.fill',
  pages: 'modes.pages',
  edit: 'modes.edit',
};

/** An entry of a slot's variant menu (a rotation direction, a saved signature, a shape). */
export interface VariantDef {
  id: string;
  label: string;
  /** None: the check column of a radio variant is its marker. */
  icon?: LucideIcon;
  /** A decorative element in the icon's place (a signature preview). */
  leading?: ReactNode;
  /** Shown as chosen. */
  on?: boolean;
  /** One of an exclusive group: the menu item is a `menuitemradio` with `aria-checked` even when it is off. */
  radio?: boolean;
  /** A second line under the label (Text-secondary). */
  caption?: string;
  disabled?: boolean;
  run: () => void;
}

/** Which annotation kinds a colour tool's swatch row sets: one for most, the four shapes for Formen. */
export interface ColourDef {
  kinds: readonly CreationKind[];
  /** The row's own name where it differs from "Colour" (the note colour in the Notiz/Stempel split). */
  label?: string;
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
  kind: 'tool' | 'action' | 'toggle';
  /** The tool is the active one. */
  on: boolean;
  /** Why it cannot be used now (the tooltip says so); it stays focusable. */
  disabledReason?: string;
  /** A `data-testid` for the main part (smoke tests of tools that name one). */
  testId?: string;
  /** A tooltip line: the key to hold, a hint. */
  hint?: string;
  /** The registry action whose shortcut the tooltip shows. */
  actionId?: ActionId;
  variants?: readonly VariantDef[];
  colour?: ColourDef;
  /** The tool's own options (Zuschneiden, the insert tools, Schwärzen): the chevron part opens them while the tool is on. */
  Options?: ComponentType;
  /**
   * The click that turns the tool on does not open its options; a click while it is on does (Schwärzen, F19.8): the options popover
   * takes the focus and covers the top of the page, where the first marks are drawn.
   */
  optionsWhenOn?: boolean;
  /** A thin separator stands before this slot (the mode table of DESIGN 3.18 E4 groups the slots). */
  separatorBefore?: boolean;
  run: () => void;
}

/** Window width below which the card shows icons only (DESIGN 3.18 E4). */
export const COMPACT_BELOW = 1100;

/** Groups of slots as one list: the first slot of every group after the first gets a separator before it. */
export function grouped(...groups: readonly (readonly SlotDef[])[]): SlotDef[] {
  return groups.flatMap((group, index) =>
    group.map((slot, at) => (index > 0 && at === 0 ? { ...slot, separatorBefore: true } : slot)),
  );
}

/**
 * The three steps of the fit (DESIGN 3.18 E4, F22.3): 1. as set (labels when "Show labels" is on, else the 36 squares),
 * 2. every item a 32 square, 3. whole groups wrap onto a further line.
 */
export type FitStep = 1 | 2 | 3;

export interface Fit {
  step: FitStep;
}

export const FIT_START: Fit = { step: 1 };

/** The next, tighter fit when the row still overflows, or `null` when nothing is left to give up. */
export function tighter(fit: Fit): Fit | null {
  if (fit.step === 1) return { step: 2 };
  if (fit.step === 2) return { step: 3 };
  return null;
}

/** DESIGN Q6: the row returns to a wider step only when it is this much wider than the full row needs (no flicker). */
export const FIT_HYSTERESIS = 8;

/**
 * The fit after the row's width changed from `previous` to `width`. `need` is the measured width of the row at step 1 (null while
 * unknown). A row at a tighter step goes back to step 1 only when `width >= need + 8`; a growing wrapped row gives the wrap back
 * (step 2, re-measured before the next paint); a shrinking row keeps its fit (the measurement tightens it if it still overflows).
 */
export function fitOnResize(fit: Fit, need: number | null, width: number, previous: number): Fit {
  if (fit.step === 1) return fit;
  if (need !== null && width >= need + FIT_HYSTERESIS) return FIT_START;
  if (fit.step === 3 && width > previous) return { step: 2 };
  return fit;
}
