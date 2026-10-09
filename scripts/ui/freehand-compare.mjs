// Dev only (F21.5): renders five fixed freehand-shape strokes before (straight join, F19.26) and after (shape fit with the stroke's
// own wobble, `shapeFit.ts`) side by side as SVG and PNG. Usage: node scripts/ui/freehand-compare.mjs [outDir]
// (default review/v21/freehand/, untracked). The TypeScript sources are bundled in memory with rolldown (already installed by vite).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

import { encodePng } from './apng.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE = join(ROOT, 'src', 'features', 'annotations', 'create');
const OUT = resolve(ROOT, process.argv[2] ?? 'review/v21/freehand');
const STROKES = ['circle', 'ellipse', 'rectangle', 'triangle', 'overlap'];
const WIDTH = 2;

async function loadSources() {
  const entry = 'virtual:freehand-compare';
  const files = ['ink.ts', 'drawVariants.ts', 'shapeFit.ts', 'shapeFit.strokes.ts'].map((f) => join(CREATE, f));
  const bundle = await rolldown({
    input: entry,
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'freehand-compare-entry',
        resolveId: (id) => (id === entry ? id : null),
        load: (id) => (id === entry ? files.map((f) => `export * from ${JSON.stringify(f)};`).join('\n') : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  const code = output[0].code;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** The F19.26 behaviour: the end led back to the start in four straight steps when the loop nearly closed. */
function closeLoopBefore(stroke, width) {
  const copy = stroke.map((s) => ({ ...s }));
  const first = stroke[0];
  const last = stroke[stroke.length - 1];
  if (!first || !last || stroke.length < 8) return copy;
  let length = 0;
  for (let i = 1; i < stroke.length; i += 1)
    length += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
  const gap = Math.hypot(first.x - last.x, first.y - last.y);
  if (length < 12 || gap === 0 || gap > Math.max(length * 0.2, width * 3)) return copy;
  for (let k = 1; k <= 4; k += 1) {
    const t = k / 4;
    copy.push({ x: last.x + (first.x - last.x) * t, y: last.y + (first.y - last.y) * t, pressure: last.pressure });
  }
  return copy;
}

/** Fills polygons (non-zero winding) into an RGBA image, 3×3 supersampled; colours are [r, g, b]. */
function rasterise(width, height, polygons, ink, paper) {
  const SS = 3;
  const W = Math.ceil(width) * SS;
  const H = Math.ceil(height) * SS;
  const cover = new Uint8Array(W * H);
  for (const poly of polygons) {
    for (let row = 0; row < H; row += 1) {
      const y = (row + 0.5) / SS;
      const hits = [];
      for (let i = 0; i < poly.length; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (a.y <= y === b.y <= y) continue;
        hits.push({ x: a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x), dir: b.y > a.y ? 1 : -1 });
      }
      hits.sort((p, q) => p.x - q.x);
      let wind = 0;
      for (let i = 0; i < hits.length - 1; i += 1) {
        wind += hits[i].dir;
        if (wind === 0) continue;
        const from = Math.max(0, Math.ceil(hits[i].x * SS - 0.5));
        const to = Math.min(W - 1, Math.floor(hits[i + 1].x * SS - 0.5));
        for (let x = from; x <= to; x += 1) cover[row * W + x] = 1;
      }
    }
  }
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let c = 0;
      for (let dy = 0; dy < SS; dy += 1) for (let dx = 0; dx < SS; dx += 1) c += cover[(y * SS + dy) * W + x * SS + dx];
      const t = c / (SS * SS);
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k += 1) data[o + k] = Math.round(paper[k] + (ink[k] - paper[k]) * t);
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const fmt = (n) => Number(n.toFixed(2));

function panel(m, stroke, offsetX, title) {
  const polygon = m.polygonPoints(m.strokeOutline(stroke, WIDTH).map((p) => ({ x: fmt(p.x + offsetX), y: fmt(p.y) })));
  return [
    `<polygon points="${polygon}" fill="#3b3486"/>`,
    `<text x="${offsetX + 10}" y="18" font-family="sans-serif" font-size="12" fill="#444">${title}</text>`,
  ].join('\n');
}

const m = await loadSources();
mkdirSync(OUT, { recursive: true });
const rows = [];
for (const name of STROKES) {
  const smoothed = m.smoothStroke(m.rawStroke(name));
  const before = closeLoopBefore(smoothed, WIDTH);
  const after = m.applyDrawVariant('shape', smoothed, WIDTH)[0];
  const kind = m.fitFreehandShape(smoothed, WIDTH)?.kind ?? 'spline';
  const all = [...before, ...after];
  const minX = Math.min(...all.map((p) => p.x)) - 20;
  const minY = Math.min(...all.map((p) => p.y)) - 30;
  const w = Math.max(...all.map((p) => p.x)) - minX + 20;
  const h = Math.max(...all.map((p) => p.y)) - minY + 20;
  const shift = (s) => s.map((p) => ({ ...p, x: p.x - minX, y: p.y - minY }));
  const body = [
    `<rect width="${fmt(2 * w)}" height="${fmt(h)}" fill="#fbfaf7"/>`,
    `<line x1="${fmt(w)}" y1="0" x2="${fmt(w)}" y2="${fmt(h)}" stroke="#ddd"/>`,
    panel(m, shift(before), 0, `${name}: before (straight join)`),
    panel(m, shift(after), w, `${name}: after (${kind})`),
  ].join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(2 * w)}" height="${fmt(h)}" viewBox="0 0 ${fmt(2 * w)} ${fmt(h)}">\n${body}\n</svg>\n`;
  writeFileSync(join(OUT, `${name}.svg`), svg);
  const outlines = [shift(before), shift(after).map((p) => ({ ...p, x: p.x + w }))].map((st) =>
    m.strokeOutline(st, WIDTH),
  );
  // Divider: a thin rectangle between the two panels.
  outlines.push([
    { x: w - 0.5, y: 0 },
    { x: w + 0.5, y: 0 },
    { x: w + 0.5, y: h },
    { x: w - 0.5, y: h },
  ]);
  writeFileSync(join(OUT, `${name}.png`), encodePng(rasterise(2 * w, h, outlines, [59, 52, 134], [251, 250, 247])));
  rows.push({ name, kind, w: 2 * w, h, body });
}
// All five in one sheet, one row each.
const sheetW = Math.max(...rows.map((r) => r.w));
let y = 0;
const groups = rows.map((r) => {
  const g = `<g transform="translate(0 ${fmt(y)})">\n${r.body}\n</g>`;
  y += r.h;
  return g;
});
writeFileSync(
  join(OUT, 'compare.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(sheetW)}" height="${fmt(y)}" viewBox="0 0 ${fmt(sheetW)} ${fmt(y)}">\n${groups.join('\n')}\n</svg>\n`,
);
for (const r of rows) console.log(`${r.name}: ${r.kind}`);
console.log(`wrote ${rows.length} comparisons (SVG + PNG) and compare.svg to ${OUT}`);
