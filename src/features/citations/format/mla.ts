import type { BibRecord, Run } from '../../../api/citations';
import { arrange, bare, doiUrl, isPart, shortNames, shortTitle, withTerm, type StyleImpl } from './shared';
import { TERMS } from './terms';
import {
  clean,
  editionOf,
  formatDate,
  i,
  inverted,
  j,
  natural,
  normalisePages,
  peopleOf,
  quotedTitle,
  render,
  S,
  type Lang,
  type Sent,
} from './text';

/** MLA 9: "Family, Given, and Given Family. Title. Publisher, Year." One author, two, or the first and "et al.". */
function authorsOf(record: BibRecord, lang: Lang): string {
  const people = peopleOf(record);
  const terms = TERMS[lang];
  const [first, second] = people;
  if (first === undefined) return '';
  if (second === undefined) return inverted(first);
  if (people.length === 2) return `${inverted(first)}, ${terms.and} ${natural(second)}`;
  return `${inverted(first)}, ${terms.etAl}`;
}

function reference(record: BibRecord, lang: Lang): Run[] {
  const terms = TERMS[lang];
  const title = clean(record.title);
  const year = clean(record.year);
  const edition = editionOf(record.edition, lang);
  const publisher = clean(record.publisher);
  const container = clean(record.containerTitle);
  const pages = normalisePages(record.pages ?? '');
  const pagesTerm = withTerm(pages, lang);
  const url = clean(record.url);
  const doi = doiUrl(record.doi);
  const link = doi !== '' ? doi : url;
  const authors = authorsOf(record, lang);
  const accessed = clean(record.accessed) === '' ? '' : formatDate(record.accessed ?? '', lang, 'dmy');
  const quoted = title === '' ? '' : quotedTitle(title, lang);

  let body: Sent[];
  switch (record.kind) {
    case 'book':
      body = [S(i(title)), S(j(', ', edition, publisher, year)), S(link)];
      break;
    case 'article': {
      const volume = clean(record.volume);
      const issue = clean(record.issue);
      body = [
        S(quoted),
        S(
          j(
            ', ',
            i(container),
            volume !== '' && `${terms.vol} ${volume}`,
            issue !== '' && `${terms.no} ${issue}`,
            year,
            pagesTerm,
          ),
        ),
        S(link),
      ];
      break;
    }
    case 'chapter':
      body = [S(quoted), S(j(', ', i(container), publisher, year, pagesTerm)), S(link)];
      break;
    case 'report':
      body = [S(i(title)), S(j(', ', publisher, year)), S(link)];
      break;
    case 'thesis':
      body = [S(i(title)), S(year), S(j(', ', publisher, terms.thesis)), S(link)];
      break;
    case 'webPage':
      body = [S(quoted), S(j(', ', i(container), year, url)), S(accessed !== '' && `${terms.accessed} ${accessed}`)];
      break;
  }
  return render(arrange<Sent>(authors !== '', S(authors), [], body));
}

/** "(Family 12)"; without an author the short title in quotation marks (parts of a larger work) or plain. */
function short(record: BibRecord, locator: string, lang: Lang): string {
  const people = peopleOf(record);
  const who = people.length > 0 ? shortNames(people, lang, 'and') : shortTitle(record, lang, isPart(record.kind));
  return `(${[who, bare(locator)].filter((x) => x !== '').join(' ')})`;
}

export const mla: StyleImpl = { reference, short };
