// Surface gate (F17.10, ADR-124 point 6). Node 22, built-ins only. Needs the dev window: `node scripts/ui/dev.mjs` (CDP 127.0.0.1:9222).
// Sets the viewport to 960x640 (plus 1280x800 with --wide), opens tests/fixtures/text.pdf, then opens every surface and checks it:
//   inside   the surface lies inside the viewport
//   clipped  no button/input/select/textarea inside it is cut by an overflow ancestor or by the viewport
//   scroll   no container with overflow-y auto/scroll and scrollHeight > clientHeight + 1 (lists excepted: role list|listbox|menu|tree|grid or data-scroll="list")
//   overlap  Q8: a popover/menu may not cover its anchor, the active tool or the focused input (other controls below are fine); no two floating
//            surfaces intersect; notices may not cover any protected rect; modals cover the inert app by design
//   wrap     no control label (button, radio, tab, menu item) is taller than 1.5 lines (the label wraps)
//   split    every split button ([data-split]) in hover and pressed: all its parts stay inside its own box (0.5 px) and the box keeps its size
//   contour  every split tool, main and chevron part, in inactive / inactive+hover / active / active+hover: one outer contour,
//            hover changes only the background of the hovered half (F19.27)
//   hover    every toolbar and mode button hovered over CDP: its hover paints (box, ::before/::after, shadow spread, backgrounds) lie inside
//            the button box and its toolbar, 0 px tolerance (F19.2)
// Also registered: the ink mini bar, its colour popover and every coach mark step (floating surfaces that are no dialog).
// Runs once per UI language (en, then de, via the locale store). Disabled triggers are logged SKIP.
// Surfaces: the dev registry `window.__sheerSurfaces` (src/dev/surfaces.ts: dialogs, sheets) and every popover/menu trigger on screen
// (`aria-haspopup`), swept in each mode. Usage: node scripts/ui/surface-gate.mjs [--wide] [--only <substring>]   exit 1 on any violation.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import {
  checkClipped,
  checkControlOverlap,
  checkDescendants,
  checkHScroll,
  checkHoverGeometry,
  checkInViewport,
  checkLabelWrap,
  LABEL_SELECTOR,
  checkNotice,
  checkOverlap,
  checkPanelOverlap,
  checkScroll,
  checkSplitButtons,
  checkSplitContour,
  isVisuallyHidden,
  rowsFor,
} from './surface-checks.mjs';

const BASE = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`;
const root = resolve(import.meta.dirname, '..', '..');
const exe = resolve(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'sheer.exe' : 'sheer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const sizes = [{ w: 960, h: 640 }, ...(args.includes('--wide') ? [{ w: 1280, h: 800 }] : [])];
let current = sizes[0];
let lang = 'en';

const targets = await (await fetch(`${BASE}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
if (!page) throw new Error('no page target; run `node scripts/ui/dev.mjs` first');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket failed'));
});
let n = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails)
    throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return m.result?.result?.value;
};
const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
};

