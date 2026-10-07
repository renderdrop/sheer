import type { BibRecord, Person, Run, StyledBlock } from '../../../api/citations';
import { withTerm } from './shared';
import { TERMS } from './terms';
import {
  clean,
  editionOf,
  familyOf,
  i,
  inverted,
  j,
  L,
  peopleOf,
  quote,
  render,
  S,
  type Lang,
  type Sent,
} from './text';

/**
 * Deutsche Zitierweise (ADR-139 section 3 (4), DESIGN 3.17, ARCHITECTURE 16.4): the full reference in the first footnote of a
 * source, a short reference after that, the bibliography entry without a locator. No "ebd." (decision). Pure; never throws.
 */

const WORDS: Record<
  Lang,
  { no: string; here: string; accessed: string; noPlace: string; notes: string; bibliography: string; etAl: string }
> = {
  de: {
    no: 'H.',
    here: 'hier',
    accessed: 'Zugriff am',
    noPlace: 'o. O.',
    notes: 'Fußnoten',
    bibliography: 'Literaturverzeichnis',
    etAl: 'u. a.',
  },
  en: {
    no: TERMS.en.no,
    here: 'here',
    accessed: 'accessed',
    noPlace: 'n.p.',
    notes: 'Notes',
    bibliography: 'Bibliography',
    etAl: 'et al.',
  },
};

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** 12 -> "¹²". */
export function superscript(n: number): string {
  return String(n)
    .split('')
    .map((digit) => SUPERSCRIPT[Number(digit)] ?? digit)
    .join('');
}

/** "Family, Given" joined with "/"; more than three authors: the first and "u. a.". */
function authorsOf(people: readonly Person[], lang: Lang): string {
  const [first] = people;
  if (first === undefined) return '';
  if (people.length > 3) return `${inverted(first)} ${WORDS[lang].etAl}`;
  return people.map(inverted).join('/');
}

/** The title up to its first ":", ".", "?", "!" or " – ", cut to 4 words. */
export function kurztitel(title: string | null | undefined): string {
  const text = clean(title);
  const cut = text.search(/[:.?!]|\s[–]\s/u);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trim();
  return head.split(' ').filter(Boolean).slice(0, 4).join(' ');
}

/** The short title of a record: the user's `shortTitle` when set, else derived from the title. */
function shortTitleOf(record: BibRecord): string {
  return clean(record.shortTitle) || kurztitel(record.title);
}

/** `YYYY-MM-DD` as "05.10.2026" (de) or "5 October 2026" (en); other text stays. */
function accessDate(value: string, lang: Lang): string {
  const text = clean(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (m === null) return text;
  const [, year = '', month = '', day = ''] = m;
  if (lang === 'de') return `${day}.${month}.${year}`;
  const name = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, 1)),
  );
  return `${Number(day)} ${name} ${year}`;
}

/** The short note: "Müller, Kurztitel, S. 14" ("Müller/Schmidt", "Müller u. a."); without a stop. */
export function shortNote(record: BibRecord, locator: string, lang: Lang): string {
  const people = peopleOf(record);
  const [first, second] = people;
  const who =
    first === undefined
      ? ''
      : second === undefined
        ? familyOf(first)
        : people.length === 2
          ? `${familyOf(first)}/${familyOf(second)}`
          : `${familyOf(first)} ${WORDS[lang].etAl}`;
  return [who, shortTitleOf(record), withTerm(locator, lang)].filter((part) => part !== '').join(', ');
}

