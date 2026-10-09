// Pure helpers of the rc.3 acceptance (scripts/ui/accept/v20rc3.mjs): generated PDFs and verdict functions. No I/O; unit-tested in
// ../v20rc3.test.ts. Generated documents only (rule 13).

/** objs: strings (object bodies) or { dict, data } streams; object n is objs[n - 1]. Returns a Buffer with a correct xref. */
export function buildPdf(objs) {
  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const body =
      typeof o === 'string'
        ? `${i + 1} 0 obj\n${o}\nendobj\n`
        : `${i + 1} 0 obj\n<< ${o.dict ?? ''} /Length ${Buffer.byteLength(o.data, 'latin1')} >>\nstream\n${o.data}\nendstream\nendobj\n`;
    const b = Buffer.from(body, 'latin1');
    parts.push(b);
    pos += b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** Text lines as one BT..ET stream: [x, y, size, text, rise?] entries. */
export const textOps = (entries) =>
  `BT ${entries
    .map(([x, y, size, text, rise = 0]) => `/F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm ${rise} Ts (${text}) Tj 0 Ts`)
    .join(' ')} ET`;

/** A document of Letter pages; each page is a content string. Fonts: F1 Helvetica. */
export function pagesPdf(contents) {
  const n = contents.length;
  const kids = contents.map((_, i) => `${3 + i} 0 R`).join(' ');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`];
  const font = 3 + n;
  contents.forEach((_, i) =>
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${font + 1 + i} 0 R >>`,
    ),
  );
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const c of contents) objs.push({ data: c });
  return buildPdf(objs);
}

const NOTE = 'Smith, J. (1999). A Short History of Maps. Leeds: Harbor Press, p. 12.';
const BODY = [
  'The survey of the old town began with a careful look at the archive',
  'and the first maps were compared with the later ones in detail',
  'so that every change of the river could be traced over the years',
];

/**
 * A three page document for the smart links: a contents page, then two chapter pages with footnotes. `variant` is the marker style:
 * bracket "[1]", superscript (raised small digit) or asterisk. The chapter headings are larger so a heading outline can be found.
 */
export function footnotePdf(variant) {
  const marker = (n) => (variant === 'asterisk' ? '*' : `[${n}]`);
  const noteLabel = (n) => (variant === 'asterisk' ? '*' : variant === 'superscript' ? `${n}` : `[${n}]`);
  const chapter = (title, first) => {
    const e = [[72, 720, 20, title]];
    BODY.forEach((line, i) => e.push([72, 690 - i * 20, 12, line]));
    const ops = [textOps(e)];
    // marker inside the running text: own line per marker so the detector sees "word<marker>"
    const body = [];
    for (let k = 0; k < 2; k++) {
      const n = first + k;
      const y = 600 - k * 24;
      if (variant === 'superscript')
        body.push(
          `BT /F1 12 Tf 1 0 0 1 72 ${y} Tm (As the archive records) Tj /F1 7 Tf 4 Ts (${n}) Tj 0 Ts /F1 12 Tf ( the river moved again.) Tj ET`,
        );
      else body.push(textOps([[72, y, 12, `As the archive records${marker(n)} the river moved again.`]]));
    }
    ops.push(...body);
    ops.push('72 150 m 200 150 l S');
    for (let k = 0; k < 2; k++) {
      const n = first + k;
      ops.push(textOps([[72, 130 - k * 14, 9, `${noteLabel(n)} ${NOTE}`]]));
    }
    return ops.join(' ');
  };
  const contents = textOps([
    [72, 720, 22, 'Contents'],
    [72, 680, 12, '1 Introduction .......................... 2'],
    [72, 660, 12, '2 Methods ............................... 3'],
  ]);
  return pagesPdf([contents, chapter('1 Introduction', 1), chapter('2 Methods', 3)]);
}