/** Runs inside the page. Everything comes back as plain data; the verdicts are the pure functions of surface-checks.mjs. */
const PAGE = `(() => {
  // The mini bar (toolbar) and the coach mark card (region) are floating surfaces of their own: registry entries open them.
  const SURFACES = '[role="dialog"],[role="alertdialog"],[role="menu"],[data-minibar],[data-tour-card],[data-surface="textedit-notice"],[data-surface="textedit-refusal"],[data-surface="link-preview"],[data-surface="range-chooser"],[data-surface="ocr-banner"],[data-toast],[data-slot="inspector"][data-open]';
  const LIST = '[role="list"],[role="listbox"],[role="menu"],[role="grid"],[role="tree"],[data-scroll="list"]';
  const hidden = ${isVisuallyHidden.toString()};
  // Visible text of an element: its own text nodes, unless the element or an ancestor up to root is visually hidden (sr-only).
  const hiddenEl = (e, root) => { for (let p = e; p; p = p.parentElement) { const s = getComputedStyle(p), r = p.getBoundingClientRect(); if (hidden({ clip: s.clip, clipPath: s.clipPath, width: r.width, height: r.height })) return true; if (p === root) break; } return false; };
  const hasText = (e, root) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '') && !hiddenEl(e, root);
  const CONTROLS = 'button,input,select,textarea,[role="button"]';
  const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const visible = (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !el.closest('[inert],[aria-hidden="true"]');
  };
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28);
    return el.tagName.toLowerCase() + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : '') + (t ? ' "' + t + '"' : '');
  };
  const INSPECTOR = '[data-slot="inspector"]';
  // rc.3 (DESIGN 3.18 E5): the inspector column is a docked panel; its body may scroll like a list.
  const scrollish = (p, el) => p !== el && el.matches(INSPECTOR) && ['auto', 'scroll'].includes(getComputedStyle(p).overflowY);
  const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  // Tooltips are aria-hidden by design (a live region speaks them), so a [data-surface] tooltip counts when it is on screen.
  const shown = () => [...document.querySelectorAll(SURFACES)].filter((e) => visible(e) || (e.matches('[data-surface][role="tooltip"]') && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0));
  window.__gate = {
    mark() { window.__gateBefore = new Set(shown()); },
    // The outermost new surfaces (a popover's own submenu is part of it).
    fresh() {
      const all = shown().filter((e) => !window.__gateBefore.has(e) && (!window.__gatePick || e.matches(window.__gatePick)));
      return all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
    },
    measure() {
      const found = this.fresh();
      if (found.length === 0) return null;
      const el = found.sort((a, b) => area(b) - area(a))[0];
      const rect = R(el.getBoundingClientRect());
      const panel = el.matches(INSPECTOR);
      const isListEl = (p) => p.matches(LIST) || scrollish(p, el);
      const closestList = (c) => { for (let p = c; p && p !== el.parentElement; p = p.parentElement) if (isListEl(p)) return p; return null; };
      const modal = el.getAttribute('aria-modal') === 'true' || !!el.closest('[aria-modal="true"]');
      // ADR-124 addendum 1 c: a menu opened from the menu bar (role=menubar) follows the OS menu convention.
      const menubar = el.getAttribute('role') === 'menu' && !!document.querySelector('[role="menubar"] [aria-controls="' + el.id + '"]');
      // A mini bar and a coach mark are floating, not modal; a coach mark is a notice (Q8): it may not touch any protected rect.
      // v1.7: the OCR banner and the toasts (DESIGN 3.12 O8) are notices too: the banner never covers a page, the toast never covers Stop.
      const kind = panel ? 'panel' : el.hasAttribute('data-tour-card') || el.hasAttribute('data-toast') || ['textedit-notice', 'ocr-banner'].includes(el.getAttribute('data-surface')) ? 'notice' : el.hasAttribute('data-tour-card') ? 'notice' : el.hasAttribute('data-minibar') ? 'bar' : null;
      const onlyBig = (c) => { const r = c.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
      const clipsOf = (c) => {
        const clips = [];
        for (let p = c.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          if (isListEl(p)) continue; // a list scrolls by design; the list itself is checked as a control below
          const s = getComputedStyle(p);
          if (s.overflowX !== 'visible' || s.overflowY !== 'visible') clips.push(R(p.getBoundingClientRect()));
        }
        return clips;
      };
      const labelOf = (c) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(c.tagName)) return null;
        for (const e of [c, ...c.querySelectorAll('*')]) {
          // Only elements that carry visible text have a label to cut; sr-only text and the invisible hit-area pseudo-element of an icon-only control do not.
          if (e instanceof SVGElement || getComputedStyle(e).display === 'inline' || !hasText(e, c)) continue;
          if (e.clientWidth > 2 && e.scrollWidth > e.clientWidth + 1) return { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
        }
        return null;
      };
      const ctrl = [...el.querySelectorAll(CONTROLS + ',a[href]')].filter((c) => visible(c) && onlyBig(c));
      // A row of a list scrolled out of it is no cut-off (the list itself is checked below); its rect is held inside the list's.
      const inList = (c) => {
        const r = R(c.getBoundingClientRect());
        const l = closestList(c);
        if (!l) return r;
        const b = l.getBoundingClientRect();
        const k = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
        return k.right < k.left || k.bottom < k.top ? R(b) : k;
      };
      const controls = ctrl.map((c) => ({ name: name(c), rect: inList(c), clips: clipsOf(c), label: labelOf(c) }));
      for (const l of new Set(ctrl.map((c) => closestList(c)).filter((l) => l && visible(l))))
        controls.push({ name: name(l), rect: R(l.getBoundingClientRect()), clips: clipsOf(l), label: null });
      // ADR-124 addendum 1 b: a control inside [data-adornment] sits in its field on purpose; the field wrapper is the adornment's parent.
      const wrappers = new Map();
      const wid = (w) => { if (!wrappers.has(w)) wrappers.set(w, wrappers.size); return wrappers.get(w); };
      // The part of a control that can be seen and clicked: a row scrolled out of its list (or cut by any overflow ancestor) does not overlap what lies there.
      const seen = (c) => {
        const r = R(c.getBoundingClientRect());
        for (let p = c.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
          const b = p.getBoundingClientRect();
          r.left = Math.max(r.left, b.left); r.top = Math.max(r.top, b.top);
          r.right = Math.min(r.right, b.right); r.bottom = Math.min(r.bottom, b.bottom);
        }
        return r.right < r.left || r.bottom < r.top ? { left: 0, top: 0, right: 0, bottom: 0 } : r;
      };
      const interactive = ctrl.map((c, id) => {
        const adorn = c.closest('[data-adornment]');
        const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(c.tagName);
        return {
          id, name: name(c), rect: seen(c),
          parents: ctrl.flatMap((o, j) => (o !== c && o.contains(c) ? [j] : [])),
          adornment: adorn?.parentElement ? wid(adorn.parentElement) : undefined,
          field: isField && c.parentElement ? wid(c.parentElement) : undefined,
        };
      });
      // Control label wraps: the text of a button, radio, tab or menu item (never body text) must stay on one line (a Range over its text nodes).
      const wraps = [...el.querySelectorAll(${JSON.stringify(LABEL_SELECTOR)})].filter((c) => visible(c)).flatMap((c) => {
        const out = [];
        for (const e of [c, ...c.querySelectorAll('*')]) {
          // The header/footer slot value may take two lines: three columns in the 300 px column (HeaderFooterPanel.test: never truncated).
          if (e instanceof SVGElement || !hasText(e, c) || e.closest('[data-hf-slot]')) continue;
          const range = document.createRange();
          range.selectNodeContents(e);
          const box = range.getBoundingClientRect();
          const s = getComputedStyle(e);
          const lh = parseFloat(s.lineHeight);
          out.push({ name: name(c), height: box.height, lineHeight: Number.isNaN(lh) ? parseFloat(s.fontSize) * 1.2 : lh });
        }
        return out;
      });
      const all = [el, ...el.querySelectorAll('*')].filter((c) => !(c instanceof SVGElement) && visible(c));
      const plain = all.filter((c) => !['TEXTAREA', 'INPUT', 'SELECT'].includes(c.tagName));
      const containers = plain
        .filter((c) => { const s = getComputedStyle(c); return s.overflowY === 'auto' || s.overflowY === 'scroll'; })
        .map((c) => ({ name: name(c), scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, overflowY: getComputedStyle(c).overflowY, isList: !!closestList(c) || isListEl(c) }));
      // An icon-only control may carry an invisible hit-area pseudo-element (before:-inset-1) that counts as overflow; it has no label to cut.
      const wide = plain
        .filter((c) => getComputedStyle(c).display !== 'inline' && c.clientWidth > 2 && !(c.matches(CONTROLS) && !hasText(c, c) && !c.querySelector('*:not(svg):not(svg *)')))
        .map((c) => ({ name: name(c), scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, isList: !!closestList(c) || isListEl(c) }));
      const descendants = all.filter((c) => c !== el && !closestList(c) && onlyBig(c) && getComputedStyle(c).position !== 'fixed')
        .map((c) => ({ name: name(c), rect: R(c.getBoundingClientRect()) }));
      const layerEls = [...document.querySelectorAll('[role="tooltip"],[role="region"]')]
        .filter((l) => visible(l) && !el.contains(l) && !l.contains(el))
        .filter((l) => {
          const s = getComputedStyle(l);
          return l.getAttribute('role') === 'tooltip' || ((s.position === 'fixed' || s.position === 'absolute') && area(l) < innerWidth * innerHeight / 2);
        });
      const layers = layerEls.map((l) => ({ name: name(l), rect: R(l.getBoundingClientRect()) }));
      // Q8 protected rects: the anchor, the active tool and the focused input matter for a popover; every visible control for a notice.
      const protectedRects = [];
      const focus = document.activeElement;
      const typing = (e) => e && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || e.isContentEditable);
      for (const c of document.querySelectorAll(CONTROLS + ',[contenteditable="true"],[data-toolbar-item]')) {
        if (el.contains(c) || !visible(c) || !onlyBig(c) || layerEls.some((l) => l.contains(c))) continue;
        const role = el.id && c.getAttribute('aria-controls') === el.id ? 'anchor'
          : c.getAttribute('aria-pressed') === 'true' || c.getAttribute('data-on') === 'true' ? 'active'
          : c === focus && typing(c) ? 'focus' : 'other';
        protectedRects.push({ name: name(c), rect: R(c.getBoundingClientRect()), role });
      }
      // The selection with its handles (the mini bar may not cover it) and the page content a tour step points at (a card avoids it).
      for (const c of document.querySelectorAll('[data-annot-frame],[data-annot-handle],[data-protect="notice"],[data-testid="textedit-box"]')) {
        if (el.contains(c) || !onlyBig(c)) continue;
        protectedRects.push({ name: name(c), rect: R(c.getBoundingClientRect()), role: c.hasAttribute('data-protect') ? 'other' : 'active' });
      }
      const neighbours = panel ? ['[data-action-scope="canvas"]', '[data-slot="statusbar"]', '[data-slot="tabstrip"]', '[data-slot="mode-card"]', '[data-slot="menu-row"]']
        .flatMap((q) => [...document.querySelectorAll(q)].filter((n) => visible(n) && !el.contains(n) && !n.contains(el)).map((n) => ({ name: q.replace(/.*="(.*)"\]/, '$1'), rect: R(n.getBoundingClientRect()) }))) : [];
      return { kind, neighbours, wraps, rect, modal, menubar, controls, interactive, containers, wide, descendants, layers, protectedRects, vp: { w: innerWidth, h: innerHeight } };
    },
    triggers() {
      document.querySelectorAll('[data-gate-trigger]').forEach((e) => e.removeAttribute('data-gate-trigger'));
      const all = [...document.querySelectorAll('[aria-haspopup]:not([aria-haspopup="false"])')].filter((t) => visible(t) && !t.closest(SURFACES));
      return all.map((t, i) => {
        t.setAttribute('data-gate-trigger', String(i));
        const off = t.disabled || t.getAttribute('aria-disabled') === 'true';
        return { i, name: name(t), off };
      });
    },
  };
  return true;
})()`;

