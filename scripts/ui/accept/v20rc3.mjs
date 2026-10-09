// Acceptance v2.0.0-rc.3, F19 part 2 (docs/FEEDBACK.md F19.16 to F19.27; spec docs/DESIGN.md 3.18; ADR-141 level 4: touched areas only).
// Generated PDFs only (rule 13). Prereq: npm run build:acceptance (a build younger than the rc.3 commits). Run: npm run accept:v20rc3
//   V20_PHASES=layout,mode,inspector,status,home,palette,links,ocr,sources,history,comments,draw to select (default all). English UI.
// Output: review/v20rc3/out (generated PDFs), review/v20rc3/shots/*.png (window captures only). Rule 15: CDP input + dialog queue.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPng } from './png.mjs';
import { createResults, runSession, sleep } from './harness.mjs';
import {
  coloursDiffer,
  countOf,
  expectedGreeting,
  footnotePdf,
  imagePdf,
  imprintPdf,
  kindCounts,
  parseRgb,
  parseTracks,
  plainPdf,
  rowsMatch,
  SEPARATORS,
} from './v20rc3-pure.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/v20rc3/out');
const SHOTS = 'v20rc3/shots';
const q = (s) => JSON.stringify(s);
const ALL = 'layout,mode,inspector,status,home,palette,links,ocr,sources,history,comments,draw';
const PHASES = (process.env.V20_PHASES ?? ALL).split(',');
const RUN = Date.now().toString(36);

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true });
const WORK = (name) => join(OUT, name.replace(/(\.pdf)$/, `-${RUN}$1`));
const write = (name, buf) => {
  const p = WORK(name);
  writeFileSync(p, buf);
  return p;
};

const results = createResults();
const { check: C } = results;

