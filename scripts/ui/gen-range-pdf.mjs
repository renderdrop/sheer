// Dev/acceptance only: writes a small self-generated PDF with range citations ("[3–5]", "[2, 4–6]", "[7]") and a "Literatur" section
// with entries [1]-[8]. Usage: node scripts/ui/gen-range-pdf.mjs [out.pdf]   (default review/v170/range.pdf)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'review/v170/range.pdf');
mkdirSync(dirname(out), { recursive: true });
const EN_DASH = String.fromCharCode(0x96); // en dash in WinAnsiEncoding; the file is written as latin1
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`).replaceAll('–', EN_DASH);
const text = (size, x, y, s) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET\n`;

let p1 = text(20, 72, 700, 'Einleitung');
p1 += text(12, 72, 660, 'Die Methode wurde vielfach untersucht [3–5] und weiter ausgebaut.');
p1 += text(12, 72, 640, 'Weitere Arbeiten [2, 4–6] zeigen ein ahnliches Bild.');
p1 += text(12, 72, 620, 'Ein einzelner Beleg findet sich in [7].');
let p2 = text(20, 72, 700, 'Literatur');
for (let n = 1; n <= 8; n++)
  p2 += text(12, 72, 660 - (n - 1) * 24, `[${n}] Autor ${n}: Titel der Arbeit Nummer ${n}. Verlag, 20${10 + n}.`);

let pdf = '%PDF-1.4\n';
const offsets = [];
const add = (body) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += body;
};
add('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
add('2 0 obj<</Type/Pages/Count 2/Kids[4 0 R 6 0 R]>>endobj\n');
add('3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>endobj\n');
[p1, p2].forEach((content, i) => {
  add(
    `${4 + i * 2} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + i * 2} 0 R>>endobj\n`,
  );
  add(`${5 + i * 2} 0 obj<</Length ${content.length}>>stream\n${content}endstream endobj\n`);
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(out, pdf, 'latin1');
console.log(out);
