// Generates the installer and disk-image artwork from assets/brand/wordmark-secondary.svg (BRAND 5/7, REDESIGN_BRIEF R1.3).
// Deterministic: same input, same bytes. Dev-only; run `npm run gen-installer-art` and commit the outputs.
// Rasteriser: @resvg/resvg-js (MPL-2.0, devDependency only, never shipped). No text in any image.
// Outputs in src-tauri/installer/: header.bmp 150x57, sidebar.bmp 164x314 (24-bit, flattened), dmg-background.png 660x400.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src-tauri', 'installer');
const logo = readFileSync(join(root, 'assets', 'brand', 'logo.svg'), 'utf8');
const logoInner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// Brand mode (BRAND 5, 7): Sand ground, one Solar glow, the word mark in Ink. No screenshots, no text elements.
const SAND = '#F6F5F1';
const SOLAR = '255,248,77';
const INK = '#0F0F0F';

const wordmark = readFileSync(join(root, 'assets', 'brand', 'wordmark-secondary.svg'), 'utf8');
const wmBox = wordmark.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
const wmInner = wordmark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
/** The word mark `width` wide with its left edge at x, vertically centred on cy (its padding is part of the box). */
const mark = (x, cy, width) => {
  const height = (width * wmBox[2]) / wmBox[1];
  return `<svg x="${x}" y="${cy - height / 2}" width="${width}" height="${height}" viewBox="0 0 ${wmBox[1]} ${wmBox[2]}">${wmInner}</svg>`;
};

/** Sand with one large Solar glow whose centre lies bottom right (partly outside the image). */
const background = (w, h) => `
  <defs>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${w * 0.8}" cy="${h * 0.85}" r="${Math.hypot(w, h) * 0.5}">
      <stop offset="0" stop-color="rgb(${SOLAR})" stop-opacity=".95"/>
      <stop offset=".22" stop-color="rgb(${SOLAR})" stop-opacity=".55"/>
      <stop offset=".55" stop-color="rgb(${SOLAR})" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="${SAND}"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>`;

const wrap = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

const header = wrap(150, 57, `${background(150, 57)}${mark(4, 28.5, 92)}`);

const sidebar = wrap(164, 314, `${background(164, 314)}${mark(-4, 120, 172)}`);

const dmg = () =>
  wrap(
    660,
    400,
    `${background(660, 400)}
     <path d="M322 168l16 16-16 16" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  );

function render(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
}

/** 24-bit bottom-up BMP, alpha flattened onto white (NSIS wants no alpha). */
function bmp(rgba, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0);
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const a = rgba[s + 3] / 255;
      const d = 54 + (h - 1 - y) * row + x * 3;
      for (let k = 0; k < 3; k++) buf[d + k] = Math.round(rgba[s + 2 - k] * a + 255 * (1 - a));
    }
  }
  return buf;
}

for (const [name, svg, w, h] of [
  ['header.bmp', header, 150, 57],
  ['sidebar.bmp', sidebar, 164, 314],
]) {
  const r = render(svg, w);
  if (r.width !== w || r.height !== h) throw new Error(`${name}: ${r.width}x${r.height}`);
  writeFileSync(join(out, name), bmp(r.pixels, w, h));
}
writeFileSync(join(out, 'dmg-background.png'), render(dmg(), 660).asPng());
console.log('installer art written to src-tauri/installer/');
