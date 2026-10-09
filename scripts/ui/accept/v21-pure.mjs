// Pure helpers of the v2.1 acceptance (scripts/ui/accept/v21.mjs, F21 in docs/FEEDBACK.md, ADR-145). No I/O; unit-tested in
// ../v21.test.ts. Generated documents only (rule 13); the owner corpus is addressed by ID only (rule 16).
import { deflateSync } from 'node:zlib';
import { buildPdf, textOps } from './v20rc3-pure.mjs';

export { plainPdf, parseRgb, colourClose, rgbIs, turnAngles, insideRect } from './v20final-pure.mjs';

/** Native window sizes of every phase (outer window, physical px) and the extra size of the glow gate. */
export const SIZES = [
  [1280, 800],
  [960, 640],
];
export const GLOW_SIZES = [...SIZES, [1600, 1000]];

/** Whether two rects {l, t, r, b} agree on every edge within `tol` px. */
export const rectsEqual = (a, b, tol = 1) =>
  !!a && !!b && ['l', 't', 'r', 'b'].every((k) => Math.abs(a[k] - b[k]) <= tol);

/**
 * Where the page's client area starts inside a window capture (PrintWindow of the outer rect), in capture px. The invisible resize
 * borders are symmetric, so the left border is half the width difference and the bottom border equals it; the rest is the title bar.
 */
export function clientOrigin(win, innerW, innerH, dpr) {
  const border = Math.max(0, (win.w - innerW * dpr) / 2);
  return { x: border, y: Math.max(0, win.h - innerH * dpr - border) };
}

/** Largest per-channel difference between neighbouring [r, g, b] samples of a line. 0 for fewer than two samples. */
export function maxNeighbourDelta(samples) {
  let worst = 0;
  for (let i = 1; i < samples.length; i++)
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(samples[i][c] - samples[i - 1][c]));
  return worst;
}

/** F21.1 verdict on sampled lines ({name, samples}): no neighbour step above `bound`. */
export function glowLinesVerdict(lines, bound = 6) {
  const per = lines.map((l) => ({ name: l.name, delta: maxNeighbourDelta(l.samples) }));
  const worst = per.reduce((m, p) => Math.max(m, p.delta), 0);
  return { ok: per.length > 0 && worst <= bound, worst, per };
}

/** The mode id of a Tools view group (`tools-group-comment` -> `comment`). */
export const modeOfGroupId = (id) => /^tools-group-([a-z]+)$/.exec(String(id))?.[1] ?? null;

/** Tiles that open a dialog instead of a document with an active tool (images to PDF opens no file at all). */
export const NO_DOCUMENT_TOOLS = new Set(['images']);
/** Tiles that take several files from the picker. */
export const IDLE_READY_TOOLS = new Set(['pages', 'form']);
export const MULTI_FILE_TOOLS = new Set(['merge']);

/**
 * F21.3 verdict for one tile after its click. `s`: { doc, modeSelected, pressed, inspector, dialog }.
 * Ready = a document is open (unless the tool needs none), the card's mode tab is selected, and the tool is active (aria-pressed) or its
 * inspector or dialog is open.
 */
export function toolReady(id, s) {
  const needsDoc = !NO_DOCUMENT_TOOLS.has(id) && !MULTI_FILE_TOOLS.has(id);
  // The page grid is Pages' idle tool, and a form without fields only shows a note (hub.noFields): the mode switch is their readiness.
  const active = !!(s.pressed || s.inspector || s.dialog) || IDLE_READY_TOOLS.has(id);
  const modeOk = NO_DOCUMENT_TOOLS.has(id) || MULTI_FILE_TOOLS.has(id) || !!s.modeSelected;
  return { ok: (!needsDoc || !!s.doc) && modeOk && active, needsDoc, active, modeOk };
}

