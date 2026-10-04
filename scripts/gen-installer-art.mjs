// Generates the installer and disk-image artwork from assets/brand/logo.svg (DESIGN 3.51, ADR-053 section 5).
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

// Tokens (DESIGN 1.1, 1.10): bg-gradient light, field a, field c, ground shadow, iris-300.
const GRAD_FROM = '#E1E2FF';
const GRAD_TO = '#F4F5FF';
const IRIS_300 = '#8E8EF2';

const mark = (x, y, size) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 512 512">${logoInner}</svg>`;

const background = (w, h, fieldA, fieldC) => `
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="${h}">
      <stop offset="0" stop-color="${GRAD_FROM}"/><stop offset="1" stop-color="${GRAD_TO}"/>
    </linearGradient>
    <radialGradient id="a"><stop offset="0" stop-color="rgb(142,142,242)" stop-opacity=".32"/><stop offset="1" stop-color="rgb(142,142,242)" stop-opacity="0"/></radialGradient>
    <radialGradient id="c"><stop offset="0" stop-color="rgb(201,202,255)" stop-opacity=".40"/><stop offset="1" stop-color="rgb(201,202,255)" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <ellipse cx="${fieldA.cx}" cy="${fieldA.cy}" rx="${fieldA.rx}" ry="${fieldA.ry}" fill="url(#a)"/>
  <ellipse cx="${fieldC.cx}" cy="${fieldC.cy}" rx="${fieldC.r}" ry="${fieldC.r}" fill="url(#c)"/>`;

const wrap = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

const header = wrap(150, 57, `<rect width="150" height="57" fill="#FFFFFF"/>${mark(102, 8, 40)}`);

const sidebar = wrap(
  164,
  314,
  `${background(164, 314, { cx: 164 * 0.08 + 120, cy: 60, rx: 120, ry: 60 }, { cx: 80, cy: 314 - 80, r: 80 })}
   <ellipse cx="82" cy="180" rx="40" ry="3" fill="rgb(40,40,90)" fill-opacity=".18"/>
   ${mark(34, 72, 96)}`,
);

const dmg = () =>
  wrap(
    660,
    400,
    `${background(660, 400, { cx: 660 * 0.08 + 360, cy: 120, rx: 360, ry: 120 }, { cx: 80, cy: 320, r: 80 })}
     <path d="M322 168l16 16-16 16" fill="none" stroke="${IRIS_300}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
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
