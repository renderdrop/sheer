import type { BibRecord, Run } from '../../../api/citations';
import { bareDoi, shortNames, shortTitle, withTerm, type StyleImpl } from './shared';
import { TERMS } from './terms';
import {
  clean,
  editionOf,
  familyOf,
  formatDate,
  i,
  isOrg,
  j,
  L,
  normalisePages,
  peopleOf,
  render,
  S,
  type Lang,
  type Sent,
} from './text';

/** DIN ISO 690:2013 author-year: "FAMILY, Given; FAMILY, Given, 2021. Title. Place: Publisher." */
function authorsOf(record: BibRecord, lang: Lang): string {
  return peopleOf(record)
    .map((p) => {
      const family = familyOf(p).toLocaleUpperCase(lang);
      return isOrg(p) ? family : `${family}, ${p.given}`;
    })
    .join('; ');
}

function reference(record: BibRecord, lang: Lang): Run[] {
  const terms = TERMS[lang];
  const title = clean(record.title);
  const year = clean(record.year) || terms.nd;
  const edition = editionOf(record.edition, lang);
  const publisher = clean(record.publisher);
  const place = clean(record.place);
  const container = clean(record.containerTitle);
  const pages = normalisePages(record.pages ?? '');
  const pagesTerm = withTerm(pages, lang);
  const url = clean(record.url);
  const doi = bareDoi(record.doi);
  const link = doi !== '' ? L(`DOI ${doi}`) : L(url !== '' && `${terms.available} ${url}`);
  const authors = authorsOf(record, lang);
  const accessed = clean(record.accessed) === '' ? '' : formatDate(record.accessed ?? '', lang, 'iso');
  const imprint = j(': ', place, publisher);

  let body: Sent[];
  switch (record.kind) {
    case 'book':
      body = [S(i(title)), S(edition), S(imprint), link];
      break;
    case 'article': {
      const volume = clean(record.volume);
      const issue = clean(record.issue);
      body = [
        S(title),
        S(i(container)),
        S(j(', ', volume !== '' && `${terms.vol} ${volume}`, issue !== '' && `${terms.no} ${issue}`, pagesTerm)),
        link,
      ];
      break;
    }
    case 'chapter':
      body = [
        S(title),
        S(container !== '' && ['In: ', i(container)]),
        S(edition),
        S(j(', ', imprint, pagesTerm)),
        link,
      ];
      break;
    case 'report':
      body = [S(i(title)), S(imprint), link];
      break;
    case 'thesis':
      body = [S(i(title)), S(terms.thesis), S(imprint), link];
      break;
    case 'webPage': {
      const when = accessed === '' ? '' : `[${terms.accessed.toLocaleLowerCase(lang)} ${accessed}]`;
      body = [S(i(title), ' [online]'), S(container), S(when), link];
      break;
    }
  }
  const [first, ...rest] = body;
  if (authors !== '') return render([S(j(', ', authors, year)), ...(first ? [first] : []), ...rest]);
  // No author: the title comes first, with the year.
  return render([first ? S(...first.parts, ', ', year) : S(year), ...rest]);
}

/** "(Family 2021, S. 12)". */
function short(record: BibRecord, locator: string, lang: Lang): string {
  const people = peopleOf(record);
  const who = people.length > 0 ? shortNames(people, lang, 'and') : shortTitle(record, lang, false);
  const year = clean(record.year) || TERMS[lang].nd;
  const loc = withTerm(locator, lang);
  return `(${who === '' ? year : `${who} ${year}`}${loc === '' ? '' : `, ${loc}`})`;
}

export const din: StyleImpl = { reference, short };
