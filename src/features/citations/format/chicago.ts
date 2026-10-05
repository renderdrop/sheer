import type { BibRecord, Run } from '../../../api/citations';
import { arrange, bare, doiUrl, isPart, shortNames, shortTitle, type StyleImpl } from './shared';
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

/** Chicago 17 author-date: "Family, Given, and Given Family. 2021. Title. Place: Publisher." Up to ten names, then seven and "et al.". */
function authorsOf(record: BibRecord, lang: Lang): string {
  const people = peopleOf(record);
  const terms = TERMS[lang];
  const shown = people.length > 10 ? people.slice(0, 7) : people;
  const names = shown.map((p, index) => (index === 0 ? inverted(p) : natural(p)));
  if (people.length > 10) return `${names.join(', ')}, ${terms.etAl}`;
  if (names.length <= 1) return names.join('');
  const last = names[names.length - 1] ?? '';
  const head = names.slice(0, -1).join(', ');
  // English puts a comma before "and" in a list and after an inverted first name; German never.
  return lang === 'de' ? `${head} ${terms.and} ${last}` : `${head}, ${terms.and} ${last}`;
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
  const url = clean(record.url);
  const doi = doiUrl(record.doi);
  const link = doi !== '' ? doi : url;
  const authors = authorsOf(record, lang);
  const accessed = clean(record.accessed) === '' ? '' : formatDate(record.accessed ?? '', lang, 'mdy');
  const quoted = title === '' ? '' : quotedTitle(title, lang);
  const imprint = j(': ', place, publisher);

  let body: Sent[];
  switch (record.kind) {
    case 'book':
      body = [S(i(title)), S(edition), S(imprint), S(link)];
      break;
    case 'article': {
      const volume = clean(record.volume);
      const issue = clean(record.issue);
      body = [
        S(quoted),
        S(j('', j(' ', i(container), j('', volume, issue !== '' && `(${issue})`)), pages !== '' && `: ${pages}`)),
        S(link),
      ];
      break;
    }
    case 'chapter':
      body = [S(quoted), S(j(', ', container !== '' && ['In ', i(container)], pages)), S(edition), S(imprint), S(link)];
      break;
    case 'report':
      body = [S(i(title)), S(imprint), S(link)];
      break;
    case 'thesis':
      body = [S(quoted), S(j(', ', terms.thesis, publisher, place)), S(link)];
      break;
    case 'webPage':
      body = [S(quoted), S(i(container)), S(accessed !== '' && `${terms.accessed} ${accessed}`), S(url)];
      break;
  }
  return render(arrange<Sent>(authors !== '', S(authors), [S(year)], body));
}

/** "(Family 2021, 12)". */
function short(record: BibRecord, locator: string, lang: Lang): string {
  const people = peopleOf(record);
  const who =
    people.length > 0
      ? shortNames(people, lang, 'chicago')
      : shortTitle(record, lang, isPart(record.kind) || record.kind === 'thesis');
  const year = clean(record.year) || TERMS[lang].nd;
  const loc = bare(locator);
  return `(${who === '' ? year : `${who} ${year}`}${loc === '' ? '' : `, ${loc}`})`;
}

export const chicago: StyleImpl = { reference, short };