const rows = [];
const verdict = (id, m) =>
  rowsFor(id, {
    inside: [...checkInViewport(m.rect, m.vp), ...checkDescendants(m.rect, m.descendants), ...checkHScroll(m.wide)],
    clipped: checkClipped(m.controls, m.vp),
    scroll: checkScroll(m.containers),
    wrap: checkLabelWrap(m.wraps),
    overlap:
      m.kind === 'panel'
        ? checkPanelOverlap(m.rect, m.neighbours)
        : [
            ...checkOverlap(m.modal ? 'modal' : m.menubar ? 'menubar' : 'popover', m.rect, m.layers, m.protectedRects),
            ...checkControlOverlap(m.interactive),
            ...m.layers.flatMap((l) => checkNotice(l, m.protectedRects)),
            // A coach mark is a notice: it may not touch any protected rect (Q8).
            ...(m.kind === 'notice' ? checkNotice({ name: 'coach mark', rect: m.rect }, m.protectedRects) : []),
          ],
  });

/** Opens with `open`, waits for the animation, measures, closes. `pick`: a selector; only a new surface matching it is measured. */
async function probe(id, open, close, pick = null) {
  if (only && !id.includes(only)) return;
  const tag = `${lang} ${id} @${current.w}x${current.h}`;
  try {
    await ev(`window.__gatePick = ${JSON.stringify(pick)}`);
    await ev(`window.__gate.mark()`);
    await open();
    let m = null;
    for (let i = 0; i < 12 && m === null; i++) {
      await sleep(150);
      m = await ev(`window.__gate.measure()`);
    }
    await sleep(500); // the entrance animation (scale, fade) must be over before a rect is read
    m = (await ev(`window.__gate.measure()`)) ?? m;
    if (m === null) rows.push({ surface: tag, check: 'opens', result: 'FAIL no dialog or menu appeared' });
    else rows.push(...verdict(tag, m));
  } catch (e) {
    rows.push({ surface: tag, check: 'opens', result: `FAIL ${String(e.message).split('\n')[0]}` });
  }
  try {
    await close();
  } catch {
    /* the Escape below ends it anyway */
  }
  await escape();
  for (let i = 0; i < 10 && (await ev(`window.__gate.fresh().length`)) > 0; i++) await sleep(100);
  await sleep(150);
}

