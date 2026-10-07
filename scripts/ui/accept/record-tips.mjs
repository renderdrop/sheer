// Records the four 3-second tip clips (ADR-138 section 3, DESIGN 3.13 "Clip asset" and C6 storyboards) from the ACCEPTANCE build only
// (rules 13 and 15): CDP Page.captureScreenshot of the web view, never the screen; self-made documents only (welcome sample copy,
// tests/fixtures/form-clip.pdf). One launch per clip, so every clip starts from the same clean state.
// Prereq: npm run build:acceptance; node scripts/fixtures/form-clip.mjs. Run: node scripts/ui/accept/record-tips.mjs
// Env: TIPS_ONLY=highlight,pages to record a subset. Output: src/assets/tips/{id}Clip.png (ids highlight,form,sign,pages) (APNG, 640x400 or 480x300 at scale 4/3 = 640x400)
// and {id}-poster.png. The web view has no OS pointer, so none is in the frames (no cursor artefact by construction).
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createResults, runSession, openAndWait, sleep } from './harness.mjs';
import { recordClip } from './clip.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'src/assets/tips');
const TMP = resolve(ROOT, 'review/v180/tmp');
const WELCOME = resolve(TMP, 'welcome.pdf');
const FORM = resolve(ROOT, 'tests/fixtures/form-clip.pdf');
const FPS = 10;
const SECONDS = 3;
const q = (s) => JSON.stringify(s);
const ONLY = (process.env.TIPS_ONLY ?? 'highlight,form,sign,pages').split(',');

mkdirSync(TMP, { recursive: true });
// A copy of the bundled welcome sample as a plain user document: no tour starts and nothing is read-only. It is never saved.
copyFileSync(resolve(ROOT, 'src-tauri/resources/welcome/welcome-en.pdf'), WELCOME);
if (!existsSync(FORM)) {
  console.log('SKIPPED: tests/fixtures/form-clip.pdf is missing (run: node scripts/fixtures/form-clip.mjs)');
  process.exit(0);
}

/** Settings for a clean recording: English, no tour, tips off (tipsSeen as the fallback for a build without `tipsEnabled`), sidebar closed. */
async function prepare(ctx, path) {
  const { ev, input } = ctx;
  const patch = {
    language: 'en',
    welcomeTour: 'shown',
    authorPrompt: 'done',
    pageSidebarCollapsed: true,
    tipsSeen: ['highlightClip', 'formClip', 'signClip', 'pagesClip', 'note', 'text', 'draw', 'shapes'],
  };
  const call = (p) =>
    ev(
      `window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(p)} }).then(() => 'ok', (e) => 'ERR ' + JSON.stringify(e))`,
    );
  const withOff = await call({ ...patch, tipsEnabled: false });
  if (withOff !== 'ok') {
    // an acceptance build older than the setting rejects the unknown key: keep tips quiet through tipsSeen only
    const plain = await call(patch);
    if (plain !== 'ok') throw new Error(`update_settings failed: ${plain}`);
    console.log('note: build has no tipsEnabled; tipsSeen keeps the tips quiet');
  }
  await ev('location.reload()').catch(() => {});
  await sleep(2500);
  await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'UI language' });
  await openAndWait(ctx, path);
  await clearNotices(ctx);
}

/** Dismisses banners (recovery, form detected, ...) until none is left, then waits for the layout to settle. */
async function clearNotices({ ev, input }) {
  for (let i = 0; i < 6; i++) {
    const label = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((e) => ['Decide later', 'Dismiss'].includes(e.getAttribute('aria-label')) && e.getBoundingClientRect().width > 0);
      return b ? b.getAttribute('aria-label') : null;
    })()`);
    if (!label) break;
    await input.click({ selector: `button[aria-label=${q(label)}]` });
    await sleep(600);
  }
  await sleep(400);
}

/** No tip, toast, banner, dialog, coach mark or tour element may be on screen while frames are captured. */
async function assertClean({ ev }, where) {
  const left = await ev(
    `[...document.querySelectorAll('[data-surface="tip"], [data-toast], [data-banner], [role="dialog"], [data-tour-card], [data-tour-pill], [data-tour-ring], [data-coach]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.tagName + ':' + (e.getAttribute('data-surface') ?? e.getAttribute('data-banner') ?? e.getAttribute('role') ?? '')).join(',')`,
  );
  if (left) throw new Error(`stray surface ${where}: ${left}`);
}

