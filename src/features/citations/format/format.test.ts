import { describe, expect, it } from 'vitest';

import {
  BIB_KINDS,
  CITATION_STYLES,
  emptyBibRecord,
  fitsCitationExport,
  type BibRecord,
  type CitationInfo,
  type StyledBlock,
} from '../../../api/citations';
import { FIXTURES } from './fixtures.test.data';
import { GOLDEN } from './golden.test.data';
import {
  blocksToHtml,
  blocksToPlainText,
  formatCitationList,
  formatReference,
  formatShortCitation,
  isReferenceIncomplete,
} from './index';

const marked = (block: StyledBlock): string => block.runs.map((r) => (r.italic ? `*${r.text}*` : r.text)).join('');

const citation = (over: Partial<CitationInfo>): CitationInfo => ({
  id: 1,
  pageId: 1,
  locator: '12',
  quote: 'A quote',
  contents: '',
  tags: [],
  group: null,
  color: [220, 207, 255],
  ...over,
});

describe('reference golden output', () => {
  for (const style of CITATION_STYLES) {
    for (const kind of BIB_KINDS) {
      for (const lang of ['en', 'de'] as const) {
        it(`${style} ${kind} ${lang}`, () => {
          expect(marked(formatReference(FIXTURES[kind], style, lang))).toBe(GOLDEN[`${style} ${kind} ${lang}`]);
        });
      }
    }
  }

  it('moves the title to the front without an author and says n.d. without a year', () => {
    const record: BibRecord = { ...FIXTURES.book, authors: [], year: null };
    expect(marked(formatReference(record, 'apa7', 'en'))).toBe(
      '*Citing well* (2nd ed.). (n.d.). Iris Press. https://doi.org/10.1000/book.1',
    );
    expect(marked(formatReference(record, 'apa7', 'de'))).toContain('(o. J.)');
    expect(marked(formatReference(record, 'dinIso690', 'de'))).toMatch(/^\*Citing well\*, o\. J\. 2\. Aufl\./u);
    expect(marked(formatReference(record, 'mla9', 'en'))).toBe(
      '*Citing well*. 2nd ed., Iris Press. https://doi.org/10.1000/book.1.',
    );
  });

  it('keeps a title that ends in a question mark free of a second stop', () => {
    const record: BibRecord = { ...FIXTURES.article, title: 'Why cite?' };
    expect(marked(formatReference(record, 'apa7', 'en'))).toContain('Why cite? *Journal');
    expect(marked(formatReference(record, 'mla9', 'en'))).toContain('“Why cite?” *Journal');
  });

  it('never throws on an empty record and stays inside the export limits', () => {
    for (const style of CITATION_STYLES) {
      for (const kind of BIB_KINDS) {
        const block = formatReference({ ...emptyBibRecord(), kind }, style, 'en');
        expect(fitsCitationExport([block])).toBe(true);
      }
    }
  });

  it('cuts huge fields into runs the backend accepts', () => {
    const huge = 'x'.repeat(1_000);
    const record: BibRecord = {
      ...FIXTURES.article,
      authors: Array.from({ length: 32 }, () => ({ family: 'F'.repeat(256), given: 'G'.repeat(256) })),
      title: huge,
      containerTitle: huge,
      pages: huge,
      url: 'https://example.org/'.padEnd(2_048, 'a'),
    };
    for (const style of CITATION_STYLES) {
      const block = formatReference(record, style, 'de');
      expect(fitsCitationExport([block])).toBe(true);
      expect(block.runs.length).toBeGreaterThan(0);
    }
  });

  it('writes initials for hyphenated and abbreviated given names', () => {
    const record: BibRecord = { ...FIXTURES.book, authors: [{ family: 'Weber', given: 'Jean-Paul K.' }] };
    expect(marked(formatReference(record, 'apa7', 'en'))).toMatch(/^Weber, J\.-P\. K\. \(2021\)/u);
  });
});

describe('short citations', () => {
  const record: BibRecord = { ...FIXTURES.book, authors: [{ family: 'Müller', given: 'Anna' }], year: '2021' };

  it('follows each style and the UI language', () => {
    expect(formatShortCitation(record, '12', 'apa7', 'en')).toBe('(Müller, 2021, p. 12)');
    expect(formatShortCitation(record, '12', 'dinIso690', 'de')).toBe('(Müller 2021, S. 12)');
    expect(formatShortCitation(record, '12', 'chicago17AuthorDate', 'en')).toBe('(Müller 2021, 12)');
    expect(formatShortCitation(record, '12', 'mla9', 'en')).toBe('(Müller 12)');
    expect(formatShortCitation(record, '', 'apa7', 'en')).toBe('(Müller, 2021)');
  });

  it('uses pp. for a range and keeps the page label', () => {
    expect(formatShortCitation(record, '12-13', 'apa7', 'en')).toBe('(Müller, 2021, pp. 12–13)');
    expect(formatShortCitation(record, '12–13', 'dinIso690', 'de')).toBe('(Müller 2021, S. 12–13)');
    expect(formatShortCitation(record, 'xii', 'apa7', 'en')).toBe('(Müller, 2021, p. xii)');
  });

  it('names two and three authors', () => {
    const two = { ...record, authors: [record.authors[0]!, { family: 'Schmidt', given: 'P' }] };
    const three = { ...two, authors: [...two.authors, { family: 'Weber', given: 'W' }] };
    expect(formatShortCitation(two, '1', 'apa7', 'en')).toBe('(Müller & Schmidt, 2021, p. 1)');
    expect(formatShortCitation(two, '1', 'dinIso690', 'de')).toBe('(Müller und Schmidt 2021, S. 1)');
    expect(formatShortCitation(three, '1', 'apa7', 'en')).toBe('(Müller et al., 2021, p. 1)');
    expect(formatShortCitation(three, '1', 'dinIso690', 'de')).toBe('(Müller u. a. 2021, S. 1)');
    expect(formatShortCitation(three, '1', 'chicago17AuthorDate', 'en')).toBe('(Müller, Schmidt, and Weber 2021, 1)');
  });

  it('falls back to the short title and n.d. when author or year is missing', () => {
    const bare: BibRecord = {
      ...FIXTURES.article,
      authors: [],
      year: null,
      title: 'A very long title about many things',
    };
    expect(formatShortCitation(bare, '12', 'apa7', 'en')).toBe('(“A very long title…”, n.d., p. 12)');
    expect(formatShortCitation(bare, '12', 'dinIso690', 'de')).toBe('(A very long title… o. J., S. 12)');
    expect(formatShortCitation(bare, '12', 'mla9', 'de')).toBe('(„A very long title…“ 12)');
  });

  it('copes with no record at all', () => {
    expect(formatShortCitation(undefined, '3', 'apa7', 'en')).toBe('(n.d., p. 3)');
    expect(formatShortCitation(undefined, '3', 'dinIso690', 'de')).toBe('(o. J., S. 3)');
    expect(formatShortCitation(undefined, '', 'mla9', 'en')).toBe('()');
  });
});

