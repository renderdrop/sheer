// Writes tests/fixtures/form-clip.pdf: one page, text fields "Name" and "City" and a checkbox "Subscribe", all with appearance
// streams (clip recording for the form tip, ADR-138). Self-made, deterministic. Node built-ins only.
// Run: node scripts/fixtures/form-clip.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '../../tests/fixtures/form-clip.pdf');
const DA = '/Helv 12 Tf 0 g';
const text = (rect, name) =>
  `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${name}) /Rect [${rect}] /F 4 /P 10 0 R /DA (${DA}) /DR 6 0 R ` +
  `/MK << /BC [0.4 0.4 0.4] /BG [1 1 1] >> /AP << /N 9 0 R >> >>`;
const objs = new Map();
objs.set(
  1,
  '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R 101 0 R 102 0 R] /DA (/Helv 12 Tf 0 g) /DR 6 0 R >> >>',
);
objs.set(2, '<< /Type /Pages /Kids [10 0 R] /Count 1 >>');
objs.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
objs.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
objs.set(6, '<< /Font << /Helv 4 0 R >> >>');
const stream = (dict, body) => `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`;
// empty text appearance (white box with grey border), shared by both text fields (200 x 22)
objs.set(
  9,
  stream(
    '/Type /XObject /Subtype /Form /BBox [0 0 200 22] /Resources 6 0 R',
    '1 g 0 0 200 22 re f 0.4 G 0.5 0.5 199 21 re S',
  ),
);
// checkbox appearances (16 x 16)
objs.set(7, stream('/Type /XObject /Subtype /Form /BBox [0 0 16 16]', '1 g 0 0 16 16 re f 0.4 G 0.5 0.5 15 15 re S'));
objs.set(
  8,
  stream(
    '/Type /XObject /Subtype /Form /BBox [0 0 16 16]',
    '1 g 0 0 16 16 re f 0.4 G 0.5 0.5 15 15 re S 0 G 3 8 m 6.5 4 l 13 12.5 l 1.5 w S',
  ),
);
objs.set(
  10,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [100 0 R 101 0 R 102 0 R] /Contents 11 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>',
);
objs.set(
  11,
  stream(
    '',
    'BT /F1 22 Tf 72 720 Td (Contact) Tj ET\nBT /F2 12 Tf 72 676 Td (Name) Tj ET\nBT /F2 12 Tf 72 626 Td (City) Tj ET\nBT /F2 12 Tf 98 580 Td (Send me updates) Tj ET',
  ),
);
objs.set(100, text('72 646 272 668', 'Name'));
objs.set(101, text('72 596 272 618', 'City'));
objs.set(
  102,
  '<< /Type /Annot /Subtype /Widget /FT /Btn /T (Updates) /Rect [72 576 88 592] /F 4 /P 10 0 R /V /Off /AS /Off /MK << /BC [0.4 0.4 0.4] >> /AP << /N << /Yes 8 0 R /Off 7 0 R >> >> >>',
);

let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
const offsets = new Map();
for (const [n, body] of [...objs].sort((a, b) => a[0] - b[0])) {
  offsets.set(n, Buffer.byteLength(pdf, 'latin1'));
  pdf += `${n} 0 obj\n${body}\nendobj\n`;
}
const max = Math.max(...objs.keys());
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
for (let n = 1; n <= max; n++)
  pdf += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
pdf += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(OUT, Buffer.from(pdf, 'latin1'));
console.log(`wrote ${OUT} (${pdf.length} bytes)`);
