// Synthetic input over CDP (Input.dispatch*) for the acceptance build (ADR-131). No OS mouse or keyboard involved.
// Targets: { selector, text, role, nth } resolved in the page, scrolled into view, centre computed from the live rect;
// or page-relative coords { x, y } (client px). Waits and screenshots included.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rectCenter, isClickable, pointInRect, dragPath, keyEvent } from './pure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Page-side resolver. Returns the rect of the first visible match (after scrollIntoView) or null.
function resolveExpr(t) {
  const spec = JSON.stringify({
    selector: t.selector ?? null,
    text: t.text ?? null,
    role: t.role ?? null,
    nth: t.nth ?? 0,
  });
  return `(() => {
    const s = ${spec};
    const sel = s.selector ?? (s.role ? '[role="' + s.role + '"],' + s.role : '*');
    const roleOk = (e) => !s.role || e.getAttribute('role') === s.role || e.tagName.toLowerCase() === s.role;
    const label = (e) => ((e.getAttribute('aria-label') ?? '') + ' ' + (e.textContent ?? '')).replace(/\\s+/g, ' ').trim();
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    let list = [...document.querySelectorAll(sel)].filter((e) => roleOk(e) && vis(e));
    if (s.text !== null) {
      const m = list.filter((e) => label(e).includes(s.text));
      // innermost matches only (a wrapper contains the text of its child)
      list = m.filter((e) => !m.some((o) => o !== e && e.contains(o)));
    }
    const el = list[s.nth];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`;
}

export function createInput(session, { guard } = {}) {
  const { send, evaluate } = session;
  const step = (s) => guard?.step(s);
  const desc = (t) => JSON.stringify(t);

  async function rectOf(t, timeoutMs = 5000) {
    const t0 = Date.now();
    for (;;) {
      const r = await evaluate(resolveExpr(t));
      if (r && isClickable(r, session.vp ?? { w: 1e5, h: 1e5 })) return r;
      if (Date.now() - t0 > timeoutMs) throw new Error(`target not found/visible: ${desc(t)}`);
      await sleep(100);
    }
  }
  async function pointOf(t, offset) {
    if (typeof t.x === 'number' && t.selector === undefined && t.text === undefined && t.role === undefined)
      return { x: t.x, y: t.y };
    const r = await rectOf(t);
    return offset ? pointInRect(r, offset) : rectCenter(r);
  }

  const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
  async function click(t, { button = 'left', count = 1, offset } = {}) {
    step(`click ${desc(t)}`);
    const p = await pointOf(t, offset);
    await mouse('mouseMoved', p);
    for (let i = 1; i <= count; i++) {
      await mouse('mousePressed', p, { button, buttons: button === 'left' ? 1 : 2, clickCount: i });
      await mouse('mouseReleased', p, { button, buttons: 0, clickCount: i });
    }
    return p;
  }
  const dblclick = (t, o = {}) => click(t, { ...o, count: 2 });
  async function hover(t, offset) {
    step(`hover ${desc(t)}`);
    const p = await pointOf(t, offset);
    await mouse('mouseMoved', p);
    return p;
  }
  async function drag(from, to, { steps = 8 } = {}) {
    step(`drag ${desc(from)} -> ${desc(to)}`);
    const a = await pointOf(from);
    const b = await pointOf(to);
    const path = dragPath(a, b, steps);
    await mouse('mouseMoved', a);
    await mouse('mousePressed', a, { button: 'left', buttons: 1, clickCount: 1 });
    for (const p of path.slice(1)) await mouse('mouseMoved', p, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', b, { button: 'left', buttons: 0, clickCount: 1 });
  }
  async function press(key, mods = {}) {
    step(`key ${key} ${JSON.stringify(mods)}`);
    const e = keyEvent(key, mods);
    await send('Input.dispatchKeyEvent', { type: e.text !== undefined ? 'keyDown' : 'rawKeyDown', ...e });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.windowsVirtualKeyCode,
      modifiers: e.modifiers,
    });
  }
  async function insertText(text) {
    step(`insertText ${JSON.stringify(text)}`);
    await send('Input.insertText', { text });
  }
  async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100, what = 'condition' } = {}) {
    step(`waitFor ${what}`);
    const t0 = Date.now();
    for (;;) {
      const v = typeof predicate === 'string' ? await evaluate(predicate) : await predicate();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await sleep(intervalMs);
    }
  }
  const waitForTarget = (t, o = {}) => waitFor(async () => !!(await evaluate(resolveExpr(t))), { what: desc(t), ...o });
  async function screenshot(name) {
    step(`screenshot ${name}`);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const out = resolve(ROOT, 'review', name.endsWith('.png') ? name : `${name}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    return out;
  }

  return { click, dblclick, hover, drag, press, insertText, waitFor, waitForTarget, screenshot, rectOf, sleep };
}
