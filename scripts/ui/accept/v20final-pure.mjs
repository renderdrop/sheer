// Pure helpers of the v2.0.0 final acceptance (scripts/ui/accept/v20final.mjs, F20 in docs/FEEDBACK.md). No I/O; unit-tested in
// ../v20final.test.ts. Generated documents come from v20rc3-pure.mjs (rule 13).
export { plainPdf, parseRgb } from './v20rc3-pure.mjs';

export const SIZES = [
  [1280, 800],
  [960, 640],
];
/** The chrome background of F20.9 (#FAFAF8). */
export const CHROME_RGB = [250, 250, 248];

/** Whether a computed colour string is exactly rgb(r, g, b) (alpha 1 or absent). */
export function rgbIs(css, want) {
  const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)$/.exec(String(css).trim());
  if (!m) return false;
  if (m[4] !== undefined && Number(m[4]) !== 1) return false;
  return want.every((c, i) => Number(m[i + 1]) === c);
}

/** Whether two [r, g, b] colours differ by at most `tol` per channel. */
export const colourClose = (a, b, tol = 10) =>
  a.length === 3 && b.length === 3 && a.every((c, i) => Math.abs(c - b[i]) <= tol);

/** Whether rect `r` ({l,t,r,b}) lies inside `box` within `tol` px. */
export const insideRect = (r, box, tol = 1) =>
  r.l >= box.l - tol && r.t >= box.t - tol && r.r <= box.r + tol && r.b <= box.b + tol;

/** Groups the rendered characters ([{ ch, top }]) into lines by their top; returns the line texts, whitespace-normalised. */
export function linesOfChars(chars, tol = 3) {
  const lines = [];
  for (const c of chars) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.top - c.top) <= tol) last.text += c.ch;
    else lines.push({ top: c.top, text: c.ch });
  }
  return lines.map((l) => l.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** A title is never split when every line break falls between words: the lines joined by a blank give the title back. */
export const titleNeverSplit = (lines, title) =>
  lines.length > 0 && lines.join(' ') === String(title).replace(/\s+/g, ' ').trim();

/** Number of distinct columns (rounded lefts) of a set of rects. */
export const columnsOf = (rects) => new Set(rects.map((r) => Math.round(r.l / 4))).size;

/** Four columns of two rows at/above the container width that fits four tiles, else two columns of four rows (F20.2). */
export function expectedTileGrid(containerWidth, fourColsMin = 784) {
  return containerWidth >= fourColsMin ? { cols: 4, rows: 2 } : { cols: 2, rows: 4 };
}

/** F20.3: the image is sharp when its natural size covers the displayed size times the device pixel ratio (object-contain). */
export function thumbSharp(natW, natH, boxW, boxH, dpr, slack = 0.97) {
  if (!(natW > 0 && natH > 0 && boxW > 0 && boxH > 0)) return false;
  const shown = Math.min(boxW / natW, boxH / natH);
  return shown * dpr <= 1 / slack;
}

/** Turning angles (radians, 0..pi) between successive segments of a polyline of {x, y}. */
export function turnAngles(pts) {
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x;
    const by = pts[i + 1].y - pts[i].y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    out.push(Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))));
  }
  return out;
}

/** F20.4 verdict: fewer stored points than input samples and no sharp kink (largest turn below `maxTurn`). */
export function strokeSmooth(stored, inputCount, maxTurn = 0.6) {
  const turns = turnAngles(stored);
  const worst = turns.length ? Math.max(...turns) : 0;
  return { ok: stored.length >= 2 && stored.length < inputCount && worst <= maxTurn, points: stored.length, worst };
}

/** Takes the points of a stroke from whatever the annotation list returns ({points:[{x,y}]} or [[x,y]]). */
export function strokePoints(stroke) {
  const raw = stroke?.points ?? stroke;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y }));
}

/** F20.6: a series of scrollTop values rises (almost) monotonically and no step exceeds `maxJump`; at least one step moves. */
export function followsSmoothly(series, maxJump, backTol = 1) {
  const deltas = series.slice(1).map((v, i) => v - series[i]);
  const monotonic = deltas.every((d) => d >= -backTol);
  const worst = deltas.length ? Math.max(...deltas.map(Math.abs)) : 0;
  return { ok: monotonic && worst <= maxJump && deltas.some((d) => d > 0), worst, monotonic };
}

/** Clamp of the inspector width (F20.8). */
export const clampInspector = (w) => Math.max(240, Math.min(480, w));

/** A hex field value of 3 or 6 digits (a leading # allowed). */
export const validHex = (s) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(s).trim());

/** The zoom text normalised (non-breaking blanks to a plain blank). */
export const zoomText = (s) =>
  String(s)
    .replace(/[\s  ]+/g, ' ')
    .trim();
