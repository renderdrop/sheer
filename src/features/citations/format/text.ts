import type { BibRecord, Person, Run } from '../../../api/citations';

/** The languages of the terms ("p."/"S."); the UI language. */
export type Lang = 'en' | 'de';

/** A piece of a sentence in italics. */
export interface Ital {
  readonly it: string;
}
export const i = (it: string): Ital => ({ it });

/** A sentence part: text, italic text, a list of parts, or nothing (empty parts drop out with their separators). */
export type Part = string | Ital | readonly Part[] | null | undefined | false;

function isItal(part: Part): part is Ital {
  return typeof part === 'object' && part !== null && !Array.isArray(part) && 'it' in part;
}

export function textOf(part: Part): string {
  if (part === null || part === undefined || part === false) return '';
  if (typeof part === 'string') return part;
  if (isItal(part)) return part.it;
  return (part as readonly Part[]).map(textOf).join('');
}

/** Joins the parts that have text with `sep`. */
export function j(sep: string, ...parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    if (textOf(part) === '') continue;
    if (out.length > 0) out.push(sep);
    out.push(part);
  }
  return out;
}

/** A sentence; `stop` adds the full stop (a link at the end of an entry has none in some styles). */
export interface Sent {
  parts: Part[];
  stop: boolean;
}
export const S = (...parts: Part[]): Sent => ({ parts, stop: true });
export const L = (...parts: Part[]): Sent => ({ parts, stop: false });

const CLOSERS = /["'“”‘’„‚»«]+$/u;

/** Collects runs of two faces; adjacent runs of the same face merge. */
export class Out {
  readonly runs: Run[] = [];

  add(text: string, italic = false): this {
    if (text === '') return this;
    const last = this.runs[this.runs.length - 1];
    if (last !== undefined && last.italic === italic) {
      this.runs[this.runs.length - 1] = { text: last.text + text, italic };
    } else {
      this.runs.push({ text, italic });
    }
    return this;
  }

  addPart(part: Part): this {
    if (part === null || part === undefined || part === false) return this;
    if (typeof part === 'string') return this.add(part);
    if (isItal(part)) return this.add(part.it, true);
    for (const inner of part as readonly Part[]) this.addPart(inner);
    return this;
  }

  get text(): string {
    return this.runs.map((run) => run.text).join('');
  }

  /** Ends the sentence with a full stop unless it ends with one (also before closing quotation marks). */
  stop(): this {
    const text = this.text.replace(/\s+$/u, '');
    if (text === '') return this;
    const core = text.replace(CLOSERS, '');
    if (!/[.?!…]$/u.test(core === '' ? text : core)) this.add('.');
    return this;
  }
}

/** Renders sentences as runs, separated by one space. Empty sentences drop out. */
export function render(sentences: readonly Sent[]): Run[] {
  const out = new Out();
  for (const sentence of sentences) {
    if (textOf(sentence.parts) === '') continue;
    if (out.runs.length > 0) out.add(' ');
    out.addPart(sentence.parts);
    if (sentence.stop) out.stop();
  }
  return out.runs;
}

/** At most 4 000 characters per run and 64 runs (the export limits); longer text is cut with an ellipsis. */
export function fitRuns(runs: readonly Run[], runMax = 4_000, runsMax = 64): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    let rest = run.text;
    while (rest.length > 0) {
      let cut = Math.min(rest.length, runMax);
      const code = rest.charCodeAt(cut - 1);
      if (cut < rest.length && code >= 0xd800 && code <= 0xdbff) cut -= 1;
      out.push({ text: rest.slice(0, cut), italic: run.italic });
      rest = rest.slice(cut);
    }
  }
  if (out.length <= runsMax) return out;
  const kept = out.slice(0, runsMax);
  const last = kept[runsMax - 1] as Run;
  kept[runsMax - 1] = { text: `${last.text.slice(0, runMax - 1)}…`, italic: last.italic };
  return kept;
}