/** The reference with an optional locator: the bibliography entry (`locator` empty) or the full note. */
function fullRuns(record: BibRecord, locator: string, lang: Lang): Run[] {
  const terms = TERMS[lang];
  const words = WORDS[lang];
  const people = peopleOf(record);
  const authors = authorsOf(people, lang);
  const title = clean(record.title);
  const year = clean(record.year) || terms.nd;
  const container = clean(record.containerTitle);
  const edition = editionOf(record.edition, lang);
  const place = clean(record.place) || words.noPlace;
  const publisher = clean(record.publisher);
  const pagesTerm = withTerm(record.pages ?? '', lang);
  const loc = withTerm(locator, lang);
  const lead = authors !== '' && title !== '' ? `${authors}: ` : authors;
  const imprint = j(': ', place, publisher);
  const hier = loc === '' ? '' : pagesTerm === '' ? loc : `${words.here} ${loc}`;
  const url = clean(record.url);
  const doi = clean(record.doi)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '');
  const accessed = clean(record.accessed);

  let body: Sent[];
  switch (record.kind) {
    case 'book':
      body = [S(lead, i(title)), S(edition), S(j(', ', imprint, year, loc))];
      break;
    case 'article': {
      const volume = clean(record.volume);
      const issue = clean(record.issue);
      body = [
        S(lead, title),
        S(
          container !== '' && ['In: ', i(container), volume !== '' && ` ${volume}`],
          container !== '' ? ` (${year})` : `(${year})`,
          issue !== '' && `, ${words.no} ${issue}`,
          pagesTerm !== '' && `, ${pagesTerm}`,
          hier !== '' && `, ${hier}`,
        ),
      ];
      break;
    }
    case 'chapter':
      body = [
        S(lead, title),
        S(container !== '' && ['In: ', i(container)]),
        S(edition),
        S(j(', ', imprint, year, pagesTerm, hier)),
      ];
      break;
    case 'report':
    case 'thesis':
      body = [S(lead, i(title)), S(j(', ', imprint, year, loc))];
      break;
    case 'webPage':
      body = [S(lead, title), S(j(', ', container !== '' && ['In: ', container], year, loc))];
      break;
  }
  const link: Sent[] = [];
  if (url !== '') {
    const when = accessed === '' ? '' : ` (${words.accessed} ${accessDate(accessed, lang)})`;
    link.push(when === '' ? L(`URL: ${url}`) : S(`URL: ${url}${when}`));
  }
  if (doi !== '') link.push(L(`DOI: ${doi}`));
  return render([...body, ...link]);
}

/** The bibliography entry: the reference without a locator. */
export function germanReference(record: BibRecord, lang: Lang): Run[] {
  return fullRuns(record, '', lang);
}

/** The full note of a first mention, with its full stop. */
export function fullNote(record: BibRecord, locator: string, lang: Lang): Run[] {
  return fullRuns(record, locator, lang);
}

/** One entry of the list: the quote (empty for none) and the joined locator. */
export interface GermanEntry {
  quote: string;
  locator: string;
}

const withStop = (text: string): string => (/[.?!…]$/u.test(text) ? text : `${text}.`);

/**
 * The list: the entries (quote and note mark), the notes heading and notes (the first full, the rest short), the bibliography heading
 * and the entry. Notes and marks carry their number; Rust writes them per file format.
 */
export function germanList(record: BibRecord, entries: readonly GermanEntry[], lang: Lang): StyledBlock[] {
  const blocks: StyledBlock[] = [];
  entries.forEach((entry, index) => {
    const n = index + 1;
    const runs: Run[] = [];
    if (entry.quote !== '') runs.push({ text: quote(entry.quote, lang), italic: false });
    runs.push({ text: superscript(n), italic: false, note: n });
    blocks.push({ runs });
  });
  if (entries.length > 0) {
    blocks.push({ kind: 'heading', runs: [{ text: WORDS[lang].notes, italic: false }] });
    entries.forEach((entry, index) => {
      const runs =
        index === 0
          ? fullNote(record, entry.locator, lang)
          : [{ text: withStop(shortNote(record, entry.locator, lang)), italic: false }];
      blocks.push({ kind: 'note', note: index + 1, runs });
    });
  }
  blocks.push({ kind: 'heading', runs: [{ text: WORDS[lang].bibliography, italic: false }] });
  blocks.push({ runs: germanReference(record, lang) });
  return blocks;
}

/** Copy citation: the quote, a line break and the full note (the paste target may be its first mention). */
export function germanCopy(record: BibRecord, entry: GermanEntry, lang: Lang): StyledBlock[] {
  const note = fullNote(record, entry.locator, lang);
  const runs: Run[] = entry.quote === '' ? note : [{ text: `${quote(entry.quote, lang)}\n`, italic: false }, ...note];
  return [{ runs }];
}
