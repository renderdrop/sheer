import { parseDate } from './model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const relative = new Map<string, Intl.RelativeTimeFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();

/**
 * The time of a comment as the card shows it (DESIGN 3.59): relative (`Intl.RelativeTimeFormat`) for less than seven days, else the
 * medium date; `''` for a time that cannot be read. A time in the future reads as now.
 */
export function relativeTime(text: string | null, locale: string, now: number): string {
  const time = parseDate(text);
  if (time === null) return '';
  try {
    const age = Math.max(0, now - time);
    if (age >= WEEK) {
      let format = dates.get(locale);
      if (format === undefined) {
        format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
        dates.set(locale, format);
      }
      return format.format(time);
    }
    let format = relative.get(locale);
    if (format === undefined) {
      format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      relative.set(locale, format);
    }
    if (age < MINUTE) return format.format(0, 'second');
    if (age < HOUR) return format.format(-Math.floor(age / MINUTE), 'minute');
    if (age < DAY) return format.format(-Math.floor(age / HOUR), 'hour');
    return format.format(-Math.floor(age / DAY), 'day');
  } catch {
    return '';
  }
}
