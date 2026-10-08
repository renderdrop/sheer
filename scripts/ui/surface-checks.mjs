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
 * Visually hidden text (ADR-124 addendum 1 a): the sr-only pattern (clip rect(0,0,0,0), clip-path inset(50%) / inset(100%),
 * or a box of 1 px or less) is for assistive technology only, so it is no label and cannot be cut. Runs inside the page too
 * (the gate injects its source), so it uses nothing but its argument.
 * @param {{clip?:string,clipPath?:string,width:number,height:number}} s computed style values and the box size
 */
export function isVisuallyHidden(s) {
  const clip = (s.clip ?? '').replace(/\s+/g, '');
  const path = (s.clipPath ?? '').replace(/\s+/g, '');
  if (/^rect\(0(px)?,0(px)?,0(px)?,0(px)?\)$/.test(clip)) return true;
  if (/^inset\((50|100)%\)$/.test(path)) return true;
  return s.width <= 1 && s.height <= 1;
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
 * An in-field adornment (the eye of a password field, the check of the hex field; marked `data-adornment`) sits inside its field on
 * purpose (ADR-124 addendum 1 b): `adornment` is the id of its field wrapper and `field` the wrapper an input sits in.
 * @param {{id:number,name:string,rect:object,parents:number[],adornment?:number,field?:number}[]} controls
 */
export function checkControlOverlap(controls) {
  const out = [];
  for (let i = 0; i < controls.length; i++)
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.parents.includes(b.id) || b.parents.includes(a.id)) continue;
      if (a.adornment !== undefined && a.adornment === b.field) continue;
      if (b.adornment !== undefined && b.adornment === a.field) continue;
      if (overlap(a.rect, b.rect)) out.push(`${a.name} overlaps ${b.name}`);
    }
  return out;
}

/**
 * Q8/Q9.4 by surface kind. `modal`: exempt from the app behind it (inert under a scrim). `menubar` (ADR-124 addendum 1 c): a menu
 * opened from the menu bar follows the OS menu convention: it may cover the toolbar and the active tool below it, but never its
 * own anchor. `popover` (menus too): may not intersect its anchor, the active tool or the focused input (the protected rects with role anchor/active/focus); other controls below it
 * are allowed. Every kind: no other floating surface (tooltip, tip, coach mark, toast).
 * @param {'modal'|'popover'|'menubar'} kind
 * @param {object} surface rect
 * @param {{name:string,rect:object}[]} layers
 * @param {{name:string,rect:object,role:'anchor'|'active'|'focus'|'other'}[]} protectedRects
 */
export function checkOverlap(kind, surface, layers, protectedRects) {
  const out = [];
  for (const l of layers) if (overlap(surface, l.rect)) out.push(`overlaps ${l.name}`);
  if (kind === 'popover' || kind === 'menubar')
    for (const p of protectedRects)
      if ((kind === 'popover' ? p.role !== 'other' : p.role === 'anchor') && overlap(surface, p.rect))
        out.push(`covers ${p.role} ${p.name}`);
  return out;
}

/** Q8: a notice (tip, coach mark, toast) may not intersect any protected rect (inputs, buttons, toolbar items, active tool). */
export function checkNotice(notice, protectedRects) {
  return protectedRects.filter((p) => overlap(notice.rect, p.rect)).map((p) => `${notice.name} covers ${p.name}`);
}

/**
 * Control label wraps: the text box of a button's (or other control's) label is taller than 1.5 lines. Controls are one line by
 * design (DESIGN Q3, Q7): a label that wraps means the control is too narrow. `height` is the bounding height of the label's text
 * (a Range over its text nodes, no padding), `lineHeight` its computed line height in px.
 * @param {{name:string,height:number,lineHeight:number}[]} labels
 */
export const LABEL_SELECTOR =
  'button,[role="button"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/** True for the elements whose text is a control label (never a paragraph or other body text). */