async function sweepRegistry() {
  // The recovery banner (records of earlier dev runs) is a row of buttons above the canvas: protected for notices, it leaves a coach mark no room.
  await ev(`(async()=>{(await ${store('features/recovery/store.ts')}).useRecovery.getState().hide()})()`);
  const list = await ev(`(window.__sheerSurfaces ?? []).map((s) => s.id)`);
  if (list.length === 0)
    rows.push({ surface: 'registry', check: 'present', result: 'FAIL window.__sheerSurfaces is empty (dev build?)' });
  for (const id of list) {
    const one = `window.__sheerSurfaces.find((s) => s.id === ${JSON.stringify(id)})`;
    await probe(
      `dialog:${id}`,
      () => ev(`${one}.open()`),
      () => ev(`${one}.close()`),
    );
  }
}

const REFUSALS = [
  'signed',
  'permission',
  'type3',
  'invisible',
  'clip',
  'vertical',
  'cmap',
  'inForm',
  'actualText',
  'script',
  'notFileSource',
  'unmapped',
  'tooComplex',
  'noText',
];

/** "Edit text" (DESIGN 3.10 E11): the mini bar (with the overflow caption), the Font popover, the fallback notice and every refusal tooltip. */
async function sweepTextEdit() {
  if (only && !'textedit'.includes(only) && !only.includes('textedit')) return;
  const stores = (path) => `(await ${store(path)})`;
  const pageRect = () =>
    ev(
      `(() => { const r = document.querySelector('[data-page="1"]')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; })()`,
    );
  // The line "The quick brown fox..." of text.pdf: 72 pt from the left, baseline 152 pt from the top of a 612 x 792 page.
  const lineAt = async () => {
    // The recovery banner (records of earlier dev runs) sits above the canvas and can cover the line; the page goes to the top.
    await ev(`(async()=>{${stores('features/recovery/store.ts')}.useRecovery.getState().hide()})()`);
    await ev(`document.querySelector('[data-page="1"]')?.scrollIntoView({ block: 'start' })`);
    await sleep(400);
    const r = await pageRect();
    const k = r.width / 612;
    // The line is found through textEditLines (as the reflow probe does); the fixed 72/136 pt box stays the fallback.
    const box = await ev(
      `(async()=>{const api=await import('/src/api/textEdit.ts'); const id=${stores('stores/documents.ts')}.useDocuments.getState().activeId; const r=await api.textEditLines(id,0); const l=r.lines.find(l=>/^The quick/.test(l.text)); return l?l.box:null})()`,
    ).catch(() => null);
    const b = box ?? { x: 72, y: 136, w: 258, h: 20 };
    return {
      x: r.left + (b.x + Math.min(40, b.w / 2)) * k,
      y: r.top + (b.y + b.h / 2) * k,
      rect: { x: r.left + b.x * k, y: r.top + b.y * k, w: b.w * k, h: b.h * k },
    };
  };
  // The page sweeps (Rotate) leave the pages turned; the click position below assumes the page as the file has it.
  await ev(
    `(async()=>{const id=${stores('stores/documents.ts')}.useDocuments.getState().activeId; const turn=(await ${store('features/organize/commands.ts')}).rotatePages; const org=${stores('features/organize/store.ts')}.useOrganize;
      for (const s of ${stores('stores/pages.ts')}.readSlots(id).filter((s) => s.rotation !== 0)) {
        org.getState().setSelection(id, { selected: [s.id], anchor: null, focus: s.id });
        await turn(id, s.rotation === 90 ? -1 : s.rotation === 270 ? 1 : 2);
      }
      ${stores('stores/view.ts')}.useView.getState().setRotation(id, 0);
    })()`,
  ).catch(() => undefined);
  await ev(`(async()=>{${stores('stores/ui.ts')}.useUi.getState().setMode('edit')})()`);
  await sleep(400);
  const openLine = async () => {
    // The tool item may sit in the overflow menu at 960 px (rc.3 icon-only row): the store is the stable way in. A click on the
    // active tool releases it, so the tool is selected only when it is not on.
    await ev(
      `(async()=>{const u=${stores('stores/ui.ts')}.useUi.getState(); if (u.activeTool !== 'editText') u.selectTool('editText')})()`,
    );
    await sleep(300);
    const p = await lineAt();
    await mouse('mouseMoved', p.x, p.y, { button: 'none' });
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
    for (let i = 0; i < 20 && !(await ev(`!!document.querySelector('[data-testid="textedit-box"]')`)); i++)
      await sleep(150);
    if (!(await ev(`!!document.querySelector('[data-testid="textedit-box"]')`))) {
      const hit = await ev(
        `(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? e.tagName + ' ' + (e.getAttribute('data-testid') ?? e.getAttribute('data-textedit-surface') ?? e.className) : 'none'; })()`,
      );
      throw new Error(`the click on the line opened no edit box (element at the point: ${String(hit).slice(0, 80)})`);
    }
    await sleep(300);
  };
  await probe(
    'textedit-bar',
    async () => {
      await openLine();
      // Past the free width: the overflow caption is the widest state of the bar.
      await send('Input.insertText', {
        text: ' wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide',
      });
    },
    () => ev(`document.querySelector('[data-surface="textedit-bar"]') !== null`),
    '[data-surface="textedit-bar"]',
  );
  // v1.5.2: the widest state of the bar: Umbrechen shown (a line of a paragraph with 2+ lines) together with the overflow caption.
  // text.pdf has no paragraph of two lines (30 pt pitch); the welcome document has one on page 1. The line is found through
  // textEditLines, clicked by its box, and the gate goes back to the document it came from afterwards.
  await probe(
    'textedit-bar-reflow',
    async () => {
      const docs = stores('stores/documents.ts');
      await ev(
        `(async()=>{window.__gateDoc=${docs}.useDocuments.getState().activeId; await ${stores('features/tour/runtime.ts')}.openWelcome()})()`,
      );
      await sleep(2500);
      await ev(`(async()=>{${stores('stores/ui.ts')}.useUi.getState().setMode('edit')})()`);
      await sleep(300);
      // selectTool, not a click: a click on the active tool releases it.
      await ev(`(async()=>{${stores('stores/ui.ts')}.useUi.getState().selectTool('editText')})()`);
      await ev(`(async()=>{${stores('features/recovery/store.ts')}.useRecovery.getState().hide()})()`);
      const box = await ev(
        `(async()=>{const api=await import('/src/api/textEdit.ts'); const id=${docs}.useDocuments.getState().activeId; const r=await api.textEditLines(id,0); const c={}; r.lines.forEach(l=>c[l.paragraph]=(c[l.paragraph]||0)+1); const m=r.lines.find(l=>c[l.paragraph]>1&&l.editable.type!=='no'); return m?m.box:null})()`,
      );
      if (!box) throw new Error('no paragraph of 2+ lines in the welcome document');
      await ev(`document.querySelector('[data-page="1"]')?.scrollIntoView({ block: 'start' })`);
      await sleep(400);
      const r = await pageRect();
      const k = r.width / 612;
      const x = r.left + (box.x + Math.min(40, box.w / 2)) * k;
      const y = r.top + (box.y + box.h / 2) * k;
      await mouse('mouseMoved', x, y, { button: 'none' });
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
      let toggle = false;
      for (let i = 0; i < 15 && !toggle; i++) {
        toggle = await ev(`!!document.querySelector('[data-surface="textedit-bar"] [role="switch"]')`);
        if (!toggle) await sleep(150);
      }
      if (!toggle) throw new Error('no Umbrechen toggle on a line of a 2-line paragraph');
      await send('Input.insertText', { text: ' wide wide wide wide wide wide wide wide wide wide' });
    },
    async () => {
      await escape();
      await ev(`(async()=>{${stores('stores/documents.ts')}.useDocuments.getState().setActive(window.__gateDoc)})()`);
      await sleep(800);
    },
    '[data-surface="textedit-bar"]',
  );
  await probe(
    'textedit-font-popover',
    async () => {
      await openLine();
      await ev(`window.__gate.mark()`);
      await ev(`document.querySelector('[data-textedit-font]')?.click()`);
    },
    () => undefined,
    '[role="dialog"]',
  );
  // text.pdf embeds its fonts, so no substitute is needed there: the notice is set the way the layer sets it.
  await probe(
    'textedit-notice',
    async () => {
      await openLine();
      await ev(
        `(async()=>{${stores('features/textedit/store.ts')}.useTextEdit.getState().set({ notice: { kind: 'missingGlyphs', font: 'MinionPro-Regular', face: 'serif', chars: ['ő','ű','ł','ś','ž','ď','ť'] } })})()`,
      );
    },
    () => undefined,
    '[data-surface="textedit-notice"]',
  );
  for (const reason of REFUSALS) {
    await probe(
      `textedit-refusal:${reason}`,
      async () => {
        const p = await lineAt();
        await ev(
          `(async()=>{${stores('features/textedit/store.ts')}.useTextEdit.getState().set({ refusal: { reason: ${JSON.stringify(reason)}, rect: ${JSON.stringify(p.rect)}, via: 'click' } })})()`,
        );
      },
      () => ev(`(async()=>{${stores('features/textedit/store.ts')}.useTextEdit.getState().set({ refusal: null })})()`),
      '[data-surface="textedit-refusal"]',
    );
  }
  await ev(`(async()=>{${stores('features/textedit/store.ts')}.useTextEdit.getState().reset()})()`);
}