export const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/gu, ' ').trim();

/** The people with a name; an entry with neither part is dropped. */
export function peopleOf(record: BibRecord): Person[] {
  return record.authors
    .map((p) => ({ family: clean(p.family), given: clean(p.given) }))
    .filter((p) => p.family !== '' || p.given !== '');
}

export const isOrg = (p: Person): boolean => p.given === '' || p.family === '';

/** "Anna Maria" -> "A. M."; "Jean-Paul" -> "J.-P."; tokens that are initials already stay. */
export function initials(given: string): string {
  return given
    .split(/\s+/u)
    .filter((token) => token !== '')
    .map((token) =>
      token
        .split('-')
        .filter((piece) => piece !== '')
        .map((piece) => (/\.$/u.test(piece) ? piece : `${Array.from(piece)[0] ?? ''}.`))
        .join('-'),
    )
    .join(' ');
}

/** The name that stands for an author: the family name, or the one word of an organisation. */
export const familyOf = (p: Person): string => (p.family !== '' ? p.family : p.given);

/** "Family, Given"; an organisation is its name. */
export const inverted = (p: Person): string => (isOrg(p) ? familyOf(p) : `${p.family}, ${p.given}`);
/** "Given Family". */
export const natural = (p: Person): string => (isOrg(p) ? familyOf(p) : `${p.given} ${p.family}`);
/** "Family, G. G.". */
export const abbreviated = (p: Person): string => (isOrg(p) ? familyOf(p) : `${p.family}, ${initials(p.given)}`);

/** "12-13" -> "12–13". */
export function normalisePages(pages: string): string {
  return clean(pages).replace(/(\d)\s*[-—]\s*(\d)/gu, '$1–$2');
}

/** Whether a locator or page field names more than one page. */
export const isRange = (pages: string): boolean => /\d\s*[-–—]\s*\d|[–—,]/u.test(pages);

const MONTHS: Record<Lang, readonly string[]> = {
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  de: [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ],
};

/** A `YYYY-MM-DD` date as "May 3, 2021" (`mdy`), "3 May 2021" (`dmy`) or kept (`iso`); anything else stays as it is. */
export function formatDate(value: string, lang: Lang, form: 'mdy' | 'dmy' | 'iso'): string {
  const text = clean(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (m === null || form === 'iso') return text;
  const month = MONTHS[lang][Number(m[2]) - 1];
  if (month === undefined) return text;
  const day = Number(m[3]);
  if (lang === 'de') return `${day}. ${month} ${m[1]}`;
  return form === 'mdy' ? `${month} ${day}, ${m[1]}` : `${day} ${month} ${m[1]}`;
}

/** "2" -> "2nd ed." / "2. Aufl."; first editions are not named; other text gets the word. */
export function editionOf(edition: string | null, lang: Lang): string {
  const text = clean(edition);
  if (text === '' || /^(1|1st|1\.)$/iu.test(text)) return '';
  if (/^\d+\.?$/u.test(text)) {
    const n = Number.parseInt(text, 10);
    if (lang === 'de') return `${n}. Aufl.`;
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
    return `${n}${suffix} ed.`;
  }
  if (/(?:ed|aufl)\.?$/iu.test(text)) return text;
  return lang === 'de' ? `${text} Aufl.` : `${text} ed.`;
}

export const QUOTES: Record<Lang, readonly [string, string]> = {
  en: ['“', '”'],
  de: ['„', '“'],
};

/** Text in the language's quotation marks. */
export const quote = (text: string, lang: Lang): string => `${QUOTES[lang][0]}${text}${QUOTES[lang][1]}`;

/** A title in quotation marks with its full stop inside (the sentence adds none after it). */
export function quotedTitle(title: string, lang: Lang): string {
  const closed = /[.?!…]$/u.test(title) ? title : `${title}.`;
  return quote(closed, lang);
}
