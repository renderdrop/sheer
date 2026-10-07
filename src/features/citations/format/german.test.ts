import { describe, expect, it } from 'vitest';

import {
  CITATION_STYLES,
  emptyBibRecord,
  parseBibRecord,
  type BibRecord,
  type CitationInfo,
} from '../../../api/citations';
import {
  blocksToHtml,
  blocksToPlainText,
  formatCitationCopy,
  formatCitationList,
  formatReference,
  formatShortCitation,
} from './index';
import { kurztitel } from './german';

const MUELLER = { family: 'Müller', given: 'Hans' };
const SCHMIDT = { family: 'Schmidt', given: 'Eva' };

const book: BibRecord = {
  ...emptyBibRecord(),
  kind: 'book',
  authors: [MUELLER],
  title: 'Digitale Lesekultur. Eine Einführung',
  edition: '2',
  place: 'Berlin',
  publisher: 'Beispielverlag',
  year: '2021',
};
const article: BibRecord = {
  ...emptyBibRecord(),
  kind: 'article',
  authors: [MUELLER, SCHMIDT],
  title: 'Lesen am Bildschirm',
  containerTitle: 'Zeitschrift für Medien',
  volume: '12',
  issue: '3',
  pages: '45-67',
  year: '2021',
};
const web: BibRecord = {
  ...emptyBibRecord(),
  kind: 'webPage',
  authors: [MUELLER],
  title: 'Leitfaden PDF',
  containerTitle: 'Beispiel-Portal',
  year: '2023',
  url: 'https://example.org/pdf',
  accessed: '2026-10-05',
};

const text = (record: BibRecord, locator: string, lang: 'en' | 'de') =>
  blocksToPlainText([formatCitationCopy(record, cite(1, '', locator), 'germanNotes', lang)[0] ?? { runs: [] }]);

function cite(id: number, quote: string, locator: string, group: string | null = null): CitationInfo {
  return { id, pageId: id, locator, quote, contents: '', tags: [], group, color: [255, 220, 0] };
}

const ref = (record: BibRecord, lang: 'en' | 'de') => blocksToPlainText([formatReference(record, 'germanNotes', lang)]);
const short = (record: BibRecord, locator: string, lang: 'en' | 'de') =>
  formatShortCitation(record, locator, 'germanNotes', lang);

describe('Deutsche Zitierweise (DZ-AC 1, 2)', () => {
  it('is the fifth style', () => {
    expect(CITATION_STYLES).toHaveLength(5);
    expect(CITATION_STYLES[4]).toBe('germanNotes');
  });

  it('full notes of a book, an article and a web page, de', () => {
    expect(text(book, '12', 'de')).toBe(
      'Müller, Hans: Digitale Lesekultur. Eine Einführung. 2. Aufl. Berlin: Beispielverlag, 2021, S. 12.',
    );
    expect(text(article, '12', 'de')).toBe(
      'Müller, Hans/Schmidt, Eva: Lesen am Bildschirm. In: Zeitschrift für Medien 12 (2021), H. 3, S. 45–67, hier S. 12.',
    );
    expect(text(web, '12', 'de')).toBe(
      'Müller, Hans: Leitfaden PDF. In: Beispiel-Portal, 2023, S. 12. URL: https://example.org/pdf (Zugriff am 05.10.2026).',
    );
  });

  it('full notes, en', () => {
    expect(text(book, '12', 'en')).toBe(
      'Müller, Hans: Digitale Lesekultur. Eine Einführung. 2nd ed. Berlin: Beispielverlag, 2021, p. 12.',
    );
    expect(text(article, '12', 'en')).toBe(
      'Müller, Hans/Schmidt, Eva: Lesen am Bildschirm. In: Zeitschrift für Medien 12 (2021), no. 3, pp. 45–67, here p. 12.',
    );
    expect(text(web, '12', 'en')).toBe(
      'Müller, Hans: Leitfaden PDF. In: Beispiel-Portal, 2023, p. 12. URL: https://example.org/pdf (accessed 5 October 2026).',
    );
  });

  it('the bibliography entry has no locator; titles of books and journals are italic', () => {
    expect(ref(book, 'de')).toBe(
      'Müller, Hans: Digitale Lesekultur. Eine Einführung. 2. Aufl. Berlin: Beispielverlag, 2021.',
    );
    expect(ref(article, 'de')).toBe(
      'Müller, Hans/Schmidt, Eva: Lesen am Bildschirm. In: Zeitschrift für Medien 12 (2021), H. 3, S. 45–67.',
    );
    expect(
      formatReference(article, 'germanNotes', 'de')
        .runs.filter((r) => r.italic)
        .map((r) => r.text),
    ).toEqual(['Zeitschrift für Medien']);
    expect(formatReference(book, 'germanNotes', 'de').runs.some((r) => r.italic)).toBe(true);
  });

  it('chapter, report and more than three authors', () => {
    const chapter: BibRecord = {
      ...book,
      kind: 'chapter',
      title: 'Kapitel',
      containerTitle: 'Buchtitel',
      pages: '10-20',
    };
    expect(text(chapter, '12', 'de')).toBe(
      'Müller, Hans: Kapitel. In: Buchtitel. 2. Aufl. Berlin: Beispielverlag, 2021, S. 10–20, hier S. 12.',
    );
    const report: BibRecord = { ...book, kind: 'report', title: 'Bericht', edition: null };
    expect(text(report, '12', 'de')).toBe('Müller, Hans: Bericht. Berlin: Beispielverlag, 2021, S. 12.');
    const many: BibRecord = { ...book, authors: [MUELLER, SCHMIDT, MUELLER, SCHMIDT] };
    expect(ref(many, 'de').startsWith('Müller, Hans u. a.: ')).toBe(true);
  });
});