export function isControlLabel(tag, role) {
  if (tag.toLowerCase() === 'button') return true;
  return ['button', 'radio', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(role ?? '');
}

export function checkLabelWrap(labels) {
  return labels
    .filter((l) => l.lineHeight > 0 && l.height > 1.5 * l.lineHeight)
    .map((l) => `${l.name} label wraps (${l.height.toFixed(1)} > 1.5 x ${l.lineHeight.toFixed(1)})`);
}

/** One table row per check of a surface. */
export function rowsFor(id, results) {
  return Object.entries(results).map(([check, v]) => ({
    surface: id,
    check,
    result: v.length === 0 ? 'PASS' : `FAIL ${v.slice(0, 3).join('; ')}${v.length > 3 ? ` (+${v.length - 3})` : ''}`,
  }));
}

/**
 * Split buttons (a main part and a chevron part in one outer contour, `[data-split]`): in the hover and the pressed state every painted
 * descendant (a box with a background, border or shadow, and the children) must lie inside the button's own box, and the box must not
 * change size between rest and that state. Slack 0.5 px.
 * @param {{name:string,rest:{left:number,top:number,right:number,bottom:number},states:{state:string,rect:object,painted:{name:string,rect:object}[]}[]}[]} buttons
 */
export function checkSplitButtons(buttons) {
  const tol = 0.5;
  const out = [];
  for (const b of buttons) {
    const w = b.rest.right - b.rest.left;
    const h = b.rest.bottom - b.rest.top;
    for (const s of b.states) {
      const sw = s.rect.right - s.rect.left;
      const sh = s.rect.bottom - s.rect.top;
      if (Math.abs(sw - w) > tol || Math.abs(sh - h) > tol)
        out.push(
          `${b.name} changes size on ${s.state} (${w.toFixed(1)}x${h.toFixed(1)} to ${sw.toFixed(1)}x${sh.toFixed(1)})`,
        );
      for (const p of s.painted)
        if (
          p.rect.left < s.rect.left - tol ||
          p.rect.top < s.rect.top - tol ||
          p.rect.right > s.rect.right + tol ||
          p.rect.bottom > s.rect.bottom + tol
        )
          out.push(`${b.name} on ${s.state}: ${p.name} spills past the outline`);
    }
  }
  return out;
}

/**
 * Hover geometry of toolbar and mode buttons (F19.2): the hover background must be exactly the button's geometry. For each button the
 * boxes that paint in the hover state (the button itself, its ::before / ::after, the outer box-shadow spread, descendants with a
 * background) must lie inside the button's own rest border box AND inside its toolbar container, with 0 px tolerance (`EPS` only
 * absorbs float noise from the layout engine). Any violation is a blocker. A container that scrolls sideways (the document tab strip
 * past its minimum tab width) scrolls in whole pixels over its integer `clientWidth` while its box may end on a fraction: scrolled
 * fully to the end, its last tab ends up to 1 px past the fractional edge, clipped by the strip (FX-6). Such a container
 * (`scrollClientWidth` set) reaches to `left + clientWidth`.
 * @param {{name:string,box:object,container:object,scrollClientWidth?:number,hover:{box:object,paints:{name:string,rect:object}[]}}[]} items
 */
export const HOVER_EPS = 0.01;
export function checkHoverGeometry(items) {
  const out = [];
  const inside = (r, outer) =>
    r.left >= outer.left - HOVER_EPS &&
    r.top >= outer.top - HOVER_EPS &&
    r.right <= outer.right + HOVER_EPS &&
    r.bottom <= outer.bottom + HOVER_EPS;
  for (const raw of items) {
    const it =
      raw.scrollClientWidth === undefined
        ? raw
        : {
            ...raw,
            container: {
              ...raw.container,
              right: Math.max(raw.container.right, raw.container.left + raw.scrollClientWidth),
            },
          };
    if (!inside(it.hover.box, it.box)) out.push(`${it.name}: hover box differs from the button's own box`);
    if (!inside(it.box, it.container)) out.push(`${it.name}: lies outside its toolbar`);
    for (const p of it.hover.paints) {
      if (!inside(p.rect, it.box)) out.push(`${it.name}: hover ${p.name} spills past the button`);
      else if (!inside(p.rect, it.container)) out.push(`${it.name}: hover ${p.name} spills past the toolbar`);
    }
  }
  return out;
}