const session = async (ctx) => {
  const { input, dialogs, ev, session: s } = ctx;
  const SC = '[data-action-scope="canvas"] > [role="region"]';
  const shot = (name) => input.screenshot(`${SHOTS}/${name}`);
  const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);
  const count = (sel) => ev(`document.querySelectorAll(${q(sel)}).length`);
  const rectOf = (sel) =>
    ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`);

  async function setViewport(w, h) {
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
  }
  async function fresh(extra = {}) {
    const patch = {
      language: 'en',
      welcomeTour: 'shown',
      authorPrompt: 'done',
      pageSidebarCollapsed: false,
      tipsEnabled: false,
      leftPanelWidth: 200,
      ...extra,
    };
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(patch)} }).then(() => 'ok', (e) => 'ERR ' + JSON.stringify(e))`,
    );
    if (r !== 'ok') throw new Error(`update_settings failed: ${r}`);
    // Records left by earlier acceptance kills would raise the recovery banner (test profile only).
    await ev(`window.__TAURI_INTERNALS__.invoke('discard_all_recoveries').then(() => 'ok', () => 'ERR')`);
    await ev('location.reload()').catch(() => {});
    await sleep(2500);
    await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'UI language' });
    await sleep(1800);
    if (await exists('[data-region="banner"] button[aria-label="Dismiss"]')) {
      await input.click({ selector: '[data-region="banner"] button[aria-label="Dismiss"]' });
      await sleep(600);
    }
    // Recovery notice left by earlier acceptance kills: hide it for the session (not part of the spec'd layout).
    if (await exists('button[aria-label="Decide later"]')) {
      if (await exists('button[aria-label="Decide later"]'))
        await input.click({ selector: 'button[aria-label="Decide later"]' });
      await sleep(600);
    }
  }
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      C(`${name}: ran to the end`, false, e.message);
      await input.press('Escape').catch(() => {});
    }
  };
  async function open(path) {
    await sleep(800);
    await dialogs.openFile(path);
    await input.waitFor(`document.querySelectorAll('[data-page] img').length > 0`, {
      timeoutMs: 40000,
      what: 'page image',
    });
    await sleep(900);
  }
  async function menu(top, item) {
    await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: top });
    await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: `menu ${top}` });
    await sleep(250);
    await input.click({ selector: '[role="menu"] [role="menuitem"]', text: item });
    await sleep(700);
  }
  const mode = async (id) => {
    await input.click({ selector: `[data-mode="${id}"]` });
    await sleep(500);
  };
  const blurField = () =>
    ev(`document.activeElement?.closest?.('input,textarea,[contenteditable="true"]') && document.activeElement.blur()`);
  async function closeDoc() {
    await blurField();
    await input.press('w', { ctrl: true });
    await sleep(900);
  }
  async function closeAll() {
    for (let i = 0; i < 12 && (await exists('[data-page]')); i++) {
      await closeDoc();
      if (await count('[role="alertdialog"], [role="dialog"]')) {
        await input
          .click({ selector: '[role="alertdialog"] button, [role="dialog"] button', text: "Don't Save" })
          .catch(() => input.press('Escape').catch(() => {}));
        await sleep(500);
      }
    }
    await sleep(600);
  }
  async function pageRect(n) {
    for (let i = 0; i < 40 && !(await exists(`[data-page="${n}"]`)); i++) {
      await ev(`document.querySelector(${q(SC)}).scrollTop += 500`);
      await sleep(250);
    }
    await ev(`(() => { const e = document.querySelector('[data-page="${n}"]'); if (!e) return;
      const sc = document.querySelector(${q(SC)}); const r = e.getBoundingClientRect(); const sr = sc.getBoundingClientRect();
      sc.scrollTop += r.top - sr.top - 8; })()`);
    await sleep(600);
    return curRect(n);
  }
  const curRect = (n) =>
    ev(
      `(() => { const r = document.querySelector('[data-page="${n}"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`,
    );
  /** A point given in pt from the page's top left (Letter width 612), as a client point. */
  const atTop = (r, x, yTop) => ({ x: r.l + (x * r.w) / 612, y: r.t + (yTop * r.w) / 612 });
  async function stroke(pts) {
    const send = (type, p, extra = {}) => s.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
    await send('mouseMoved', pts[0]);
    await send('mousePressed', pts[0], { button: 'left', buttons: 1, clickCount: 1 });
    for (const p of pts.slice(1)) {
      await send('mouseMoved', p, { button: 'left', buttons: 1 });
      await sleep(8);
    }
    await send('mouseReleased', pts[pts.length - 1], { button: 'left', buttons: 0, clickCount: 1 });
  }
  /** docId of the newest open document: list_document_annotations answers for open ids only. */
  async function annotations() {
    return ev(`(async () => {
      let out = null;
      for (let id = 0; id < 60; id++) {
        const r = await window.__TAURI_INTERNALS__.invoke('list_document_annotations', { docId: id }).then((x) => x, () => null);
        if (r) out = r;
      }
      return out ?? [];
    })()`);
  }
  const dialogCount = () => count('[role="dialog"], [role="alertdialog"]');
  const inspectorState = () =>
    ev(`(() => { const e = document.querySelector('[data-slot="inspector"]'); const r = e?.getBoundingClientRect();
      return { open: !!e?.hasAttribute('data-open'), w: r ? Math.round(r.width) : 0,
        surface: e?.querySelector('[data-region="inspector"]')?.getAttribute('data-surface') ?? null }; })()`);
  async function plain(n, title) {
    return write(`${title.toLowerCase().replace(/\W+/g, '-')}.pdf`, plainPdf(n, title));
  }
  async function rectAnnotation(r, x1, y1, x2, y2) {
    await mode('comment');
    if (!(await exists('[data-toolbar-item="shapes"][data-on="true"]'))) {
      await input.click({ selector: '[data-toolbar-item="shapes"]' });
      await sleep(300);
    }
    await input.drag(atTop(r, x1, y1), atTop(r, x2, y2), { steps: 8 });
    await sleep(500);
  }

  await sleep(1500);
  await fresh();

  // ================================================================================================================ F19.16 layout
  if (PHASES.includes('layout')) {
    await section('layout', async () => {
      await setViewport(1440, 900);
      await open(await plain(1, 'Layout'));
      for (const [w, h] of [
        [1440, 900],
        [1280, 800],
        [960, 640],
      ]) {
        await setViewport(w, h);
        await sleep(500);
        const g = await ev(`(() => {
          const ed = document.querySelector('[data-slot="editor"]');
          const h = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
          return { rows: getComputedStyle(ed).gridTemplateRows, menu: h('[data-slot="menu-row"]'), tabs: h('[data-slot="tabstrip"]'),
            card: h('[data-slot="mode-card"]'), tool: h('[data-slot="tool-row"]'), status: h('[data-slot="statusbar"]'),
            gutters: [...document.querySelectorAll('[data-slot="gutter"]')].map((e) => Math.round(e.getBoundingClientRect().height)) };
        })()`);
        const tracks = parseTracks(g.rows);
        const menu = g.menu !== null;
        await shot(`f19-16-editor-${w}x${h}`);
        C(
          `F19.16 (${w}x${h}): editor rows 28/42/12/106/12/body/30`,
          rowsMatch(tracks, h, menu) && g.tabs === 42 && g.card === 106 && g.status === 30 && (!menu || g.menu === 28),
          JSON.stringify({
            tracks,
            menu: g.menu,
            tabs: g.tabs,
            card: g.card,
            tool: g.tool,
            status: g.status,
            gutters: g.gutters,
          }),
        );
      }
      await setViewport(1280, 800);

      // Tabs: active white with underline, unsaved dot, right cluster order.
      const tab = await ev(`(() => {
        const t = document.querySelector('[data-slot="tabstrip"] [role="tab"][aria-selected="true"]'); const box = t?.closest('[role="presentation"]');
        if (!box) return null;
        const bg = getComputedStyle(box).backgroundColor;
        const after = getComputedStyle(box, '::after'); const before = getComputedStyle(box, '::before');
        const line = [...box.querySelectorAll('*')].some((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height <= 3 && r.width >= box.getBoundingClientRect().width * 0.8; });
        return { bg, afterH: after.height, afterBg: after.backgroundColor, beforeH: before.height, line, h: Math.round(box.getBoundingClientRect().height) };
      })()`);
      const white = tab && parseRgb(tab.bg)?.every((c) => c >= 250);
      const under =
        tab &&
        (tab.line ||
          (parseFloat(tab.afterH) > 0 && parseFloat(tab.afterH) <= 3) ||
          (parseFloat(tab.beforeH) > 0 && parseFloat(tab.beforeH) <= 3));
      C(
        'F19.16: active tab white with an underline, 36 high',
        !!tab && white && under && tab.h === 36,
        JSON.stringify(tab),
      );
      await rectAnnotation(await pageRect(1), 150, 300, 300, 380);
      await input.press('Escape');
      await sleep(400);
      C('F19.16: unsaved dot on the tab after an edit', await exists('[data-slot="tabstrip"] [data-edited]'));
      const order = await ev(`(() => {
        const strip = document.querySelector('[data-slot="tabstrip"]'); const sr = strip.getBoundingClientRect();
        const btns = [...strip.querySelectorAll('button')].filter((b) => !b.closest('[role="tablist"]')).map((b) => ({ label: b.getAttribute('aria-label') ?? b.textContent.trim(), l: b.getBoundingClientRect().left }));
        const pick = (re) => btns.find((b) => re.test(b.label));
        return { undo: pick(/^Undo/)?.l ?? null, redo: pick(/^Redo/)?.l ?? null, history: pick(/^History/)?.l ?? null, search: pick(/Search|Find/)?.l ?? null, right: sr.right, labels: btns.map((b) => b.label) };
      })()`);
      C(
        'F19.16: right cluster order Undo, Redo, History, Search (right-aligned)',
        order.undo !== null &&
          order.undo < order.redo &&
          order.redo < order.history &&
          order.history < order.search &&
          order.search > order.right - 80,
        JSON.stringify(order),
      );
      C(
        'F19.16: no scroll arrows with one tab',
        (await count('[aria-label="Scroll tabs left"], [aria-label="Scroll tabs right"]')) === 0,
      );
      for (let i = 1; i <= 6; i++) await open(write(`tab-${i}.pdf`, plainPdf(1, `Tab ${i}`)));
      await sleep(600);
      const arrows =
        await ev(`(() => { const l = document.querySelector('[aria-label="Scroll tabs left"]'); const r = document.querySelector('[aria-label="Scroll tabs right"]');
        return { left: !!l, right: !!r, tabs: document.querySelectorAll('[data-slot="tabstrip"] [role="tab"]').length, lw: l ? Math.round(l.getBoundingClientRect().width) : 0 }; })()`);
      await shot('f19-16-tabs-7');
      C('F19.16: scroll arrows with 7 tabs', arrows.left && arrows.right && arrows.tabs >= 6, JSON.stringify(arrows));
      await closeAll();
    });
  }

  // ================================================================================================================ mode card
  if (PHASES.includes('mode')) {
    await section('mode', async () => {
      await setViewport(1280, 800);
      await open(await plain(1, 'Modes'));
      const modes = ['read', 'comment', 'fill', 'pages', 'edit'];
      const reg = await ev(`(() => ({ tabs: document.querySelectorAll('[data-slot="mode-row"] [data-mode]').length,
        chips: document.querySelectorAll('[data-slot="mode-row"] [data-key-chip]').length,
        keys: [...document.querySelectorAll('[data-slot="mode-row"] [data-key-chip]')].map((e) => e.textContent.trim()).join(''),
        activeChipShown: [...document.querySelectorAll('[data-slot="mode-row"] [role="tab"][aria-selected="true"] [data-key-chip]')].some((e) => e.getBoundingClientRect().width > 0),
        header: Math.round(document.querySelector('[data-slot="mode-row"]').getBoundingClientRect().height) }))()`);
      C(
        'F19.16: 5 mode registers with key chips 1-5',
        reg.tabs === 5 && reg.chips === 5 && reg.keys === '12345' && reg.activeChipShown && reg.header === 32,
        JSON.stringify(reg),
      );
      for (const m of modes) {
        await mode(m);
        await sleep(300);
        const info = await ev(`(() => {
          const row = document.querySelector('[data-slot="tool-row"]');
          const items = [...row.querySelectorAll('[data-toolbar-item]:not([data-toolbar-item="overflow"])')];
          const heights = items.map((e) => Math.round(e.getBoundingClientRect().height));
          const nonLabel = [...row.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() && !e.hasAttribute('data-label') && !e.closest('[data-label]') && !e.closest('svg')).map((e) => e.textContent.trim().slice(0, 30));
          return { rowH: Math.round(row.getBoundingClientRect().height), n: items.length, heights, seps: row.querySelectorAll('[role="separator"]').length,
            extra: nonLabel, captions: row.querySelectorAll('[data-group-caption], [data-hint], [data-caption]').length, labelled: row.querySelectorAll('[data-label]').length };
        })()`);
        const tall = info.heights.filter((h) => h === 56).length;
        C(
          `F19.16 (${m}): tools 56 high, ${SEPARATORS[m]} separators, no captions or hint texts`,
          info.rowH === 72 &&
            info.n >= 1 &&
            tall >= Math.ceil(info.n * 0.8) &&
            info.seps === SEPARATORS[m] &&
            info.extra.length === 0 &&
            info.captions === 0,
          JSON.stringify({
            rowH: info.rowH,
            n: info.n,
            tall,
            seps: info.seps,
            extra: info.extra,
            captions: info.captions,
          }),
        );
        await shot(`f19-16-mode-${m}-1280x800`);
      }
      await setViewport(960, 640);
      await mode('comment');
      await sleep(500);
      const narrow = await ev(`(() => { const row = document.querySelector('[data-slot="tool-row"]');
        return { labels: row.querySelectorAll('[data-label]').length, items: row.querySelectorAll('[data-toolbar-item]').length, svg: row.querySelectorAll('[data-toolbar-item] svg').length }; })()`);
      await input.hover({ selector: '[data-slot="tool-row"] [data-toolbar-item="note"]' });
      await sleep(900);
      const tip = await ev(
        `[...document.querySelectorAll('[role="tooltip"]')].map((e) => e.textContent.trim()).join(' | ')`,
      );
      await shot('f19-16-icon-only-960x640');
      C(
        'F19.16 (960 px): icon-only tools with tooltip',
        narrow.labels === 0 && narrow.items > 0 && /note/i.test(tip),
        JSON.stringify({ ...narrow, tip }),
      );
      await setViewport(1280, 800);
      await closeAll();
    });
  }

  // ================================================================================================================ inspector
  if (PHASES.includes('inspector')) {
    await section('inspector', async () => {
      await setViewport(1280, 800);
      await open(await plain(2, 'Inspector'));
      await mode('read');
      C('F19.16: inspector closed in Read', !(await inspectorState()).open);
      await mode('comment');
      await input.click({ selector: '[data-toolbar-item="highlight"]' });
      await sleep(400);
      C('F19.16: no inspector for a plain tool (Highlight)', !(await inspectorState()).open);
      await input.press('Escape');
      await mode('edit');
      const probe = async (item, what) => {
        await input.click({ selector: `[data-toolbar-item="${item}"]` });
        await sleep(900);
        const st = await inspectorState();
        const dlg = await dialogCount();
        const picker = await exists('[data-surface="stamp-picker"]:not([data-slot="inspector"] *)');
        await shot(`f19-16-inspector-${item}`);
        C(
          `F19.16: ${what} opens the 300 px inspector, no dialog or popup`,
          st.open && Math.abs(st.w - 300) <= 6 && dlg === 0 && !picker,
          JSON.stringify({ ...st, dlg, picker }),
        );
        return st;
      };
      await probe('crop', 'Crop');
      // F19.25: Enter applies, Esc cancels (inspector fields and handles stay in sync).
      await pageRect(1);
      const before = await curRect(1);
      await input.drag(atTop(before, 300, 235), atTop(before, 560, 380), { steps: 8 });
      await sleep(600);
      await input.press('Escape');
      await sleep(700);
      const afterEsc = await ev(
        `(() => { const r = document.querySelector('[data-page="1"]').getBoundingClientRect(); return { a: r.width / r.height, crop: !!document.querySelector('[data-crop-catcher]'), open: !!document.querySelector('[data-slot="inspector"][data-open]') }; })()`,
      );
      C(
        'F19.25: Esc cancels the crop (page unchanged, tool off)',
        Math.abs(afterEsc.a - 612 / 792) < 0.01 && !afterEsc.crop,
        JSON.stringify(afterEsc),
      );
      await input.click({ selector: '[data-toolbar-item="crop"]' });
      await sleep(800);
      const r2 = await curRect(1);
      await input.drag(atTop(r2, 290, 225), atTop(r2, 570, 385), { steps: 8 });
      await sleep(700);
      await input.press('Enter');
      await sleep(1500);
      const applied = await ev(
        `(() => { const r = document.querySelector('[data-page="1"]').getBoundingClientRect(); return { a: r.width / r.height, dialogs: document.querySelectorAll('[role="dialog"]').length }; })()`,
      );
      C(
        'F19.25: Enter applies the crop (page shape changed, no popup)',
        Math.abs(applied.a / (612 / 792) - 1) > 0.05 && applied.dialogs === 0,
        JSON.stringify(applied),
      );
      await input.press('Escape');
      await probe('headerFooter', 'Header/footer');
      await input.press('Escape');
      await sleep(400);
      await mode('edit');
      await probe('stamp', 'Stamp');
      await input.press('Escape');
      await sleep(400);
      // OCR through the Tools menu, reference through the popover: separate phases cover their content; here only the slot.
      await menu('Tools', 'Recognize Text…');
      await sleep(1200);
      const ocr = await inspectorState();
      C(
        'F19.16: Recognize text opens the inspector, no dialog',
        ocr.open && Math.abs(ocr.w - 300) <= 6 && (await dialogCount()) === 0,
        JSON.stringify(ocr),
      );
      await input.press('Escape');
      await sleep(400);
      await mode('read');
      C('F19.16: a mode switch closes the inspector', !(await inspectorState()).open);
      await closeAll();
    });
  }

  // ================================================================================================================ status bar
  if (PHASES.includes('status')) {
    await section('status', async () => {
      await setViewport(1280, 800);
      await open(await plain(3, 'Status'));
      const info = await ev(`(() => { const b = document.querySelector('[data-slot="statusbar"]');
        const btn = (re) => [...b.querySelectorAll('button')].find((x) => re.test(x.getAttribute('aria-label') ?? x.textContent));
        return { h: Math.round(b.getBoundingClientRect().height), save: !!b.querySelector('[data-save-status]') || /Saved|Unsaved|Saving/.test(b.textContent),
          inputs: b.querySelectorAll('input').length, zoomIn: !!btn(/Zoom in/i), zoomOut: !!btn(/Zoom out/i),
          fitWidth: !!btn(/Page width/), fitPage: !!btn(/Whole page/), total: /\\/\\s*3/.test(b.textContent) }; })()`);
      await shot('f19-16-statusbar');
      C(
        'F19.16: status bar 30 high with save state, page field, zoom and two fit buttons',
        info.h === 30 && info.save && info.inputs >= 2 && info.zoomIn && info.zoomOut && info.fitWidth && info.fitPage,
        JSON.stringify(info),
      );
      await input.click({ selector: '[data-slot="statusbar"] button', text: 'Page width' });
      await sleep(500);
      C(
        'F19.16: active fit is marked (aria-pressed)',
        await ev(
          `[...document.querySelectorAll('[data-slot="statusbar"] button[aria-pressed="true"]')].some((b) => /Page width/.test(b.textContent))`,
        ),
      );
      await closeAll();
    });
  }

  // ================================================================================================================ F19.17 home
  if (PHASES.includes('home')) {
    await section('home', async () => {
      await setViewport(1280, 800);
      // Recent files: seven small documents opened and closed.
      for (let i = 1; i <= 7; i++) {
        await open(write(`recent-${i}.pdf`, plainPdf(1, `Recent ${i}`)));
        if (i < 7) await closeDoc();
      }
      const measure = async (tag) => {
        await sleep(900);
        // The recovery banner (left by earlier acceptance kills) is not part of the spec'd layout; dismiss it.
        if (await exists('button[aria-label="Decide later"]')) {
          if (await exists('button[aria-label="Decide later"]'))
            await input.click({ selector: 'button[aria-label="Decide later"]' });
          await sleep(700);
        }
        const m = await ev(`(() => {
          const main = document.querySelector('[data-home-main]'); const nav = document.querySelector('[data-home-nav]');
          const tiles = [...document.querySelectorAll('[data-home-tools] button')];
          const rr = [...document.querySelectorAll('[data-recent-card]')];
          return { vscroll: main.scrollHeight > main.clientHeight + 1 || document.documentElement.scrollHeight > window.innerHeight + 1,
            nav: Math.round(nav.getBoundingClientRect().width), cards: rr.length, openCards: document.querySelectorAll('[data-open-card]').length,
            tiles: tiles.length || document.querySelector('[data-home-tools]')?.children.length || 0,
            tilesVisible: document.querySelector('[data-home-tools]')?.getBoundingClientRect().bottom <= window.innerHeight,
            greeting: document.querySelector('[data-home-greeting]')?.textContent.trim() ?? null, hour: new Date().getHours(),
            plus: !!document.querySelector('[data-home-open]'), title: document.querySelector('[data-home-title]')?.textContent.trim() ?? null };
        })()`);
        await shot(`f19-17-home-${tag}`);
        return m;
      };
      // With an open document.
      await input.click({ selector: 'button', text: 'Back to Home' });
      const withDocs = await measure('open-docs');
      C(
        'F19.17 (1280x800, with open documents): no vertical scroll, tools visible',
        !withDocs.vscroll && withDocs.tilesVisible,
        JSON.stringify(withDocs),
      );
      C(
        'F19.17: nav 230 wide, at most 5 recent cards, open card shown',
        withDocs.nav === 230 && withDocs.cards > 0 && withDocs.cards <= 5 && withDocs.openCards >= 1,
        JSON.stringify({ nav: withDocs.nav, cards: withDocs.cards, open: withDocs.openCards }),
      );
      C('F19.17: 8 tool tiles', withDocs.tiles === 8, `${withDocs.tiles} tiles`);
      // Back on Home the document stays open: reopen it from its card, close it, then drop the recovery banner.
      await input.click({ selector: '[data-open-card]' });
      await sleep(900);
      await closeAll();
      const bare = await measure('no-docs');
      C(
        'F19.17 (1280x800, no open documents): no vertical scroll, tools visible',
        !bare.vscroll && bare.tilesVisible,
        JSON.stringify(bare),
      );
      C(
        'F19.17: nav 230, <= 5 recent cards, 8 tiles (no documents)',
        bare.nav === 230 && bare.cards > 0 && bare.cards <= 5 && bare.tiles === 8 && bare.openCards === 0,
        JSON.stringify({ nav: bare.nav, cards: bare.cards, tiles: bare.tiles }),
      );
      C(
        'F19.17: greeting without author name',
        bare.greeting === expectedGreeting(bare.hour, ''),
        `${bare.greeting} (hour ${bare.hour})`,
      );
      await fresh({ authorName: 'Ada Example' });
      await closeAll();
      const named = await measure('named');
      C(
        'F19.17: greeting with the author name',
        named.greeting === expectedGreeting(named.hour, 'Ada Example'),
        `${named.greeting} (hour ${named.hour})`,
      );
      // The round plus button opens the dialog queue.
      const p = write('plus.pdf', plainPdf(1, 'Plus'));
      await dialogs.queue({ kind: 'openMany', paths: [resolve(p)] });
      await input.click({ selector: '[data-home-open]' });
      await input
        .waitFor(`document.querySelectorAll('[data-page] img').length > 0`, {
          timeoutMs: 30000,
          what: 'page after plus',
        })
        .then(
          () => C('F19.17: the plus button opens the dialog queue (document opened)', true),
          (e) => C('F19.17: the plus button opens the dialog queue (document opened)', false, e.message),
        );
      await closeAll();
      await fresh({ authorName: '' });
    });
  }

  // ================================================================================================================ F19.19 palettes
  if (PHASES.includes('palette')) {
    await section('palette', async () => {
      await setViewport(1280, 800);
      await ev(
        `Object.keys(localStorage).filter((k) => /palette/i.test(k)).forEach((k) => localStorage.removeItem(k))`,
      );
      await ev('location.reload()').catch(() => {});
      await sleep(2500);
      await open(await plain(1, 'Palette'));
      await mode('comment');
      const readSwatches = async () => {
        await input.click({ selector: '[data-split="highlight"] [data-roving="highlight:more"]' });
        await input.waitFor(
          `!!document.querySelector('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-palette-chooser]')`,
          { timeoutMs: 4000, what: 'colour menu' },
        );
        await sleep(400);
        const r =
          await ev(`(() => { const radios = [...document.querySelectorAll('[role="radio"]')].filter((e) => !e.hasAttribute('data-palette-set') && e.getAttribute('aria-label') !== 'Custom' && !/recent|zuletzt/i.test(e.closest('[role="radiogroup"]')?.getAttribute('aria-label') ?? '') && getComputedStyle(e).display !== 'none');
          return { colours: radios.map((e) => getComputedStyle(e.querySelector('span') ?? e).backgroundColor !== 'rgba(0, 0, 0, 0)' ? getComputedStyle(e.querySelector('span') ?? e).backgroundColor : getComputedStyle(e).backgroundColor), button: !!document.querySelector('[data-palette-chooser]')}; })()`);
        return r;
      };
      const first = await readSwatches();
      await shot('f19-19-picker');
      C(
        'F19.19: picker shows 5 colours and the palette button',
        first.colours.length === 5 && first.button,
        JSON.stringify(first),
      );
      await input.press('Escape');
      await sleep(300);
      // An annotation made with the default palette.
      const r = await pageRect(1);
      await rectAnnotation(r, 150, 300, 300, 380);
      await input.press('Escape');
      const annsBefore = await annotations();
      const colourOf = (list) => JSON.stringify(list.map((a) => [a.kind, a.color]));
      await input.click({ selector: '[data-split="highlight"] [data-roving="highlight:more"]' });
      await sleep(500);
      await input.click({ selector: '[data-palette-chooser]' });
      await input.waitFor(`!!document.querySelector('[data-palette-set]')`, {
        timeoutMs: 4000,
        what: 'palette presets',
      });
      const sets = await count('[data-palette-set]');
      C('F19.19: chooser lists the presets (rows of five swatches)', sets >= 3, `${sets} presets`);
      await input.click({ selector: '[data-palette-set]', nth: 1 });
      await sleep(600);
      await input.press('Escape');
      await sleep(300);
      const second = await readSwatches();
      await shot('f19-19-picker-switched');
      C(
        'F19.19: switching the preset changes the swatches',
        second.colours.length === 5 && coloursDiffer(first.colours, second.colours),
        JSON.stringify({ first: first.colours, second: second.colours }),
      );
      await input.press('Escape');
      const annsAfter = await annotations();
      C(
        'F19.19: existing annotation colour unchanged after the switch',
        annsBefore.length > 0 && colourOf(annsBefore) === colourOf(annsAfter),
        `${colourOf(annsBefore)} -> ${colourOf(annsAfter)}`,
      );
      await ev('location.reload()').catch(() => {});
      await sleep(3000);
      await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'reload' });
      await sleep(1500);
      await closeAll().catch(() => {});
      await open(await plain(1, 'Palette2')).catch(() => {});
      await mode('comment');
      const third = await readSwatches();
      C(
        'F19.19: the choice survives a reload',
        !coloursDiffer(second.colours, third.colours),
        JSON.stringify({ second: second.colours, third: third.colours }),
      );
      await input.press('Escape');
      await ev(
        `Object.keys(localStorage).filter((k) => /palette/i.test(k)).forEach((k) => localStorage.removeItem(k))`,
      );
      await closeAll().catch(() => {});
    });
  }

  // ================================================================================================================ F19.20 smart links
  if (PHASES.includes('links')) {
    await section('links', async () => {
      await setViewport(1280, 800);
      for (const variant of ['bracket', 'superscript', 'asterisk']) {
        await section(`links ${variant}`, async () => {
          await open(write(`footnotes-${variant}.pdf`, footnotePdf(variant)));
          await input.click({ selector: '[role="tab"][data-value="outline"]' }).catch(() => {});
          await sleep(1500);
          const found = [];
          for (let i = 0; i < 12; i++) {
            const got = await ev(
              `[...document.querySelectorAll('[data-links-list] [data-smartlink]')].map((e) => ({ kind: e.dataset.linkKind, key: e.dataset.linkKey, page: e.closest('[data-links-list]').dataset.linksPage }))`,
            );
            for (const l of got) if (!found.some((f) => f.key === l.key && f.page === l.page)) found.push(l);
            const more = await ev(
              `(() => { const sc = document.querySelector(${q(SC)}); const b = sc.scrollTop; sc.scrollTop += sc.clientHeight * 0.7; return sc.scrollTop > b; })()`,
            );
            if (!more) break;
            await sleep(500);
          }
          const kinds = kindCounts(found);
          await shot(`f19-20-links-${variant}`);
          C(`F19.20 (${variant}): footnote links present`, (kinds.footnote ?? 0) >= 2, JSON.stringify(kinds));
          const outline = await ev(`document.querySelectorAll('[role="treeitem"]').length`);
          C(
            `F19.20 (${variant}): outline merged from contents and headings`,
            outline >= 2,
            `${outline} outline entries`,
          );
          await closeAll();
        });
      }
    });
  }

  // ================================================================================================================ F19.22 OCR text PDF
  if (PHASES.includes('ocr')) {
    await section('ocr', async () => {
      await setViewport(1280, 800);
      // Render a page of text in the web view and use it as the scan.
      const url =
        await ev(`(() => { const c = document.createElement('canvas'); c.width = 1240; c.height = 1754; const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000'; g.font = 'bold 64px Arial, sans-serif';
        g.fillText('The Orchard Report', 120, 220); g.font = '44px Arial, sans-serif';
        ['The river crossed the valley before the town was built.', 'Farmers planted apples along the northern slope.', 'Every autumn the harvest filled the old barn.',
         'Visitors still walk the path between the trees.'].forEach((l, i) => g.fillText(l, 120, 380 + i * 90));
        return c.toDataURL('image/jpeg', 0.92); })()`);
      const jpeg = Buffer.from(url.split(',')[1], 'base64');
      const scan = write('scan.pdf', imagePdf(jpeg, 1240, 1754));
      await open(scan);
      await menu('Tools', 'Recognize Text…');
      await input.waitFor(`!!document.querySelector('[data-region="inspector"] [data-inspector="apply"]')`, {
        timeoutMs: 8000,
        what: 'ocr inspector',
      });
      await sleep(1500);
      await shot('f19-22-ocr-inspector');
      await input.click({ selector: '[data-inspector="apply"]' });
      // Wait for the run: reopen the inspector until the text PDF section is offered.
      let offered = false;
      for (let i = 0; i < 24 && !offered; i++) {
        await sleep(3000);
        await menu('Tools', 'Recognize Text…').catch(() => {});
        await sleep(1200);
        offered = await exists('[data-ocr="text-pdf-save"]');
        if (!offered) await input.press('Escape').catch(() => {});
      }
      C('F19.22: after recognition the inspector offers "Save as text PDF"', offered);
      if (offered) {
        await shot('f19-22-ocr-textpdf');
        const out = WORK('scan-text.pdf');
        await dialogs.answerSave(out);
        await input.click({ selector: '[data-ocr="text-pdf-save"]' });
        for (let i = 0; i < 60 && !(existsSync(out) && statSync(out).size > 0); i++) await sleep(1000);
        const ok = existsSync(out) && statSync(out).size > 0;
        C(
          'F19.22: the text PDF was written through the save dialog queue',
          ok,
          ok ? `${statSync(out).size} bytes` : 'no file',
        );
        if (ok) {
          await sleep(800);
          await input.press('Escape').catch(() => {});
          await open(out);
          await input.click({ selector: '[data-toolbar-item="textSelect"]' }).catch(() => {});
          await input
            .waitFor(`document.querySelector('[data-text-page]')?.dataset.textLength > 0`, {
              timeoutMs: 10000,
              what: 'text layer',
            })
            .catch(() => {});
          const len = await ev(`Number(document.querySelector('[data-text-page]')?.dataset.textLength ?? 0)`);
          const raw = readFileSync(out);
          C(
            'F19.22: reopened text PDF has extractable text',
            len > 20,
            `text layer ${len} chars, ${raw.length} bytes, image embedded: ${raw.includes('/Subtype /Image') || raw.includes('/Subtype/Image')}`,
          );
          await shot('f19-22-ocr-reopened');
        }
      }
      await closeAll();
    });
  }

  // ================================================================================================================ F19.21 sources
  if (PHASES.includes('sources')) {
    await section('sources', async () => {
      await setViewport(1280, 800);
      await open(write('imprint.pdf', imprintPdf()));
      await input.click({ selector: '[role="tab"][data-value="comments"]' });
      await sleep(1200);
      await input.click({ selector: 'button[aria-label="Reference and citation list"]' });
      await input.waitFor(`document.body.innerText.includes('Copy reference')`, {
        timeoutMs: 8000,
        what: 'reference popover',
      });
      await sleep(2500);
      const missing = await ev(`document.body.innerText`).then((t) => countOf(t, 'Some details are missing'));
      await shot('f19-21-reference-popover');
      C('F19.21: "Some details are missing" at most once', missing <= 1, `${missing}`);
      await input.click({ selector: 'button', text: 'Edit reference…' });
      await input.waitFor(`!!document.querySelector('[data-slot="inspector"] input')`, {
        timeoutMs: 8000,
        what: 'reference inspector',
      });
      await sleep(2500);
      const f =
        await ev(`(() => { const v = (suffix) => document.querySelector('[data-slot="inspector"] input[id$="-' + suffix + '"]')?.value ?? null;
        return { title: v('title'), year: v('year'), publisher: v('publisher'), place: v('place'), edition: v('edition'), isbn: v('isbn'),
          family: document.querySelector('[data-slot="inspector"] [data-part="family"]')?.value ?? null, inspector: document.querySelector('[data-slot="inspector"] [data-surface]')?.getAttribute('data-surface') }; })()`);
      await shot('f19-21-reference-inspector');
      const filled = Object.entries(f)
        .filter(([k, v]) => k !== 'inspector' && typeof v === 'string' && v.trim() !== '')
        .map(([k]) => k);
      C(
        'F19.21: reference fields filled from the imprint (title, author, year, publisher)',
        ['title', 'year', 'publisher', 'family'].every((k) => filled.includes(k)),
        JSON.stringify(f),
      );
      console.log(`INFO  F19.21 fields filled: ${filled.join(', ')}`);
      await input.press('Escape');
      await closeAll();
    });
  }

  // ================================================================================================================ F19.23 history
  if (PHASES.includes('history')) {
    await section('history', async () => {
      await setViewport(1280, 800);
      await open(await plain(1, 'History'));
      const r = await pageRect(1);
      await rectAnnotation(r, 120, 250, 250, 320);
      await rectAnnotation(await curRect(1), 300, 250, 430, 320);
      await rectAnnotation(await curRect(1), 450, 250, 560, 320);
      await sleep(600);
      await input.press('Escape');
      const made = (await annotations()).length;
      await input.click({ selector: '[data-slot="tabstrip"] button[aria-label="History"]' });
      await input.waitFor(`document.querySelectorAll('[data-history-entry]').length > 0`, {
        timeoutMs: 6000,
        what: 'history rows',
      });
      await sleep(500);
      const rows = await count('[data-history-entry]');
      await shot('f19-23-history-3');
      C(
        'F19.23: three annotations listed in the history',
        made === 3 && rows >= 3,
        `${made} annotations, ${rows} entries`,
      );
      // Newest on top: row 2 is the state after the first entry. Jump back two steps.
      await input.click({ selector: '[data-history-entry] > button', nth: 2 });
      await sleep(900);
      const jumped = await ev(
        `({ annotations: null, current: [...document.querySelectorAll('[data-history-entry] > button')].findIndex((b) => b.getAttribute('aria-current') === 'step') })`,
      );
      const afterJump = (await annotations()).length;
      await shot('f19-23-history-jumped');
      C(
        'F19.23: jumping back two steps leaves one annotation',
        afterJump === 1 && jumped.current === 2,
        `${afterJump} annotations, current row ${jumped.current}`,
      );
      // Delete one directly from the list (the current state's own entry).
      await input
        .click({ selector: '[data-history-entry]:nth-of-type(3) button[aria-label^="Delete"]' })
        .catch(async () => {
          await input.click({ selector: '[data-history-entry] button[aria-label^="Delete"]', nth: 2 });
        });
      await sleep(900);
      const afterDelete = (await annotations()).length;
      await shot('f19-23-history-deleted');
      C('F19.23: delete one annotation from the history list', afterDelete === 0, `${afterDelete} annotations left`);
      await input.press('Escape');
      await closeAll();
    });
  }

  // ================================================================================================================ F19.24 comments
  if (PHASES.includes('comments')) {
    await section('comments', async () => {
      await setViewport(1280, 800);
      await open(await plain(1, 'Comments'));
      await mode('read');
      await input.click({ selector: '[data-toolbar-item="textSelect"]' }).catch(() => {});
      const r = await pageRect(1);
      await input
        .waitFor(`document.querySelector('[data-text-page]')?.dataset.textLength > 0`, {
          timeoutMs: 8000,
          what: 'text layer',
        })
        .catch(() => {});
      await input.drag(atTop(r, 74, 100), atTop(r, 250, 100), { steps: 10 });
      await sleep(700);
      await input.click({ selector: '[role="toolbar"] button', text: 'Comment' });
      await sleep(900);
      const focus = await ev(
        `(() => { const a = document.activeElement; return { tag: a?.tagName, inMargin: !!a?.closest?.('[data-margin-column]'), label: a?.getAttribute?.('aria-label') ?? null, bubbles: document.querySelectorAll('[data-bubble]').length }; })()`,
      );
      await shot('f19-24-bubble-focus');
      C(
        'F19.24: "Comment" creates a margin bubble with focus in its field',
        focus.tag === 'TEXTAREA' && focus.inMargin,
        JSON.stringify(focus),
      );
      await input.insertText('Typed straight in');
      await input.press('Enter');
      await sleep(900);
      const after = await ev(
        `(() => ({ text: [...document.querySelectorAll('[data-bubble]')].some((b) => b.textContent.includes('Typed straight in')), editing: !!document.querySelector('[data-margin-column] textarea[aria-label="Comment"], [data-bubble] textarea[aria-label="Note"]') }))()`,
      );
      C('F19.24: Enter confirms the comment', after.text, JSON.stringify(after));
      // The mark outline follows the scroll.
      await input.click({ selector: '[data-bubble]' });
      await sleep(500);
      const o0 = await rectOf('[data-mark-outline]');
      await ev(`document.querySelector(${q(SC)}).scrollTop += 30`);
      await sleep(500);
      const o1 = await rectOf('[data-mark-outline]');
      const page0 = await curRect(1);
      await ev(`document.querySelector(${q(SC)}).scrollTop += 30`);
      await sleep(500);
      const page1 = await curRect(1);
      await shot('f19-24-outline-scrolled');
      const moved = o0 && o1 ? o1.t - o0.t : null;
      C(
        'F19.24: the mark outline follows the scroll',
        !!o0 && !!o1 && moved !== null && Math.abs(moved + 30) <= 4 && page1.t < page0.t,
        JSON.stringify({ o0, o1, pageDelta: page1.t - page0.t }),
      );
      C(
        'F19.24: no connector line on bubble hover',
        (await count('[data-connector], [data-margin-connector], svg line[data-bubble-link]')) === 0,
      );
      await closeAll();
    });
  }

  // ================================================================================================================ F19.26 draw vs shapes
  if (PHASES.includes('draw')) {
    await section('draw', async () => {
      await setViewport(1280, 800);
      await open(await plain(1, 'Draw'));
      await mode('comment');
      const r = await pageRect(1);
      const wobble = (x0, y0, x1, y1, n = 30) =>
        Array.from({ length: n + 1 }, (_, i) => {
          const t = i / n;
          const p = atTop(r, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(t * 9) * 6);
          return p;
        });
      // The arrowhead is part of the rendered page (PDFium), so count dark pixels in a window around a stroke end.
      const darkAround = async (pt, name) => {
        const png = readPng(await shot(name));
        let n = 0;
        for (let y = Math.round(pt.y - 18); y < Math.round(pt.y + 18); y++)
          for (let x = Math.round(pt.x - 26); x < Math.round(pt.x + 6); x++) if (png.lum(x, y) < 100) n++;
        return n;
      };
      const pickVariant = async (slot, text) => {
        await input.click({ selector: `[data-split="${slot}"] [data-roving="${slot}:more"]` });
        await input.waitFor(`!!document.querySelector('[role="menu"], [role="radio"]')`, {
          timeoutMs: 4000,
          what: 'variant menu',
        });
        await input.click({
          selector: '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [role="radio"]',
          text,
        });
        await sleep(500);
      };
      await pickVariant('draw', 'Freehand');
      await input
        .waitFor(`document.querySelector('[data-toolbar-item="draw"]')?.getAttribute('data-on') === 'true'`, {
          timeoutMs: 4000,
          what: 'draw tool',
        })
        .catch(() => {});
      await stroke(wobble(100, 180, 300, 220));
      await sleep(1500);
      const kinds1 = (await annotations()).map((a) => a.kind);
      C(
        'F19.26: freehand stays an ink drawing (not straightened)',
        kinds1.length === 1 && kinds1[0] === 'ink',
        JSON.stringify(kinds1),
      );
      const freeEnd = atTop(await curRect(1), 300, 220);
      const freeDark = await darkAround(freeEnd, 'f19-26-freehand');
      await pickVariant('draw', 'Freehand arrow');
      await stroke(wobble(100, 250, 300, 290));
      await sleep(1500);
      const list2 = await annotations();
      const arrowDark = await darkAround(atTop(await curRect(1), 300, 290), 'f19-26-arrow-probe');
      await shot('f19-26-freehand-arrow');
      const head = arrowDark > freeDark * 1.5;
      C(
        'F19.26: freehand arrow is ink and carries an arrowhead',
        list2.length === 2 && list2[1].kind === 'ink' && head,
        JSON.stringify({ kinds: list2.map((a) => a.kind), freeDark, arrowDark }),
      );
      await input.press('Escape');
      await input.click({ selector: '[data-split="shapes"] [data-roving="shapes:more"]' });
      await input.waitFor(`!!document.querySelector('[role="menu"], [role="radio"]')`, {
        timeoutMs: 4000,
        what: 'shapes menu',
      });
      await input.click({
        selector: '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [role="radio"]',
        text: 'Line',
      });
      await sleep(500);
      await stroke(wobble(100, 320, 300, 360, 12));
      await sleep(700);
      const list3 = await annotations();
      await shot('f19-26-shapes-line');
      C(
        'F19.26: Shapes stay rigid (a wobbly drag makes a straight line, not ink)',
        list3.length === 3 && list3[2].kind === 'line',
        JSON.stringify(list3.map((a) => a.kind)),
      );
      await closeAll();
    });
  }
};

if (process.env.V20_PHASES === 'none') {
  console.log('no phases');
} else {
  const code = await runSession(session, results);
  results.table();
  process.exitCode = code;
}
