import type { BibRecord, Run } from '../../../api/citations';
import { arrange, doiUrl, isPart, shortNames, shortTitle, withTerm, type StyleImpl } from './shared';
import { TERMS } from './terms';
import {
  abbreviated,
  clean,
  editionOf,
  formatDate,
  i,
  j,
  L,
  normalisePages,
  peopleOf,
  render,
  S,
  textOf,
  type Lang,
  type Sent,
} from './text';

/** APA 7: "Family, G., & Family, G. (2021). Title. Publisher." */
function authorsOf(record: BibRecord): string {
  const names = peopleOf(record).map(abbreviated);
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}`;
}

function reference(record: BibRecord, lang: Lang): Run[] {
  const terms = TERMS[lang];
  const title = clean(record.title);
  const year = clean(record.year) || terms.nd;
  const edition = editionOf(record.edition, lang);
  const publisher = clean(record.publisher);
  const container = clean(record.containerTitle);
  const pages = normalisePages(record.pages ?? '');
  const url = clean(record.url);
  const doi = doiUrl(record.doi);
  const link = doi !== '' ? doi : url;
  const authors = authorsOf(record);
  const accessed = clean(record.accessed) === '' ? '' : formatDate(record.accessed ?? '', lang, 'mdy');

  let body: Sent[];
  switch (record.kind) {
    case 'book':
      body = [S(i(title), edition !== '' && ` (${edition})`), S(publisher), L(link)];
      break;
    case 'article': {
      const volume = clean(record.volume);
      const issue = clean(record.issue);
      body = [S(title), S(j(', ', i(container), j('', i(volume), issue !== '' && `(${issue})`), pages)), L(link)];
      break;
    }
    case 'chapter':
      body = [
        S(title),
        S(container !== '' && ['In ', i(container), pages !== '' && ` (${withTerm(pages, lang)})`]),
        S(publisher),
        L(link),
      ];
      break;
    case 'report':
      body = [S(i(title)), S(publisher), L(link)];
      break;
    case 'thesis':
      body = [S(i(title), ` [${textOf(j(', ', terms.thesis, publisher))}]`), L(link)];
      break;
    case 'webPage':
      body = [S(i(title)), S(container), L(terms.retrieved(accessed, url))];
      break;
  }
  return render(arrange<Sent>(authors !== '', S(authors), [S(`(${year})`)], body));
}

function short(record: BibRecord, locator: string, lang: Lang): string {
  const people = peopleOf(record);
  const who = people.length > 0 ? shortNames(people, lang, 'apa') : shortTitle(record, lang, isPart(record.kind));
  const year = clean(record.year) || TERMS[lang].nd;
  return `(${[who, year, withTerm(locator, lang)].filter((x) => x !== '').join(', ')})`;
}

export const apa: StyleImpl = { reference, short };