/** A page of Letter size whose footer is drawn in red at the default footer position (margin 24, size 10; DESIGN hf). */
export const FOOTER_MARGIN = 24;
export const FOOTER_BASELINE = 26.1; // from the bottom: margin 24 + descent 0.21 * 10
export const OLD_FOOTER = 'OLDFOOTER-OLDFOOTER-OLDFOOTER-OLDFOOTER';

/** F21.7 test document: body text in black and an old footer in red (so it can be told from the new black text in a capture). */
export function footedPdf() {
  const body = textOps([
    [72, 700, 14, 'Footer test page first line'],
    [72, 680, 14, 'Second line of body text here'],
  ]);
  const footer = `1 0 0 rg BT /F1 11 Tf 1 0 0 1 ${FOOTER_MARGIN} ${FOOTER_BASELINE} Tm (${OLD_FOOTER}) Tj ET 0 g`;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    { data: `${body} ${footer}` },
  ]);
}

/** Counts pixels of a rect {x0, y0, x1, y1} (capture px, end exclusive) for which `pred([r, g, b])` holds. */
export function countPixels(rgbAt, rect, pred) {
  let n = 0;
  for (let y = Math.floor(rect.y0); y < Math.ceil(rect.y1); y++)
    for (let x = Math.floor(rect.x0); x < Math.ceil(rect.x1); x++) if (pred(rgbAt(x, y))) n++;
  return n;
}
export const isRed = ([r, g, b]) => r > 170 && g < 110 && b < 110;
export const isDark = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b < 100;

/** The rect of a PDF region (pt from the left, pt from the bottom, 792 pt page) in capture px, for a page drawn at `scale` px per pt. */
export function pdfRegion(page, scale, x0, x1, bottom0, bottom1, pageHeight = 792) {
  return {
    x0: page.l * scale + x0 * scale,
    x1: page.l * scale + x1 * scale,
    y0: page.t * scale + (pageHeight - bottom1) * scale,
    y1: page.t * scale + (pageHeight - bottom0) * scale,
  };
}

/** F21.7 verdict: no old (red) pixels under the box, old pixels still there outside it, new (dark) text present in the box. */
export function footerVerdict({ redUnder, redOutside, darkUnder }) {
  return { ok: redUnder === 0 && redOutside > 15 && darkUnder > 15, redUnder, redOutside, darkUnder };
}

/** Distance between the first and the last point of a polyline. */
export function endGap(pts) {
  if (pts.length < 2) return Number.POSITIVE_INFINITY;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y);
}
export const pathLength = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

/** A stroke is closed when its ends meet within 1 % of its length (and at least 0.5 pt of slack). */
export const isClosedStroke = (pts) => pts.length >= 4 && endGap(pts) <= Math.max(0.5, 0.01 * pathLength(pts));

/**
 * Turn angle in degrees where a closed stroke meets itself: between the segment that arrives at the end and the one that leaves the
 * start. A repeated end point (last equals first) is skipped.
 */
export function seamTurnDeg(pts) {
  const n = pts.length;
  if (n < 4) return 180;
  const dup = Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) < 1e-6;
  const before = pts[dup ? n - 2 : n - 1];
  const at = pts[0];
  const after = pts[1];
  const ax = at.x - before.x;
  const ay = at.y - before.y;
  const bx = after.x - at.x;
  const by = after.y - at.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** F21.5 verdict for one saved ink stroke. */
export function seamVerdict(pts, maxDeg = 15) {
  const closed = isClosedStroke(pts);
  const turn = closed ? seamTurnDeg(pts) : 180;
  return { ok: closed && turn < maxDeg, closed, turn: Number(turn.toFixed(1)), gap: Number(endGap(pts).toFixed(2)) };
}