/**
 * rc.3 tool inspector (DESIGN 3.18 E5): the 300 px column right of the canvas holds Zuschneiden, Kopf-/Fußzeile, Stempel, Text erkennen,
 * Quellenangabe and the history list. Opened the new way: the tool item of the mode card (crop, headerFooter, stamp; Bearbeiten) or the
 * tool-inspector store (ocr, reference, history: no stable tool item at every width). The column is checked as a docked surface
 * (inside the viewport, no overlap with canvas, status bar, tab strip or mode card; its body may scroll like a list).
 */
const INSPECTORS = [
  { id: 'crop', item: 'crop' },
  { id: 'headerFooter', item: 'headerFooter' },
  { id: 'stamp', item: 'stamp' },
  { id: 'ocr', item: null },
  { id: 'reference', item: null },
  { id: 'history', item: null },
];
async function sweepInspectors() {
  if (only && !'inspector'.includes(only) && !only.includes('inspector')) return;
  const stores = (path) => `(await ${store(path)})`;
  await ev(`(async()=>{${stores('stores/ui.ts')}.useUi.getState().setMode('edit')})()`);
  await sleep(400);
  for (const { id, item } of INSPECTORS) {
    await probe(
      `inspector:${id}`,
      async () => {
        const sel = item === null ? null : `[data-slot="tool-row"] [data-toolbar-item="${item}"]`;
        const via =
          sel !== null &&
          (await ev(
            `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.getAttribute('aria-disabled') === 'true') return false; b.click(); return true; })()`,
          ));
        if (!via)
          await ev(
            `(async()=>{${stores('features/inspector/toolInspector.ts')}.useToolInspector.getState().openToolInspector(${JSON.stringify(id)})})()`,
          );
      },
      () =>
        ev(
          `(async()=>{${stores('features/inspector/toolInspector.ts')}.useToolInspector.getState().closeToolInspector()})()`,
        ),
      '[data-slot="inspector"]',
    );
  }
}