/** A book with an imprint page: title page, then the imprint with copyright year, edition, publisher, place, ISBN. */
export function imprintPdf() {
  const title = textOps([
    [72, 600, 28, 'A Short History of Maps'],
    [72, 560, 16, 'Anna Berger'],
  ]);
  const imprint = textOps([
    [72, 700, 11, 'A Short History of Maps'],
    [72, 684, 11, 'by Anna Berger'],
    [72, 660, 10, 'Copyright 2011 by Anna Berger. All rights reserved.'],
    [72, 644, 10, 'Second edition 2011'],
    [72, 628, 10, 'Published by Harbor Press, Leeds'],
    [72, 612, 10, 'ISBN 978-3-16-148410-0'],
    [72, 596, 10, 'Printed in the United Kingdom'],
  ]);
  const body = textOps([
    [72, 700, 18, 'Chapter 1'],
    [72, 670, 12, 'Maps are older than writing and they changed the way people think.'],
  ]);
  return pagesPdf([title, imprint, body]);
}

/** A plain document of n pages with a few text lines. */
export function plainPdf(pages, title) {
  return pagesPdf(
    Array.from({ length: pages }, (_, i) =>
      textOps([
        [72, 700, 14, `${title} page ${i + 1} first line`],
        [72, 680, 14, 'Second line of body text here'],
        [72, 660, 14, 'Third line of body text here'],
      ]),
    ),
  );
}

/** A one page image-only A4 PDF around a JPEG (DCTDecode). */
export function imagePdf(jpeg, w, h) {
  const bin = jpeg.toString('latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    {
      dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      data: bin,
    },
    { data: 'q 595 0 0 842 0 0 cm /Im0 Do Q' },
  ]);
}

// ---- verdicts ------------------------------------------------------------------------------------------------------------
/** Expected editor grid rows (DESIGN 3.18 E1) at a window height: menu 28 (Windows), tabs 42, gutter 12, card 106, gutter 12, body, status 30. */
export function expectedRows(height, menu = true) {
  const fixed = [28, 42, 12, 106, 12, 30];
  const sum = (menu ? 28 : 0) + 42 + 12 + 106 + 12 + 30;
  const rows = menu ? fixed : fixed.slice(1);
  return { rows, body: height - sum };
}

/** Parses a computed grid-template-rows value ("28px 42px ...") to numbers. */
export const parseTracks = (value) =>
  String(value)
    .trim()
    .split(/\s+/)
    .map((x) => Number.parseFloat(x))
    .filter((x) => Number.isFinite(x));

/** True if the computed tracks equal the expected fixed rows around a body track of the right size. */
export function rowsMatch(tracks, height, menu = true, tolerance = 1) {
  const { rows, body } = expectedRows(height, menu);
  const want = [...rows.slice(0, -1), body, rows[rows.length - 1]];
  if (tracks.length !== want.length) return false;
  return want.every((w, i) => Math.abs((tracks[i] ?? -1) - w) <= tolerance);
}

/** Separators a mode shows in the full-width row: groups - 1 (DESIGN 3.18 E4 table). */
export const SEPARATORS = { read: 2, comment: 2, fill: 2, pages: 3, edit: 2 };

/** "rgb(r, g, b)" or "rgba(r, g, b, a)" -> [r, g, b] (or null). */
export function parseRgb(css) {
  const m = String(css).match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The greeting DESIGN H4 expects for a clock hour and an author name. */
export function expectedGreeting(hour, name) {
  const word = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
  const n = String(name ?? '').trim();
  return n === '' ? `${word}.` : `${word}, ${n}.`;
}

/** Counts the occurrences of a phrase in a text. */
export const countOf = (text, phrase) => String(text).split(phrase).length - 1;

/** True if two colour lists (of "rgb(...)" strings) differ in at least one position. */
export const coloursDiffer = (a, b) => a.length !== b.length || a.some((c, i) => c !== b[i]);

/** Summary of a smart-link scan: kinds -> count; returns the kinds seen. */
export const kindCounts = (links) => links.reduce((acc, l) => ({ ...acc, [l.kind]: (acc[l.kind] ?? 0) + 1 }), {});
