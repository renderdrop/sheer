// Surface gate (F17.10, ADR-124 point 6). Node 22, built-ins only. Needs the dev window: `node scripts/ui/dev.mjs` (CDP 127.0.0.1:9222).
// Sets the viewport to 960x640 (plus 1280x800 with --wide), opens tests/fixtures/text.pdf, then opens every surface and checks it:
//   inside   the surface lies inside the viewport
//   clipped  no button/input/select/textarea inside it is cut by an overflow ancestor or by the viewport
//   scroll   no container inside it scrolls internally (lists excepted: role list|listbox|grid|tree or data-scroll="list")
//   overlap  it does not sit on a tooltip/tip/coach mark, nor cover a control outside it (modals cover the inert app by design)
// Surfaces: the dev registry `window.__sheerSurfaces` (src/dev/surfaces.ts: dialogs, sheets) and every popover/menu trigger on screen
// (`aria-haspopup`), swept in each mode. Usage: node scripts/ui/surface-gate.mjs [--wide] [--only <substring>]   exit 1 on any violation.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { checkClipped, checkInViewport, checkOverlap, checkScroll, rowsFor } from './surface-checks.mjs';

const BASE = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`;
const root = resolve(import.meta.dirname, '..', '..');
const exe = resolve(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'sheer.exe' : 'sheer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const sizes = [{ w: 960, h: 640 }, ...(args.includes('--wide') ? [{ w: 1280, h: 800 }] : [])];
let current = sizes[0];

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
  const SURFACES = '[role="dialog"],[role="alertdialog"],[role="menu"]';
  const LIST = '[role="list"],[role="listbox"],[role="grid"],[role="tree"],[data-scroll="list"]';
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
  const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const shown = () => [...document.querySelectorAll(SURFACES)].filter(visible);
  window.__gate = {
    mark() { window.__gateBefore = new Set(shown()); },
    // The outermost new surfaces (a popover's own submenu is part of it).
    fresh() {
      const all = shown().filter((e) => !window.__gateBefore.has(e));
      return all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
    },
    measure() {
      const found = this.fresh();
      if (found.length === 0) return null;
      const el = found.sort((a, b) => area(b) - area(a))[0];
      const rect = R(el.getBoundingClientRect());
      const modal = el.getAttribute('aria-modal') === 'true' || !!el.closest('[aria-modal="true"]');
      const controls = [...el.querySelectorAll(CONTROLS)]
        .filter((c) => visible(c) && !c.closest(LIST))
        .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 2 && r.height > 2; })
        .map((c) => {
          const clips = [];
          for (let p = c.parentElement; p && p !== document.documentElement; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.overflowX !== 'visible' || s.overflowY !== 'visible') clips.push(R(p.getBoundingClientRect()));
          }
          return { name: name(c), rect: R(c.getBoundingClientRect()), clips };
        });
      const containers = [el, ...el.querySelectorAll('*')]
        .filter((c) => !['TEXTAREA', 'INPUT', 'SELECT'].includes(c.tagName))
        .filter((c) => { const s = getComputedStyle(c); return visible(c) && (s.overflowY !== 'visible' || s.overflowX !== 'visible'); })
        .map((c) => ({ name: name(c), scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, isList: !!c.closest(LIST) }));
      const layers = [...document.querySelectorAll('[role="tooltip"],[role="region"]')]
        .filter((l) => visible(l) && !el.contains(l) && !l.contains(el))
        .filter((l) => {
          const s = getComputedStyle(l);
          return l.getAttribute('role') === 'tooltip' || ((s.position === 'fixed' || s.position === 'absolute') && area(l) < innerWidth * innerHeight / 2);
        })
        .map((l) => ({ name: name(l), rect: R(l.getBoundingClientRect()) }));
      const outside = [];
      if (!modal) {
        const sr = el.getBoundingClientRect();
        for (const c of document.querySelectorAll(CONTROLS + ',a[href]')) {
          if (el.contains(c) || !visible(c) || c.getAttribute('aria-expanded') === 'true' || c.closest(SURFACES)) continue;
          const r = c.getBoundingClientRect();
          const l = Math.max(r.left, sr.left), rr = Math.min(r.right, sr.right);
          const t = Math.max(r.top, sr.top), b = Math.min(r.bottom, sr.bottom);
          if (rr <= l || b <= t) continue;
          // Covered for real: the topmost thing at the middle of the shared area belongs to the surface.
          const top = document.elementFromPoint((l + rr) / 2, (t + b) / 2);
          if (top && el.contains(top)) outside.push({ name: name(c), rect: R(r) });
        }
      }
      return { rect, modal, controls, containers, layers, outside, vp: { w: innerWidth, h: innerHeight } };
    },
    triggers() {
      return [...document.querySelectorAll('[aria-haspopup]:not([aria-haspopup="false"])')]
        .filter((t) => visible(t) && !t.disabled && !t.closest(SURFACES))
        .map((t, i) => { t.setAttribute('data-gate-trigger', String(i)); return { i, name: name(t) }; });
    },
  };
  return true;
})()`;

const rows = [];
const verdict = (id, m) =>
  rowsFor(id, {
    inside: checkInViewport(m.rect, m.vp),
    clipped: checkClipped(m.controls, m.vp),
    scroll: checkScroll(m.containers),
    overlap: checkOverlap(m.rect, m.layers, m.outside),
  });

/** Opens with `open`, waits for the animation, measures, closes. */
async function probe(id, open, close) {
  if (only && !id.includes(only)) return;
  const tag = `${id} @${current.w}x${current.h}`;
  try {
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

async function sweepTriggers(label) {
  for (const t of await ev(`window.__gate.triggers()`)) {
    const el = `document.querySelector('[data-gate-trigger="${t.i}"]`;
    await probe(
      `popover:${label}:${t.name}`,
      () => ev(`${el}')?.click()`),
      () => ev(`${el}[aria-expanded="true"]')?.click()`),
    );
  }
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
    await sweepRegistry();
    for (const mode of modes) {
      await ev(`(async()=>{(await ${store('stores/ui.ts')}).useUi.getState().setMode(${JSON.stringify(mode)})})()`);
      await sleep(400);
      await sweepTriggers(mode);
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