async function sweepTriggers(label) {
  for (const t of await ev(`window.__gate.triggers()`)) {
    const el = `document.querySelector('[data-gate-trigger="${t.i}"]`;
    if (t.off) {
      if (!only || t.name.includes(only)) {
        console.log(`SKIP popover:${lang}:${label}:${t.name} @${current.w}x${current.h} (disabled trigger)`);
      }
      continue;
    }
    await probe(
      `popover:${label}:${t.name}`,
      async () => {
        await ev(`${el}')?.click()`);
        // A tool whose options open only while it is on ([data-options-when-on]): the first click turns it on, the second
        // opens the options. Only those get a second click; on any other trigger it would close what the first one opened.
        if (await ev(`${el}[data-options-when-on]') !== null`)) {
          await sleep(350);
          if (!(await ev(`${el}[aria-expanded="true"]') !== null`))) await ev(`${el}')?.click()`);
        }
      },
      () => ev(`${el}[aria-expanded="true"]')?.click()`),
    );
  }
}

const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });

/** Split buttons: hover and press each part for real (CDP mouse), compare the box and every descendant box with the button's own. */
async function sweepSplit(label) {
  const count = await ev(`document.querySelectorAll('[data-split]').length`);
  const read = (i) =>
    ev(`(() => {
      const el = document.querySelectorAll('[data-split]')[${i}];
      const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 24);
      return { name: 'split ' + (el.getAttribute('data-split') || name(el)), rect: R(el.getBoundingClientRect()),
        // Only what paints: a box with area that is not visually hidden (sr-only labels, empty anchors) and not a tooltip layer.
        parts: [...el.querySelectorAll('*')].filter((e) => {
          const r = e.getBoundingClientRect(), s = getComputedStyle(e);
          if (r.width <= 1 || r.height <= 1 || s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
          if (s.clip !== 'auto' || (s.clipPath !== 'none' && s.clipPath !== '')) return false;
          return e.closest('[role="tooltip"]') === null;
        }).map((e) => ({ name: e.tagName.toLowerCase() + ' "' + name(e) + '"', rect: R(e.getBoundingClientRect()) })),
        centres: [...el.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }) };
    })()`);
  const tag = `${lang} split:${label} @${current.w}x${current.h}`;
  const buttons = [];
  for (let i = 0; i < count; i++) {
    const rest = await read(i);
    if (rest === null || rest.rect.right <= rest.rect.left) continue;
    const entry = { name: rest.name, rest: rest.rect, states: [] };
    for (const c of rest.centres) {
      await mouse('mouseMoved', c.x, c.y, { button: 'none' });
      await sleep(250);
      let m = await read(i);
      entry.states.push({ state: 'hover', rect: m.rect, painted: m.parts });
      await mouse('mousePressed', c.x, c.y);
      await sleep(250);
      m = await read(i);
      entry.states.push({ state: 'pressed', rect: m.rect, painted: m.parts });
      // Release away from the button, so no click fires.
      await mouse('mouseMoved', 2, 2, { button: 'none' });
      await mouse('mouseReleased', 2, 2);
    }
    buttons.push(entry);
  }
  if (count > 0) rows.push(...rowsFor(tag, { split: checkSplitButtons(buttons) }));
}

