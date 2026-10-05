// Pure checks of the surface gate (F17.10), fed with plain data that scripts/ui/surface-gate.mjs collects in the page.
// A rect is { left, top, right, bottom } in viewport pixels. Every check returns a list of violation strings (empty = pass).
/** Sub-pixel layout and borders: one pixel of slack, no more. */
export const TOL = 1;

/** @param {{left:number,top:number,right:number,bottom:number}} r @param {{w:number,h:number}} vp */
export function checkInViewport(r, vp) {
  const out = [];
  if (r.left < -TOL) out.push(`left edge ${r.left.toFixed(1)} is outside the viewport`);
  if (r.top < -TOL) out.push(`top edge ${r.top.toFixed(1)} is outside the viewport`);
  if (r.right > vp.w + TOL) out.push(`right edge ${r.right.toFixed(1)} exceeds the width ${vp.w}`);
  if (r.bottom > vp.h + TOL) out.push(`bottom edge ${r.bottom.toFixed(1)} exceeds the height ${vp.h}`);
  return out;
}

/**
 * Controls cut off by an ancestor that clips (overflow hidden, auto, scroll, clip) or by the viewport.
 * @param {{name:string,rect:object,clips:object[]}[]} controls `clips` holds the rects of the clipping ancestors
 * @param {{w:number,h:number}} vp
 */
export function checkClipped(controls, vp) {
  const out = [];
  for (const c of controls) {
    const bounds = [{ left: 0, top: 0, right: vp.w, bottom: vp.h }, ...c.clips];
    const cut = bounds.some(
      (b) =>
        c.rect.left < b.left - TOL ||
        c.rect.top < b.top - TOL ||
        c.rect.right > b.right + TOL ||
        c.rect.bottom > b.bottom + TOL,
    );
    if (cut) out.push(`${c.name} is clipped`);
  }
  return out;
}

/**
 * Internal scroll: a container taller than its box. Lists (role list, listbox, grid, tree, data-scroll="list") may scroll.
 * @param {{name:string,scrollHeight:number,clientHeight:number,isList:boolean}[]} containers
 */
export function checkScroll(containers) {
  return containers
    .filter((c) => !c.isList && c.scrollHeight > c.clientHeight + TOL)
    .map((c) => `${c.name} scrolls inside (${c.scrollHeight} > ${c.clientHeight})`);
}

/** The overlap of two rects in pixels (width and height), or null when they only touch or are apart. */
export function overlap(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > TOL && h > TOL ? { w, h } : null;
}

/**
 * The surface must not sit on another floating layer (tooltip, tip, coach mark) nor on a control outside it.
 * `outside` is empty for a modal dialog: the app behind a modal is inert and covered by design.
 * @param {object} surface rect
 * @param {{name:string,rect:object}[]} layers
 * @param {{name:string,rect:object}[]} outside
 */
export function checkOverlap(surface, layers, outside) {
  const out = [];
  for (const l of layers) if (overlap(surface, l.rect)) out.push(`overlaps ${l.name}`);
  for (const o of outside) if (overlap(surface, o.rect)) out.push(`covers ${o.name}`);
  return out;
}

/** One table row per check of a surface. */
export function rowsFor(id, results) {
  return Object.entries(results).map(([check, v]) => ({
    surface: id,
    check,
    result: v.length === 0 ? 'PASS' : `FAIL ${v.slice(0, 3).join('; ')}${v.length > 3 ? ` (+${v.length - 3})` : ''}`,
  }));
}
