// Dev only: writes a plain N-page Letter PDF (default 500) for performance measurements. Usage: node scripts/ui/gen-pdf.mjs <out.pdf> [pages]
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
const n = Number(process.argv[3] ?? 500);
if (!out || !Number.isInteger(n) || n < 1) throw new Error('usage: gen-pdf.mjs <out.pdf> [pages]');
let pdf = '%PDF-1.4\n';
const offsets = [];
const add = (body) => {
  offsets.push(pdf.length);
  pdf += body;
};
add('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
add(
  `2 0 obj<</Type/Pages/Count ${n}/Kids[${Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}]>>endobj\n`,
);
add('3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n');
for (let i = 0; i < n; i += 1) {
  const content = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
  add(
    `${4 + i * 2} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + i * 2} 0 R>>endobj\n`,
  );
  add(`${5 + i * 2} 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`);
}
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(out, pdf, 'latin1');