/** Hand-drawn test strokes in page points: [{ x, y }] with a wobble of `noise` pt and a small gap or overlap at the ends. */
export function shapeStroke(kind, cx, cy, size, seed = 1) {
  const wob = (i) => Math.sin(i * 12.9898 + seed * 7.1) * 1.2 + Math.sin(i * 0.31 + seed) * 1.6;
  const pts = [];
  const circle = (rx, ry, turns, rot = 0, n = 90) => {
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 * turns - Math.PI / 2;
      const r = 1 + wob(i) / size;
      const x = Math.cos(a) * rx * r;
      const y = Math.sin(a) * ry * r;
      pts.push({ x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) });
    }
  };
  const polygon = (corners, per = 28) => {
    const ring = [...corners, corners[0]];
    let i = 0;
    for (let k = 0; k + 1 < ring.length; k++)
      for (let j = 0; j < per; j++, i++) {
        const t = j / per;
        pts.push({
          x: cx + ring[k][0] + (ring[k + 1][0] - ring[k][0]) * t + wob(i) * 0.5,
          y: cy + ring[k][1] + (ring[k + 1][1] - ring[k][1]) * t + wob(i + 40) * 0.5,
        });
      }
    // stops short of the start: the ends are left a few points apart, like a real stroke
  };
  const h = size / 2;
  if (kind === 'circle') circle(h, h, 0.97);
  else if (kind === 'ellipse') circle(h * 1.5, h * 0.8, 0.97, 0.35);
  else if (kind === 'rectangle')
    polygon([
      [-h * 1.3, -h * 0.8],
      [h * 1.3, -h * 0.8],
      [h * 1.3, h * 0.8],
      [-h * 1.3, h * 0.8],
    ]);
  else if (kind === 'triangle')
    polygon([
      [0, -h],
      [h * 1.1, h * 0.8],
      [-h * 1.1, h * 0.8],
    ]);
  else circle(h, h, 1.3); // overlapping circle: the end passes the start
  return pts;
}

/**
 * F21.8: share of "solid dark" cells among the cells that hold any ink, over a rect {x0, y0, x1, y1} of a capture. A cell is solid when
 * every pixel is darker than `dark` (luminance); clogged bold headings produce such blocks, anti-aliased glyphs do not.
 */
export function darkBlockStats(lumAt, rect, cell = 3, dark = 70, ink = 160) {
  let cells = 0;
  let inked = 0;
  let solid = 0;
  for (let y = Math.floor(rect.y0); y + cell <= Math.ceil(rect.y1); y += cell)
    for (let x = Math.floor(rect.x0); x + cell <= Math.ceil(rect.x1); x += cell) {
      cells++;
      let min = 255;
      let max = 0;
      for (let dy = 0; dy < cell; dy++)
        for (let dx = 0; dx < cell; dx++) {
          const v = lumAt(x + dx, y + dy);
          if (v < min) min = v;
          if (v > max) max = v;
        }
      if (min < ink) inked++;
      if (max < dark) solid++;
    }
  return { cells, inked, solid, ratio: inked === 0 ? 0 : solid / inked };
}

/** F21.8 verdict: some ink, and solid blocks are rare among the inked cells. */
export function thumbVerdict(stats, maxRatio = 0.15) {
  return { ok: stats.inked > 0 && stats.ratio <= maxRatio, ...stats, ratio: Number(stats.ratio.toFixed(3)) };
}

/** F21.6 tooltip timing: hidden after 50 ms, shown after 250 ms (the mode card's delay is 150 ms). */
export const tooltipTimingOk = (at50, at250) => at50 === false && at250 === true;

/** F21.6: a tool item shows no label when its visible text is empty. */
export const iconOnly = (texts) => texts.length > 0 && texts.every((t) => String(t).trim() === '');

/** The Show labels card height (106) and the icons-only one (98), with 1 px slack. */
export const CARD_HEIGHT = { labels: 106, icons: 98 };
export const heightIs = (h, want) => Math.abs(h - want) <= 1;

/** A tiny valid PNG (16 x 16, grey) for the picker answers of the image tools. */
export function tinyPng() {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8; // bit depth 8, colour type 0 = grey
  const rows = Buffer.concat(
    Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 128)])),
  );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