/** F19.27: every split tool in inactive, inactive+hover, active and active+hover, read for the main and the chevron part. */
async function sweepSplitContour(label) {
  const count = await ev(`document.querySelectorAll('[data-split]').length`);
  const read = (i, p) =>
    ev(`(() => {
      const el = document.querySelectorAll('[data-split]')[${i}];
      const part = [...el.querySelectorAll('button')][${p}];
      if (!part) return null;
      const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const box = (e) => { const s = getComputedStyle(e); return { rect: R(e.getBoundingClientRect()),
        border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderTopStyle, s.borderLeftStyle, s.borderLeftColor].join(' '),
        outline: s.outlineStyle === 'none' || s.outlineWidth === '0px' ? 'none' : s.outlineWidth + ' ' + s.outlineStyle + ' ' + s.outlineColor,
        boxShadow: s.boxShadow !== 'none' ? s.boxShadow : getComputedStyle(e, '::after').boxShadow, background: s.backgroundColor }; };
      const r = part.getBoundingClientRect();
      return { name: el.getAttribute('data-split'), on: el.getAttribute('data-on') === 'true',
        c: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, outer: box(el), part: box(part) };
    })()`);
  const click = async (c) => {
    await mouse('mouseMoved', c.x, c.y, { button: 'none' });
    await mouse('mousePressed', c.x, c.y);
    await mouse('mouseReleased', c.x, c.y);
    await sleep(300);
  };
  const items = [];
  for (let i = 0; i < count; i++) {
    const first = await read(i, 0);
    if (first === null || first.on || first.outer.rect.right <= first.outer.rect.left) continue;
    if (
      await ev(`document.querySelectorAll('[data-split]')[${i}].querySelector('button[aria-disabled="true"]') !== null`)
    )
      continue;
    const parts = ['main', 'chevron'];
    const rec = parts.map((part) => ({ name: first.name, part, states: {} }));
    const take = async (stateName, hover) => {
      for (const [p, rowRec] of rec.entries()) {
        const at = await read(i, p);
        if (at === null) continue;
        await mouse('mouseMoved', hover ? at.c.x : 2, hover ? at.c.y : 2, { button: 'none' });
        await sleep(250);
        const x = await read(i, p);
        rowRec.states[stateName] = { outer: x.outer, part: x.part };
      }
    };
    await take('inactive', false);
    await take('inactive+hover', true);
    // Turn the tool on with a real click on the main part, close what it opened, move away and read again.
    await click(first.c);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    if (await ev(`document.querySelectorAll('[data-split]')[${i}].getAttribute('data-on') !== 'true'`)) continue;
    await take('active', false);
    await take('active+hover', true);
    await click(first.c);
    await mouse('mouseMoved', 2, 2, { button: 'none' });
    items.push(...rec);
  }
  if (items.length > 0) {
    rows.push(...rowsFor(`${lang} contour:${label} @${current.w}x${current.h}`, { contour: checkSplitContour(items) }));
  }
}

const BUTTONS_SEL =
  '[role="toolbar"] button, [data-toolbar-item], [role="tablist"] [role="tab"], [data-slot="mode-row"] button';

