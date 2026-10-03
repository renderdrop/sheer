/**
 * The date of an annotation (`Annotation.modified`): ISO 8601 for what was changed in this session, a PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`,
 * every part after the year optional) for what the file says. `null` for anything else; a file may hold any text there.
 */
const PDF_DATE = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(?:(\d{2})'?)?)?/;

export function parseAnnotationDate(text: string | null): Date | null {
  if (text === null) return null;
  const pdf = PDF_DATE.exec(text);
  if (pdf !== null) {
    const [, year, month, day, hour, minute, second, , sign, offsetHour, offsetMinute] = pdf;
    const utc = Date.UTC(
      Number(year),
      Number(month ?? '01') - 1,
      Number(day ?? '01'),
      Number(hour ?? '0'),
      Number(minute ?? '0'),
      Number(second ?? '0'),
    );
    const offset =
      sign === undefined
        ? 0
        : (sign === '-' ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute ?? '0')) * 60_000;
    const date = new Date(utc - offset);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = new Date(text);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/** "Oct 3, 2026, 2:05 PM" in the UI's language (medium date, short time); empty when there is no usable date. */
export function formatAnnotationDate(text: string | null, locale: string): string {
  const date = parseAnnotationDate(text);
  if (date === null) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return '';
  }
}