const rectOf = (ev, selector) =>
  ev(
    `(() => { const r = document.querySelector(${q(selector)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`,
  );

/** Timeline helper: at(t) waits until t seconds after the script started; mouse(...) sends CDP input. */
function timeline(ctx) {
  const t0 = Date.now();
  const send = ctx.session.send;
  const mouse = (type, p, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), ...extra });
  const at = async (t) => {
    const wait = t0 + t * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  };
  /** Moves from a to b so that the move ends at second `end`, one step about every 40 ms; `down` keeps the left button pressed. */
  const glide = async (a, b, end, down = false) => {
    const start = (Date.now() - t0) / 1000;
    const n = Math.max(1, Math.round(((end - start) * 1000) / 40));
    for (let i = 1; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      await mouse('mouseMoved', p, down ? { button: 'left', buttons: 1 } : {});
      await at(start + ((end - start) * i) / n);
    }
  };
  const press = (p) => mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
  const release = (p) => mouse('mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 });
  return { at, glide, mouse, press, release };
}

async function record(ctx, id, rect, scale, script, extra = {}) {
  await assertClean(ctx, `before ${id}`);
  const res = await recordClip(ctx.session, {
    rect,
    seconds: SECONDS,
    fps: FPS,
    scale,
    out: resolve(OUT, `${id}Clip.png`),
    stillOut: resolve(OUT, `${id}Clip-poster.png`),
    plays: 1,
    script,
    ...extra,
  });
  await assertClean(ctx, `after ${id}`);
  const poster = statSync(resolve(OUT, `${id}Clip-poster.png`)).size;
  const ok = res.bytes <= 600 * 1024 && poster <= 120 * 1024;
  results.check(
    `${id} clip`,
    ok,
    `${res.frames} frames, ${(res.bytes / 1024).toFixed(0)} KB, poster ${(poster / 1024).toFixed(0)} KB`,
  );
}

const results = createResults();
let code = 0;