/** F19.2: every toolbar and mode button hovered over CDP; what paints in hover must equal the button's box (0 px tolerance). */
async function sweepHover(label) {
  const count = await ev(`document.querySelectorAll(${JSON.stringify(BUTTONS_SEL)}).length`);
  const read = (i) =>
    ev(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(BUTTONS_SEL)})[${i}];
      if (!el || el.getAttribute('aria-disabled') === 'true' || el.disabled) return null;
      const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const px = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
      const name = (e) => (e.getAttribute('data-toolbar-item') || e.getAttribute('aria-label') || e.textContent || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 24);
      // A document tab is the wrapper that owns the hover background (tab button + close x are one visual tab): measure that.
      // A wrapper without a box of its own (display: contents) paints nothing: then the tab button itself is the tab.
      const wrap = el.getAttribute('role') === 'tab' ? el.closest('[role="presentation"]') : null;
      const wrapBox = wrap?.getBoundingClientRect();
      const own = wrap && wrapBox.width > 0 && wrapBox.height > 0 ? wrap : el;
      const box = own.closest('[role="toolbar"],[role="tablist"],[data-slot="mode-row"],[data-slot="tool-row"]');
      // A scrolling strip (the document tabs past their minimum width, FX-6) clips the tabs scrolled out of it: a user scrolls a tab
      // into view before hovering it, so the gate does too (only the strip's own scrollLeft moves) instead of measuring a clipped tab.
      if (box && box.scrollWidth > box.clientWidth + 1) {
        const o = own.getBoundingClientRect(), v = box.getBoundingClientRect();
        // scrollLeft is whole pixels while the strip's edges are not: round up, or the tab keeps a 0.25 px sliver past the edge.
        if (o.right > v.right) box.scrollLeft += Math.ceil(o.right - v.right);
        else if (o.left < v.left) box.scrollLeft -= Math.ceil(v.left - o.left);
      }
      const r = own.getBoundingClientRect();
      const paints = [];
      const cs = getComputedStyle(own);
      // Outer box-shadow spread: grows the painted box by the spread (and the offset) on each side.
      for (const part of cs.boxShadow.split(/,(?![^(]*\\))/)) {
        if (!part.trim() || part.trim() === 'none' || /inset/.test(part)) continue;
        const nums = (part.match(/-?[\\d.]+px/g) || []).map(px);
        const [dx = 0, dy = 0, , spread = 0] = nums;
        paints.push({ name: 'box-shadow spread', rect: { left: r.left + dx - spread, top: r.top + dy - spread, right: r.right + dx + spread, bottom: r.bottom + dy + spread } });
      }
      for (const pseudo of ['::before', '::after']) {
        const s = getComputedStyle(own, pseudo);
        if (s.content === 'none' || s.display === 'none') continue;
        if (s.position === 'absolute' || s.position === 'fixed') {
          const left = r.left + px(cs.borderLeftWidth) + px(s.left), top = r.top + px(cs.borderTopWidth) + px(s.top);
          paints.push({ name: pseudo, rect: { left, top, right: left + px(s.width), bottom: top + px(s.height) } });
        }
      }
      if (own !== el && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') paints.push({ name: 'tab background', rect: R(r) });
      for (const d of own.querySelectorAll('*')) {
        const s = getComputedStyle(d), dr = d.getBoundingClientRect();
        if (dr.width <= 0 || dr.height <= 0 || s.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
        paints.push({ name: d.tagName.toLowerCase() + ' background', rect: R(dr) });
      }
      const scrolls = !!box && box.scrollWidth > box.clientWidth + 1;
      const centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      // A strip that clips its overflow (the document tabs) cannot show a paint past its edge, and it may scroll between the two
      // reads (the active tab is kept in view): there the rule is the owner's F19.2 one alone — the hover paints exactly the
      // control's own box — so every rect is taken relative to that box and the box is its own container.
      if (scrolls && getComputedStyle(box).overflowX !== 'visible') {
        const at = (q) => ({ left: q.left - r.left, top: q.top - r.top, right: q.right - r.left, bottom: q.bottom - r.top });
        const own = at(R(r));
        return { name: name(el), box: own, container: own, centre, paints: paints.map((p) => ({ ...p, rect: at(p.rect) })) };
      }
      return { name: name(el), box: R(r), container: R((box || el.parentElement).getBoundingClientRect()),
        scrollClientWidth: scrolls ? box.clientWidth : undefined, centre, paints };
    })()`);
  const items = [];
  for (let i = 0; i < count; i++) {
    const rest = await read(i);
    if (rest === null || rest.box.right <= rest.box.left) continue;
    await mouse('mouseMoved', rest.centre.x, rest.centre.y, { button: 'none' });
    await sleep(250);
    const hovered = await read(i);
    if (hovered === null) continue;
    items.push({
      name: rest.name,
      box: rest.box,
      container: rest.container,
      scrollClientWidth: rest.scrollClientWidth,
      hover: { box: hovered.box, paints: [...hovered.paints, { name: 'button', rect: hovered.box }] },
    });
  }
  await mouse('mouseMoved', 2, 2, { button: 'none' });
  if (items.length > 0)
    rows.push(...rowsFor(`${lang} hover:${label} @${current.w}x${current.h}`, { hover: checkHoverGeometry(items) }));
}

const store = (path) => `import('/src/${path}')`;
async function openFixture() {
  const active = () =>
    ev(
      `(async()=>{const d=(await ${store('stores/documents.ts')}).useDocuments.getState();return d.byId[d.activeId]?.displayName??null})()`,
    );
  if (!/text/i.test((await active()) ?? '')) {
    spawn(exe, [resolve(root, 'tests', 'fixtures', 'text.pdf')], { stdio: 'ignore' }).unref();
    for (let i = 0; i < 40 && !/text/i.test((await active()) ?? ''); i++) await sleep(250);
  }
  if (!/text/i.test((await active()) ?? '')) throw new Error('text.pdf did not open');
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('[data-page="1"] canvas, [data-page="1"] img')`)); i++)
    await sleep(250);
  // The first-run tour and tips would be floating layers of their own; end the tour.
  await ev(`(async()=>{(await ${store('features/tour/store.ts')}).useTour.getState().end('closed')})()`).catch(
    () => undefined,
  );
  await sleep(500);
}

try {
  await ev(`window.focus()`);
  await ev(PAGE);
  await openFixture();
  const modes = await ev(`(async()=>[...(await ${store('stores/ui.ts')}).MODES])()`);
  for (const size of sizes) {
    current = size;
    await send('Emulation.setDeviceMetricsOverride', {
      width: size.w,
      height: size.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    const vp = await ev(`({ w: innerWidth, h: innerHeight })`);
    if (vp.w !== size.w || vp.h !== size.h)
      rows.push({ surface: `viewport ${size.w}x${size.h}`, check: 'size', result: `FAIL got ${vp.w}x${vp.h}` });
    // Q9: en and de, each on its own pass.
    for (lang of ['en', 'de']) {
      await ev(
        `(async()=>{(await ${store('i18n/store.ts')}).useLocaleStore.getState().setLocale(${JSON.stringify(lang)})})()`,
      );
      await sleep(500);
      await sweepRegistry();
      await sweepTextEdit();
      await sweepInspectors();
      for (const mode of modes) {
        await ev(`(async()=>{(await ${store('stores/ui.ts')}).useUi.getState().setMode(${JSON.stringify(mode)})})()`);
        await sleep(400);
        await sweepSplit(mode);
        await sweepSplitContour(mode);
        await sweepHover(mode);
        await sweepTriggers(mode);
      }
    }
  }
} catch (e) {
  rows.push({ surface: '-', check: 'setup', result: `FAIL ${e.message}` });
}
await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
ws.close();
console.table(rows);
const bad = rows.filter((r) => r.result !== 'PASS');
console.log(`${rows.length - bad.length}/${rows.length} checks passed`);
process.exit(bad.length > 0 ? 1 : 0);
