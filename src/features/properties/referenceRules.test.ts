import { describe, expect, it } from 'vitest';

import { emptyBibRecord, type BibRecord } from '../../api/citations';
import {
  captionOf,
  draftOf,
  invalidFields,
  isChanged,
  moveRow,
  recordOf,
  validate,
  visibleFields,
} from './referenceRules';

const article = (): BibRecord => ({
  ...emptyBibRecord(),
  kind: 'article',
  authors: [{ family: 'Müller', given: 'Anna' }],
  title: 'On things',
  year: '2021',
  containerTitle: 'Journal of Things',
  volume: '3',
});

describe('visibleFields (C5 table)', () => {
  it('shows the fields of each type after Year', () => {
    expect(visibleFields('book', '')).toEqual(['edition', 'publisher', 'place', 'isbn', 'doi', 'url']);
    expect(visibleFields('article', '')).toEqual(['containerTitle', 'volume', 'issue', 'pages', 'doi', 'url']);
    expect(visibleFields('chapter', '')).toEqual([
      'containerTitle',
      'pages',
      'edition',
      'publisher',
      'place',
      'isbn',
      'doi',
    ]);
    expect(visibleFields('report', '')).toEqual(['publisher', 'place', 'doi', 'url']);
    expect(visibleFields('webPage', '')).toEqual(['containerTitle', 'url', 'accessed']);
    expect(visibleFields('thesis', '')).toEqual(['publisher', 'place', 'url']);
  });

  it('adds Accessed for any type once a URL is filled', () => {
    expect(visibleFields('book', ' ')).not.toContain('accessed');
    expect(visibleFields('book', 'https://a.b')).toContain('accessed');
    expect(visibleFields('webPage', 'https://a.b').filter((f) => f === 'accessed')).toHaveLength(1);
  });
});

describe('validate', () => {
  it('accepts a 4 digit year, a suffix, and the n.d. forms', () => {
    for (const ok of ['2021', '2020a', 'n.d.', 'o. J.', '']) expect(validate('year', ok)).toBeNull();
    for (const bad of ['21', '20211', 'abcd', '2021 b']) expect(validate('year', bad)).toBe('ref.invalid.year');
  });

  it('checks an ISBN by its check digit', () => {
    expect(validate('isbn', '978-3-16-148410-0')).toBeNull();
    expect(validate('isbn', '0-8044-2957-X')).toBeNull();
    expect(validate('isbn', '978-3-16-148410-1')).toBe('ref.invalid.isbn');
    expect(validate('isbn', '')).toBeNull();
  });

  it('wants a DOI that starts with 10. and a URL that is http(s)', () => {
    expect(validate('doi', '10.1000/xyz')).toBeNull();
    expect(validate('doi', 'doi:10.1000/xyz')).toBe('ref.invalid.doi');
    expect(validate('doi', '11.1/2')).toBe('ref.invalid.doi');
    expect(validate('url', 'https://example.org/a')).toBeNull();
    expect(validate('url', 'http://example.org')).toBeNull();
    expect(validate('url', 'javascript:alert(1)')).toBe('ref.invalid.url');
    expect(validate('url', 'ftp://x.y')).toBe('ref.invalid.url');
  });
});

describe('the draft and the record', () => {
  it('round-trips a record', () => {
    const record = article();
    expect(recordOf(draftOf(record))).toEqual(record);
    expect(isChanged(draftOf(record), record)).toBe(false);
  });

  it('keeps values of hidden fields in the draft but drops them from the record', () => {
    const draft = draftOf(article());
    draft.kind = 'book';
    draft.text.volume = '3';
    expect(recordOf(draft).volume).toBeNull();
    expect(recordOf(draft).containerTitle).toBeNull();
    draft.kind = 'article';
    expect(recordOf(draft).volume).toBe('3');
  });

  it('trims, makes empty text null and leaves out empty author rows', () => {
    const draft = draftOf(article());
    draft.text.title = '  New  ';
    draft.text.volume = '   ';
    draft.authors.push({ key: 99, family: ' ', given: '' });
    const record = recordOf(draft);
    expect(record.title).toBe('New');
    expect(record.volume).toBeNull();
    expect(record.authors).toHaveLength(1);
  });

  it('lists only shown invalid fields', () => {
    const draft = draftOf(article());
    draft.text.year = '21';
    draft.text.doi = 'bad';
    expect(invalidFields(draft)).toEqual(['year', 'doi']);
    draft.kind = 'thesis';
    expect(invalidFields(draft)).toEqual(['year']);
  });

  it('sees a reorder of authors as a change', () => {
    const record = {
      ...article(),
      authors: [
        { family: 'A', given: '' },
        { family: 'B', given: '' },
      ],
    };
    const draft = draftOf(record);
    draft.authors = moveRow(draft.authors, 0, 1);
    expect(isChanged(draft, record)).toBe(true);
  });
});

describe('captionOf and moveRow', () => {
  it('names where a value came from, "edited" when it differs', () => {
    expect(captionOf('xmp', false, false)).toBe('file');
    expect(captionOf('info', false, false)).toBe('file');
    expect(captionOf('heuristic', false, false)).toBe('page1');
    expect(captionOf('user', false, false)).toBe('edited');
    expect(captionOf('none', false, true)).toBeNull();
    expect(captionOf('xmp', true, false)).toBe('edited');
    expect(captionOf('xmp', true, true)).toBeNull();
  });

  it('moves a row and ignores moves out of range', () => {
    expect(moveRow([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveRow([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveRow([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
  });
});