describe('short notes (DZ-AC 3)', () => {
  it('has no parentheses and no final stop', () => {
    expect(short(book, '14', 'de')).toBe('Müller, Digitale Lesekultur, S. 14');
    expect(short(book, '14', 'en')).toBe('Müller, Digitale Lesekultur, p. 14');
    expect(short(article, '14', 'de')).toBe('Müller/Schmidt, Lesen am Bildschirm, S. 14');
    expect(short(web, '14', 'en')).toBe('Müller, Leitfaden PDF, p. 14');
  });

  it('three or more authors, no author, a stored short title', () => {
    const three = { ...book, authors: [MUELLER, SCHMIDT, MUELLER] };
    expect(short(three, '1', 'de')).toBe('Müller u. a., Digitale Lesekultur, S. 1');
    expect(short(three, '1', 'en')).toBe('Müller et al., Digitale Lesekultur, p. 1');
    expect(short({ ...book, authors: [] }, '2', 'de')).toBe('Digitale Lesekultur, S. 2');
    expect(short({ ...book, shortTitle: 'Lesekultur' }, '2', 'de')).toBe('Müller, Lesekultur, S. 2');
  });

  it('Kurztitel stops at : . ? ! or " – " and keeps 4 words', () => {
    expect(kurztitel('Titel: Untertitel')).toBe('Titel');
    expect(kurztitel('Was nun? Ein Buch')).toBe('Was nun');
    expect(kurztitel('Alpha – Beta')).toBe('Alpha');
    expect(kurztitel('eins zwei drei vier fünf sechs')).toBe('eins zwei drei vier');
    expect(kurztitel(null)).toBe('');
  });
});

describe('copy citation (DZ-AC 4)', () => {
  it('is the quote, a line break and the full note', () => {
    const blocks = formatCitationCopy(book, cite(1, 'Ein Satz.', '12'), 'germanNotes', 'de');
    expect(blocksToPlainText(blocks)).toBe(
      '„Ein Satz.“\nMüller, Hans: Digitale Lesekultur. Eine Einführung. 2. Aufl. Berlin: Beispielverlag, 2021, S. 12.',
    );
    expect(blocksToHtml(blocks)).toContain('<br>');
  });
});