describe('citation list', () => {
  const record = FIXTURES.article;

  it('has the reference first, then the quotes with their short citation', () => {
    const blocks = formatCitationList(
      record,
      [citation({ id: 1, locator: '12', quote: 'First' }), citation({ id: 2, locator: 'xiv', quote: 'Second' })],
      'apa7',
      'en',
    );
    expect(blocks).toHaveLength(3);
    expect(marked(blocks[0] as StyledBlock)).toBe(GOLDEN['apa7 article en']);
    expect(marked(blocks[1] as StyledBlock)).toBe('“First” (Müller, 2020, p. 12)');
    expect(marked(blocks[2] as StyledBlock)).toBe('“Second” (Müller, 2020, p. xiv)');
  });

  it('uses German quotation marks and S.', () => {
    const blocks = formatCitationList(record, [citation({ quote: 'Zitat' })], 'dinIso690', 'de');
    expect(marked(blocks[1] as StyledBlock)).toBe('„Zitat“ (Müller 2020, S. 12)');
  });

  it('joins the pages of a group into one entry', () => {
    const blocks = formatCitationList(
      record,
      [
        citation({ id: 1, locator: '12', quote: 'Start', group: 'abcd1234' }),
        citation({ id: 2, locator: '13', quote: 'End', group: 'abcd1234' }),
        citation({ id: 3, locator: '20', quote: 'Other' }),
      ],
      'apa7',
      'en',
    );
    expect(blocks).toHaveLength(3);
    expect(marked(blocks[1] as StyledBlock)).toBe('“Start … End” (Müller, 2020, pp. 12–13)');
    expect(marked(blocks[2] as StyledBlock)).toBe('“Other” (Müller, 2020, p. 20)');
    const de = formatCitationList(
      record,
      [citation({ locator: '12', group: 'g' }), citation({ id: 2, locator: '13', group: 'g' })],
      'dinIso690',
      'de',
    );
    expect(marked(de[1] as StyledBlock)).toContain('(Müller 2020, S. 12–13)');
  });

  it('writes a group on one page with a single locator', () => {
    const blocks = formatCitationList(
      record,
      [citation({ locator: '5', group: 'g' }), citation({ id: 2, locator: '5', group: 'g' })],
      'apa7',
      'en',
    );
    expect(marked(blocks[1] as StyledBlock)).toContain('p. 5)');
  });

  it('leaves a missing quote out and cuts a huge one', () => {
    const blocks = formatCitationList(
      record,
      [citation({ quote: '' }), citation({ id: 2, quote: 'q'.repeat(4_000) })],
      'apa7',
      'en',
    );
    expect(marked(blocks[1] as StyledBlock)).toBe('(Müller, 2020, p. 12)');
    expect(fitsCitationExport(blocks)).toBe(true);
  });

  it('is only the reference for no citations', () => {
    expect(formatCitationList(record, [], 'mla9', 'en')).toHaveLength(1);
  });
});

describe('text and HTML', () => {
  const blocks: StyledBlock[] = [
    {
      runs: [
        { text: 'A & B <script>"x"\'', italic: false },
        { text: ' title', italic: true },
      ],
    },
    { runs: [{ text: 'Second', italic: false }] },
  ];

  it('makes plain text with a blank line between blocks', () => {
    expect(blocksToPlainText(blocks)).toBe('A & B <script>"x"\' title\n\nSecond');
  });

  it('escapes every character and writes italics as <i>', () => {
    expect(blocksToHtml(blocks)).toBe('<p>A &amp; B &lt;script&gt;&quot;x&quot;&#39;<i> title</i></p>\n<p>Second</p>');
  });

  it('does not let a field inject markup', () => {
    const html = blocksToHtml([
      formatReference({ ...FIXTURES.book, title: '<img src=x onerror=alert(1)>' }, 'apa7', 'en'),
    ]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('isReferenceIncomplete', () => {
  it('flags a missing title, author or year', () => {
    expect(isReferenceIncomplete(FIXTURES.book)).toBe(false);
    expect(isReferenceIncomplete({ ...FIXTURES.book, title: '' })).toBe(true);
    expect(isReferenceIncomplete({ ...FIXTURES.book, authors: [] })).toBe(true);
    expect(isReferenceIncomplete({ ...FIXTURES.book, year: null })).toBe(true);
    expect(isReferenceIncomplete(undefined)).toBe(true);
  });
});
