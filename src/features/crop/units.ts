import type { Locale } from '../../i18n';

/** The unit the margin fields show (DESIGN 3.37): millimetres where the metric system is used, inches elsewhere. */
export type Unit = 'mm' | 'in';

const MM_PER_PT = 25.4 / 72;
const PT_PER_IN = 72;

/** Unit by locale: the German UI is metric, the English one imperial (the backend exposes no OS measurement system yet).
 * v1.1: follow the OS measurement system instead of the UI locale. */
export function unitFor(locale: Locale): Unit {
  return locale === 'de' ? 'mm' : 'in';
}

/** One arrow-key step of a field, in the field's unit (0.5 mm, 0.02 in). */
export const STEP: Record<Unit, number> = { mm: 0.5, in: 0.02 };

export function ptToUnit(pt: number, unit: Unit): number {
  return unit === 'mm' ? pt * MM_PER_PT : pt / PT_PER_IN;
}

export function unitToPt(value: number, unit: Unit): number {
  return unit === 'mm' ? value / MM_PER_PT : value * PT_PER_IN;
}

/** The text of a margin in a field, in `locale`'s number format. */
export function formatMargin(pt: number, unit: Unit, locale: Locale): string {
  const digits = unit === 'mm' ? 1 : 2;
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, useGrouping: false });
  return format.format(ptToUnit(pt, unit));
}

/** A margin typed into a field, in points; a decimal point or comma both work. `null` for text that is not a non-negative number. */
export function parseMargin(text: string, unit: Unit): number | null {
  const clean = text.trim().replace(',', '.');
  if (!/^\d{0,6}(\.\d{0,4})?$/.test(clean) || clean === '' || clean === '.') return null;
  const value = Number(clean);
  return Number.isFinite(value) ? unitToPt(value, unit) : null;
}