describe('citation list (DZ-AC 5, 6, 9)', () => {
  const list = formatCitationList(
    book,
    [cite(1, 'Eins', '12'), cite(2, 'Zwei', '14'), cite(3, 'Drei', '20')],
    'germanNotes',
    'de',
  );

  it('has marks 1-3, note 1 full, notes 2-3 short, then the bibliography', () => {
    expect(list.map((b) => b.kind ?? 'p')).toEqual(['p', 'p', 'p', 'heading', 'note', 'note', 'note', 'heading', 'p']);
    expect(list[0]?.runs.at(-1)).toEqual({ text: '¹', italic: false, note: 1 });
    expect(blocksToPlainText(list)).toBe(
      [
        '„Eins“¹',
        '„Zwei“²',
        '„Drei“³',
        'Fußnoten',
        '¹ Müller, Hans: Digitale Lesekultur. Eine Einführung. 2. Aufl. Berlin: Beispielverlag, 2021, S. 12.\n' +
          '² Müller, Digitale Lesekultur, S. 14.\n' +
          '³ Müller, Digitale Lesekultur, S. 20.',
        'Literaturverzeichnis',
        'Müller, Hans: Digitale Lesekultur. Eine Einführung. 2. Aufl. Berlin: Beispielverlag, 2021.',
      ].join('\n\n'),
    );
  });

  it('html has headings and note numbers; en headings', () => {
    const html = blocksToHtml(list);
    expect(html).toContain('<h2>Fußnoten</h2>');
    expect(html).toContain('<p><sup>2</sup> Müller, Digitale');
    const en = formatCitationList(book, [cite(1, 'One', '1')], 'germanNotes', 'en');
    expect(en.filter((b) => b.kind === 'heading').map((b) => b.runs[0]?.text)).toEqual(['Notes', 'Bibliography']);
  });

  it('a group is one note with a joined locator; no quote leaves the mark alone', () => {
    const grouped = formatCitationList(
      book,
      [cite(1, 'Eins', '12', 'g'), cite(2, 'Zwei', '13', 'g'), cite(3, '', '20')],
      'germanNotes',
      'de',
    );
    expect(grouped.filter((b) => b.kind === 'note')).toHaveLength(2);
    expect(grouped[0]?.runs.map((r) => r.text).join('')).toBe('„Eins … Zwei“¹');
    expect(grouped[1]?.runs).toEqual([{ text: '²', italic: false, note: 2 }]);
    expect(blocksToPlainText(grouped)).toContain('S. 12–13.');
  });

  it('the first entry is full, the later ones short (comment export order, DZ-AC 9)', () => {
    const notes = list.filter((b) => b.kind === 'note').map((b) => b.runs.map((r) => r.text).join(''));
    expect(notes[0]).toContain('Berlin: Beispielverlag');
    expect(notes[1]).not.toContain('Berlin');
  });
});

describe('missing data and other styles (DZ-AC 7, 8)', () => {
  it('an empty record never throws; missing year and place read o. J. and o. O.', () => {
    const empty = emptyBibRecord();
    for (const lang of ['de', 'en'] as const) {
      expect(() => ref(empty, lang)).not.toThrow();
      expect(() => short(empty, '1', lang)).not.toThrow();
      expect(() => formatCitationList(empty, [cite(1, '', '1')], 'germanNotes', lang)).not.toThrow();
    }
    const bare: BibRecord = { ...emptyBibRecord(), kind: 'book', title: 'Nur Titel' };
    expect(text(bare, '5', 'de')).toBe('Nur Titel. o. O., o. J., S. 5.');
    expect(short(emptyBibRecord(), '5', 'de')).toBe('S. 5');
  });

  it('the four other styles keep their list shape (reference first, no kinds)', () => {
    for (const style of ['apa7', 'mla9', 'chicago17AuthorDate', 'dinIso690'] as const) {
      const blocks = formatCitationList(book, [cite(1, 'Eins', '12')], style, 'en');
      expect(blocks).toHaveLength(2);
      expect(blocks.every((b) => b.kind === undefined && b.runs.every((r) => r.note === undefined))).toBe(true);
      expect(blocksToPlainText(blocks)).toContain('\n\n“Eins”');
    }
  });

  it('a record with shortTitle parses; one without still parses', () => {
    expect(parseBibRecord({ kind: 'book', shortTitle: 'Kurz' })?.shortTitle).toBe('Kurz');
    expect(parseBibRecord({ kind: 'book' })?.shortTitle).toBeUndefined();
  });
});
