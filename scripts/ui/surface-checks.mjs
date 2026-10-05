// Pure checks of the surface gate (F17.10, DESIGN §3.9 Q7-Q9), fed with plain data that scripts/ui/surface-gate.mjs collects in the page.
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
 * Q9.2 cut-off: a control not fully inside the viewport and every clipping ancestor, or whose label is wider than its box
 * (ellipsis included). A control in a list scroller is measured against the clips outside the list; the page adds the list itself
 * as a control, so a row scrolled out of a fully visible list is no violation.
 * @param {{name:string,rect:object,clips:object[],label?:{scrollWidth:number,clientWidth:number}|null}[]} controls
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
    else if (c.label && c.label.scrollWidth > c.label.clientWidth + TOL)
      out.push(`${c.name} label is cut (${c.label.scrollWidth} > ${c.label.clientWidth})`);
  }
  return out;
}

/**
 * Q9.3 internal scroll: computed overflow-y auto/scroll with scrollHeight > clientHeight + 1 on a non-list.
 * Lists (role list, listbox, menu, tree, grid, data-scroll="list") may scroll.
 * @param {{name:string,scrollHeight:number,clientHeight:number,overflowY?:string,isList:boolean}[]} containers
 */
export function checkScroll(containers) {
  return containers
    .filter(
      (c) =>
        !c.isList &&
        (c.overflowY === undefined || c.overflowY === 'auto' || c.overflowY === 'scroll') &&
        c.scrollHeight > c.clientHeight + TOL,
    )
    .map((c) => `${c.name} scrolls inside (${c.scrollHeight} > ${c.clientHeight})`);
}

/**
 * Q9.1 horizontal overflow: a non-list element with scrollWidth > clientWidth.
 * @param {{name:string,scrollWidth:number,clientWidth:number,isList:boolean}[]} elements
 */
export function checkHScroll(elements) {
  return elements
    .filter((c) => !c.isList && c.scrollWidth > c.clientWidth + TOL)
    .map((c) => `${c.name} overflows sideways (${c.scrollWidth} > ${c.clientWidth})`);
}

/** Q9.1: a descendant rect that leaves the surface rect. */
export function checkDescendants(surface, descendants) {
  return descendants
    .filter(
      (d) =>
        d.rect.left < surface.left - TOL ||
        d.rect.top < surface.top - TOL ||
        d.rect.right > surface.right + TOL ||
        d.rect.bottom > surface.bottom + TOL,
    )
    .map((d) => `${d.name} leaves the surface`);
}

/** The overlap of two rects in pixels (width and height), or null when they only touch or are apart. */
export function overlap(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > TOL && h > TOL ? { w, h } : null;
}

/**
 * Q9.4 first clause: two interactive elements that are not nested intersect. `parents` lists the ids of the controls containing one.
 * @param {{id:number,name:string,rect:object,parents:number[]}[]} controls
 */
export function checkControlOverlap(controls) {
  const out = [];
  for (let i = 0; i < controls.length; i++)
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.parents.includes(b.id) || b.parents.includes(a.id)) continue;
      if (overlap(a.rect, b.rect)) out.push(`${a.name} overlaps ${b.name}`);
    }
  return out;
}

/**
 * Q8/Q9.4 by surface kind. `modal`: exempt from the app behind it (inert under a scrim). `popover` (menus too): may not intersect
 * its anchor, the active tool or the focused input (the protected rects with role anchor/active/focus); other controls below it
 * are allowed. Every kind: no other floating surface (tooltip, tip, coach mark, toast).
 * @param {'modal'|'popover'} kind
 * @param {object} surface rect
 * @param {{name:string,rect:object}[]} layers
 * @param {{name:string,rect:object,role:'anchor'|'active'|'focus'|'other'}[]} protectedRects
 */
export function checkOverlap(kind, surface, layers, protectedRects) {
  const out = [];
  for (const l of layers) if (overlap(surface, l.rect)) out.push(`overlaps ${l.name}`);
  if (kind === 'popover')
    for (const p of protectedRects)
      if (p.role !== 'other' && overlap(surface, p.rect)) out.push(`covers ${p.role} ${p.name}`);
  return out;
}

/** Q8: a notice (tip, coach mark, toast) may not intersect any protected rect (inputs, buttons, toolbar items, active tool). */
export function checkNotice(notice, protectedRects) {
  return protectedRects.filter((p) => overlap(notice.rect, p.rect)).map((p) => `${notice.name} covers ${p.name}`);
}

/** One table row per check of a surface. */
export function rowsFor(id, results) {
  return Object.entries(results).map(([check, v]) => ({
    surface: id,
    check,
    result: v.length === 0 ? 'PASS' : `FAIL ${v.slice(0, 3).join('; ')}${v.length > 3 ? ` (+${v.length - 3})` : ''}`,
  }));
}