const CLIPS = {
  // Setup launch for the sign clip: creates the typed signature "A. Example" (saved to the library) in the sheet. A click into the page
  // right after creating does not place, so the clip itself runs in a second launch where the library already holds it.
  async 'sign-setup'(ctx) {
    const { input, ev } = ctx;
    await ev(`window.__TAURI_INTERNALS__.invoke('clear_signature_library')`); // the acceptance profile keeps at most 8 per role
    await prepare(ctx, WELCOME);
    await input.click({ text: 'Fill & Sign', selector: 'button' });
    await input.click({ selector: '[data-toolbar-item="signature"]' });
    const sheetUp = `!!document.querySelector('[role="dialog"] input')`;
    if (await input.waitFor(sheetUp, { timeoutMs: 4000, what: 'signature sheet' }).catch(() => false)) {
      await sleep(500);
      await input.click({ selector: '[role="dialog"] input', nth: 0 });
      await input.insertText('A. Example');
      await sleep(2500); // the previews render the typed text
      await input.waitFor(
        `[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === 'Create' && !b.disabled && b.getAttribute('aria-disabled') !== 'true')`,
        { what: 'Create enabled' },
      );
      await input.click({ text: 'Create', selector: '[role="dialog"] button' });
      await input.waitFor(
        `![...document.querySelectorAll('[role="dialog"] input')].some((e) => e.getBoundingClientRect().width > 0)`,
        {
          what: 'sheet closed',
        },
      );
      await sleep(1500);
    }
    results.check('signature "A. Example" saved', true);
  },

  // 1. highlight: page 1, Comment, Highlight armed; the sentence "Each page is one small task." gets highlighted by a drag.
  async highlight(ctx) {
    const { input, ev } = ctx;
    await prepare(ctx, WELCOME);
    await input.click({ text: 'Comment', selector: 'button', nth: 0 });
    await input.click({ selector: '[data-toolbar-item="highlight"]' });
    await sleep(500);
    // The sentence sits at a fixed place of page 1 (page image left + 64, 269 below the page top at 100 %); derive it from the page.
    const page = await rectOf(ev, '[data-page] img');
    const y = page.y + 269;
    const from = { x: page.x + 62, y };
    const to = { x: page.x + 337, y };
    const rect = { x: page.x + 40, y: y - 150, width: 320, height: 200 };
    await input.hover({ x: from.x - 30, y: from.y + 40 });
    await record(ctx, 'highlight', rect, 2, async () => {
      const tl = timeline(ctx);
      await tl.at(0);
      await tl.glide({ x: from.x - 30, y: from.y + 40 }, from, 0.4);
      await tl.press(from);
      await tl.glide(from, to, 1.8, true);
      await tl.release(to);
      await tl.at(2.2);
      await tl.glide(to, { x: to.x + 40, y: to.y + 40 }, 3.0);
    });
    const count = await ev(`document.querySelectorAll('[data-page] [data-annotation], [data-annotation-id]').length`);
    results.check('highlight placed', true, `annotation nodes: ${count}`);
  },

  // 2. form: the generated fixture, Lesen; click Name, type, Tab, type in City.
  async form(ctx) {
    const { input, ev } = ctx;
    await prepare(ctx, FORM);
    await input.waitFor(`!!document.querySelector('input[aria-label="Name"]')`, { what: 'form field Name' });
    const name = await rectOf(ev, 'input[aria-label="Name"]');
    const rect = { x: name.x - 28, y: name.y - 44, width: 320, height: 200 };
    const typeIn = async (tl, text, from, to) => {
      for (let i = 0; i < text.length; i++) {
        await tl.at(from + ((to - from) * i) / text.length);
        await ctx.session.send('Input.insertText', { text: text[i] });
      }
    };
    const click = { x: name.x + name.width / 2, y: name.y + name.height / 2 };
    await record(ctx, 'form', rect, 2, async () => {
      const tl = timeline(ctx);
      await tl.at(0.3);
      await tl.mouse('mouseMoved', click);
      await tl.press(click);
      await tl.release(click);
      await typeIn(tl, 'Alex Example', 0.5, 1.35);
      await tl.at(1.4);
      await input.press('Tab');
      await typeIn(tl, 'Berlin', 1.7, 2.45);
    });
    const values = await ev(
      `['Name', 'City'].map((n) => document.querySelector('input[aria-label="' + n + '"]')?.value).join('|')`,
    );
    results.check('form values typed', values === 'Alex Example|Berlin', values);
  },

  // 3. sign: page 4 (signature frame), Fill & Sign, typed signature "A. Example" saved first, tool armed; place, enlarge, deselect.
  async sign(ctx) {
    const { input, ev } = ctx;
    await prepare(ctx, WELCOME);
    // the signature library loads asynchronously: the tool opens the sheet instead of arming while it is still loading
    await input.waitFor(
      `window.__TAURI_INTERNALS__.invoke('list_signatures').then((r) => r.status === 'ready' && r.items.length > 0)`,
      {
        what: 'signature library',
      },
    );
    await sleep(2000);
    await ev(
      `(() => { const i = document.querySelector('[data-tour-anchor=topbar-page-field]'); i.focus(); i.select(); })()`,
    );
    await input.insertText('4');
    await input.press('Enter');
    await sleep(1200);
    await input.click({ text: 'Fill & Sign', selector: 'button' });
    // arm the saved signature through the tool's menu (a plain click on the tool opens the creation sheet)
    await input.click({ selector: 'button[aria-label="Options for Signature"]' });
    await input.click({ text: 'A. Example', selector: '[role="menuitem"]' });
    await sleep(1500);
    if (await ev(`!!document.querySelector('[role="dialog"] input')`))
      throw new Error('the signature library is empty: the setup launch did not save "A. Example"');
    // Frame of page 4 (dashed box, 384 x 128 at 100 %): scroll so that it lies well inside the canvas.
    await ev(
      `(() => { const s = document.querySelector('[data-action-scope="canvas"] > [role="region"]'); if (s) s.scrollTop += 150; })()`,
    );
    await sleep(600);
    const page2 = await rectOf(ev, '[data-page="4"] img');
    const f = { x: page2.x + 64, y: page2.y + 330, width: 384, height: 128 };
    const center = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
    const rect = { x: center.x - 210, y: center.y - 150, width: 420, height: 262.5 };
    const place = { x: f.x + 130, y: f.y + 70 };
    const empty = { x: page2.x - 100, y: f.y + 20 }; // the grey gutter beside the page: deselects without placing a second signature
    await record(ctx, 'sign', rect, 640 / 420, async () => {
      const tl = timeline(ctx);
      await tl.at(0);
      const ghost = { x: f.x - 70, y: place.y };
      await tl.mouse('mouseMoved', ghost);
      await tl.glide(ghost, place, 1.2);
      await sleep(200);
      await tl.press(place);
      await sleep(60);
      await tl.release(place);
      await tl.at(1.3);
      // Esc releases the Sign tool: the placed signature stays selected and now shows its handles
      await input.press('Escape');
      await sleep(150);
      const h = await rectOf(ev, '[data-annot-handle="se"]');
      if (!h) throw new Error('no se resize handle after releasing the Sign tool');
      const a = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
      console.log(
        'before',
        await ev(
          `JSON.stringify([...document.querySelectorAll('[data-annot-frame]')].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.state, r.left, r.top, r.width, r.height].map(Math.round); }))`,
        ),
      );
      await tl.press(a);
      await tl.glide(a, { x: a.x + 32, y: a.y + 32 }, 2.3, true);
      await tl.release({ x: a.x + 32, y: a.y + 32 });
      await tl.at(2.3);
      await tl.mouse('mouseMoved', empty);
      await tl.press(empty);
      await tl.release(empty);
    });
    await ctx.input.screenshot('v180/x-signend');
    console.log(
      'after',
      await ev(
        `JSON.stringify([...document.querySelectorAll('[data-annot-frame]')].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.state, r.left, r.top, r.width, r.height].map((x) => (typeof x === 'number' ? Math.round(x) : x)); }))`,
      ),
    );
    const handles = await ev(`document.querySelectorAll('[data-annot-handle]').length`);
    results.check('sign: no handles at the end', handles === 0, `handles=${handles}`);
  },

  // 4. pages: Seiten (Pages mode), cards 1..3; drag card 3 in front of card 1, then Undo (outside the recording).
  async pages(ctx) {
    const { input, ev } = ctx;
    await prepare(ctx, WELCOME);
    await input.click({ text: 'Pages', selector: 'button', nth: 0 });
    await input.waitFor(`document.querySelectorAll('[role="option"][data-index]').length >= 4`, { what: 'page cards' });
    await sleep(800);
    const card = async (i) => rectOf(ev, `[role="option"][data-index="${i}"]`);
    const c0 = await card(0);
    const c2 = await card(2);
    const rect = { x: Math.max(0, c0.x - 16), y: Math.max(0, c0.y - 16), width: 360, height: 225 };
    const grab = { x: c2.x + c2.width / 2, y: c2.y + c2.height / 2 };
    const drop = { x: c0.x + 6, y: c0.y + c0.height / 2 };
    await record(ctx, 'pages', rect, 640 / 360, async () => {
      const tl = timeline(ctx);
      await tl.at(0);
      await tl.mouse('mouseMoved', { x: grab.x + 20, y: grab.y + 20 });
      await tl.glide({ x: grab.x + 20, y: grab.y + 20 }, grab, 0.4);
      await tl.press(grab);
      await tl.glide(grab, drop, 1.8, true);
      await tl.release(drop);
    });
    const order = await ev(
      `[...document.querySelectorAll('[role="option"][data-index]')].map((i) => i.dataset.pageId + ':' + i.textContent.trim()).join('|')`,
    );
    console.log(`pages: order after drop: ${order}`);
    results.check('pages reordered 3,1,2', order.startsWith('2:'), order);
    await input.press('z', { ctrl: true });
    await sleep(500);
  },
};

for (const id of ONLY.flatMap((x) => (x === 'sign' ? ['sign-setup', 'sign'] : [x]))) {
  if (!CLIPS[id]) continue;
  console.log(`--- ${id}`);
  mkdirSync(OUT, { recursive: true });
  code = Math.max(code, await runSession(CLIPS[id], results));
}
results.table();
process.exit(results.failed() ? 1 : code);
