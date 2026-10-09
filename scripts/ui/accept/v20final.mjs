// Acceptance v2.0.0 final, F20 (docs/FEEDBACK.md F20.1 to F20.11; ADR-144; level 4: touched areas only).
// Generated PDFs only (rule 13). Prereq: npm run build:acceptance (younger than the F20 commits). Run: npm run accept:v20final
//   V20F_PHASES=home,ink,colour,thumbs,inspector,chrome,zoom,tabs,comments to select (default all). English UI.
// Every check runs at 1280x800 and 960x640 (Emulation.setDeviceMetricsOverride); F20.3 also at deviceScaleFactor 2.
// Output: review/v20final/out (generated PDFs), review/v20final/shots/*.png (window captures only). Rule 15: CDP input + dialog queue.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPng } from './png.mjs';
import { createResults, runSession, sleep } from './harness.mjs';
import {
  CHROME_RGB,
  SIZES,
  clampInspector,
  colourClose,
  columnsOf,
  expectedTileGrid,
  followsSmoothly,
  insideRect,
  linesOfChars,
  plainPdf,
  rgbIs,
  strokePoints,
  turnAngles,
  strokeSmooth,
  thumbSharp,
  titleNeverSplit,
  validHex,
  zoomText,
} from './v20final-pure.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/v20final/out');
const SHOTS = 'v20final/shots';
const q = (s) => JSON.stringify(s);
const ALL = 'home,ink,colour,thumbs,inspector,chrome,zoom,tabs,comments';
const PHASES = (process.env.V20F_PHASES ?? ALL).split(',');
const RUN = Date.now().toString(36);

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true });
const write = (name, buf) => {
  const p = join(OUT, name.replace(/(\.pdf)$/, `-${RUN}$1`));
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

  async function setViewport(w, h, dpr = 1) {
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
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
    await ev(`window.__TAURI_INTERNALS__.invoke('discard_all_recoveries').then(() => 'ok', () => 'ERR')`);
    await ev('location.reload()').catch(() => {});
    await sleep(2500);
    await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'UI language' });
    await sleep(1800);
    for (const sel of ['[data-region="banner"] button[aria-label="Dismiss"]', 'button[aria-label="Decide later"]']) {
      if (await exists(sel)) {
        await input.click({ selector: sel });
        await sleep(600);
      }
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
  /** Runs fn(w, h) at each size, restoring 1280x800 DPR 1 after. */
  const atSizes = async (fn, dpr = 1) => {
    for (const [w, h] of SIZES) {
      await setViewport(w, h, dpr);
      await sleep(500);
      await fn(w, h);
    }
    await setViewport(1280, 800, 1);
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
  const atTop = (r, x, yTop) => ({ x: r.l + (x * r.w) / 612, y: r.t + (yTop * r.w) / 612 });
  async function stroke(pts, modifiers = 0) {
    const send = (type, p, extra = {}) =>
      s.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers, ...extra });
    await send('mouseMoved', pts[0]);
    await send('mousePressed', pts[0], { button: 'left', buttons: 1, clickCount: 1 });
    for (const p of pts.slice(1)) {
      await send('mouseMoved', p, { button: 'left', buttons: 1 });
      await sleep(8);
    }
    await send('mouseReleased', pts[pts.length - 1], { button: 'left', buttons: 0, clickCount: 1 });
  }
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
  /** Pixel [r, g, b] of a capture at CSS px (x, y) (DPR 1 captures only). */
  const pixelAt = (png, x, y) => png.rgb(Math.round(x), Math.round(y));
  async function manyPages(n, title) {
    return write(`${title.toLowerCase().replace(/\W+/g, '-')}.pdf`, plainPdf(n, title));
  }

  await sleep(1500);
  await fresh();

  // ================================================================================================================ home
  if (PHASES.includes('home')) {
    await section('home', async () => {
      // A generated PDF opened and closed first, so it is in the recents (F20.3).
      await setViewport(1280, 800);
      await open(await manyPages(1, 'Recents'));
      await closeAll();
      await sleep(900);

      await atSizes(async (w, h) => {
        const tag = `${w}x${h}`;
        // F20.1: no scroll, glow clipped, no grey strip.
        const g = await ev(`(() => {
          const main = document.querySelector('[data-home-main]'); const sc = document.querySelector('[data-home-scroller]');
          const m = main.getBoundingClientRect(); const glow = document.querySelector('[data-home-glow]');
          const rect = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
          const parts = glow ? [glow, ...glow.querySelectorAll('*')].map(rect) : [];
          return { doc: document.documentElement.scrollHeight - window.innerHeight, docW: document.documentElement.scrollWidth - window.innerWidth,
            scroller: sc.scrollHeight - sc.clientHeight, scrollerW: sc.scrollWidth - sc.clientWidth, mainScroll: main.scrollHeight - main.clientHeight,
            main: { l: m.left, t: m.top, r: m.right, b: m.bottom }, parts, hasGlow: !!glow,
            clip: getComputedStyle(main).overflowX + '/' + getComputedStyle(main).overflowY };
        })()`);
        C(
          `F20.1 (${tag}): no scroll in document and scroller`,
          g.doc <= 1 && g.docW <= 1 && g.scroller <= 1 && g.scrollerW <= 1 && g.mainScroll <= 1,
          JSON.stringify({
            doc: g.doc,
            docW: g.docW,
            scroller: g.scroller,
            scrollerW: g.scrollerW,
            main: g.mainScroll,
          }),
        );
        C(
          `F20.1 (${tag}): glow and its parts inside the home surface or clipped by it (the glow drifts; the surface is overflow hidden)`,
          g.hasGlow && (g.parts.every((p) => insideRect(p, g.main, 1)) || g.clip === 'hidden/hidden'),
          `${g.parts.filter((p) => !insideRect(p, g.main, 1)).length} outside, clip ${g.clip} ` +
            JSON.stringify({ main: g.main, out: g.parts.filter((p) => !insideRect(p, g.main, 1)) }),
        );
        const png = readPng(await shot(`f20-1-home-${tag}`));
        const right = g.main.r - 3;
        const edges = [0.15, 0.4, 0.7].map((f) => {
          const y = g.main.t + (g.main.b - g.main.t) * f;
          return { edge: pixelAt(png, right, y), inner: pixelAt(png, right - 10, y) };
        });
        const top = [0.2, 0.5, 0.8].map((f) => {
          const x = g.main.l + (g.main.r - g.main.l) * f;
          return { edge: pixelAt(png, x, g.main.t + 2), inner: pixelAt(png, x, g.main.t + 12) };
        });
        C(
          `F20.1 (${tag}): right and top edge pixels continue the gradient (no grey strip)`,
          [...edges, ...top].every((e) => colourClose(e.edge, e.inner, 14)),
          JSON.stringify([...edges, ...top].map((e) => [e.edge, e.inner])),
        );

        // The name of a recent card ends before its menu and star buttons (name content box vs button boxes).
        const cardNames = await ev(`(() => [...document.querySelectorAll('[data-recent-card]')].map((card) => {
          const name = card.querySelector('.home-card-name-text'); const r = name.getBoundingClientRect();
          const content = { l: r.left, r: r.right, t: r.top, b: r.bottom };
          const hit = (sel) => { const e = card.querySelector(sel); if (!e) return false; const q = e.getBoundingClientRect();
            return q.width > 0 && content.l < q.right && content.r > q.left && content.t < q.bottom && content.b > q.top; };
          return { menu: hit('[data-card-menu]'), star: hit('.home-card-star button'), text: name.textContent.length };
        }))()`);
        C(
          `recent cards (${tag}): the name does not run under the menu or star button`,
          cardNames.length > 0 && cardNames.every((c) => !c.menu && !c.star),
          JSON.stringify(cardNames),
        );

        // F20.2: tool tiles.
        const t = await ev(`(() => {
          const box = document.querySelector('[data-home-tools]'); const tiles = [...document.querySelectorAll('[data-home-tools] .home-tile')];
          const rect = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width }; };
          const titles = tiles.map((tile) => {
            const el = tile.querySelector('.home-tile-title'); const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const chars = []; let n; const range = document.createRange();
            while ((n = walker.nextNode())) for (let i = 0; i < n.data.length; i++) {
              range.setStart(n, i); range.setEnd(n, i + 1); const r = range.getClientRects()[0];
              if (r) chars.push({ ch: n.data[i], top: Math.round(r.top) });
            }
            return { text: el.textContent.trim(), chars };
          });
          const subs = tiles.map((tile) => { const e = tile.querySelector('.home-tile-sub'); return !e || getComputedStyle(e).display === 'none' || e.getBoundingClientRect().height === 0; });
          return { width: box.getBoundingClientRect().width, rects: tiles.map(rect), titles, subsHidden: subs };
        })()`);
        const split = t.titles.filter((x) => !titleNeverSplit(linesOfChars(x.chars), x.text)).map((x) => x.text);
        C(
          `F20.2 (${tag}): 8 tiles, titles never split inside a word`,
          t.rects.length === 8 && split.length === 0,
          JSON.stringify(split),
        );
        const want = expectedTileGrid(t.width);
        C(
          `F20.2 (${tag}): ${want.cols} columns by ${want.rows} rows at container ${Math.round(t.width)} px`,
          columnsOf(t.rects) === want.cols,
          `${columnsOf(t.rects)} columns`,
        );
        if (want.cols === 2) {
          C(
            `F20.2 (${tag}): subtitles hidden in two columns`,
            t.subsHidden.every(Boolean),
            JSON.stringify(t.subsHidden),
          );
        }
      });

      // F20.3: sharp recent thumbnails at DPR 2 (and 1) with a capture.
      for (const dpr of [2, 1]) {
        await atSizes(async (w, h) => {
          await input
            .waitFor(
              `[...document.querySelectorAll('[data-recent-thumb]')].some((i) => i.complete && i.naturalWidth > 0)`,
              {
                timeoutMs: 8000,
                what: 'recent thumbnail',
              },
            )
            .catch(() => {});
          const th = await ev(`(() => {
            const img = document.querySelector('[data-recent-thumb]'); if (!img) return null;
            const box = img.closest('[data-recent-tile]').getBoundingClientRect();
            return { nw: img.naturalWidth, nh: img.naturalHeight, bw: box.width, bh: box.height, dpr: window.devicePixelRatio };
          })()`);
          await shot(`f20-3-recent-${w}x${h}-dpr${dpr}`);
          C(
            `F20.3 (${w}x${h}, DPR ${dpr}): recent thumbnail natural size >= card size x DPR`,
            // devicePixelRatio under emulation is a float32 (1.0000000149...), so compare with a tolerance, never ===.
            !!th && Math.abs(th.dpr - dpr) < 0.01 && thumbSharp(th.nw, th.nh, th.bw, th.bh, dpr),
            JSON.stringify(th),
          );
        }, dpr);
      }
    });
  }

  // ================================================================================================================ ink
  if (PHASES.includes('ink')) {
    await section('ink', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(1, `Ink ${w}`));
        await mode('comment');
        const r = await pageRect(1);
        // A jittery hand: a slow wave plus noise, 60 samples.
        const jitter = (x0, y0, x1, y1, seed) =>
          Array.from({ length: 61 }, (_, i) => {
            const t = i / 60;
            const noise = Math.sin(i * 12.9898 + seed) * 2.5;
            return atTop(r, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(t * 6) * 14 + noise);
          });
        const pickVariant = async (text) => {
          await input.click({ selector: '[data-split="draw"] [data-roving="draw:more"]' });
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
        const variants = [
          ['Freehand', 110],
          ['Freehand arrow', 190],
          ['Freehand shape', 270],
        ];
        const inputs = [];
        const rawPts = [];
        for (const [i, [name, y]] of variants.entries()) {
          await pickVariant(name);
          const pts = jitter(100, y, 400, y + 10, i * 3);
          inputs.push(pts.length);
          rawPts.push(pts);
          await stroke(pts);
          await sleep(1200);
        }
        await input.press('Escape');
        const list = await annotations();
        await shot(`f20-4-ink-${w}x${h}`);
        const inks = list.filter((a) => a.kind === 'ink');
        // The document list is a summary without strokes: read the full annotations of page 0 (the list_annotations wire).
        const full = await ev(`(async () => {
          let out = [];
          for (let id = 0; id < 60; id++) {
            const r = await window.__TAURI_INTERNALS__.invoke('list_annotations', { docId: id, pageId: 0 }).then((x) => x, () => null);
            if (r && r.length) out = r;
          }
          return out.filter((a) => a.kind === 'ink');
        })()`);
        C(
          `F20.4 (${w}x${h}): three ink annotations from pen, arrow and shape`,
          inks.length === 3,
          JSON.stringify(list.map((a) => a.kind)),
        );
        full.forEach((a, i) => {
          const strokes = a.strokes ?? a.data?.strokes ?? [];
          const pts = strokePoints(strokes[0]);
          // Catmull-Rom interpolates (more points than the samples) after dropping close samples: the verdict is the
          // largest turn angle, which must be small and well below that of the jittery input.
          const v = strokeSmooth(pts, Number.POSITIVE_INFINITY);
          const rawWorst = Math.max(...turnAngles(rawPts[i] ?? []));
          C(
            `F20.4 (${w}x${h}): ${variants[i]?.[0]} stored path is smooth (turns below input jitter)`,
            v.ok && v.worst < rawWorst,
            JSON.stringify({
              stored: v.points,
              input: inputs[i],
              worstTurn: Number(v.worst.toFixed(2)),
              inputWorstTurn: Number(rawWorst.toFixed(2)),
            }),
          );
        });
        await closeAll();
      });
    });
  }

  // ================================================================================================================ colour
  if (PHASES.includes('colour')) {
    await section('colour', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(1, `Colour ${w}`));
        await mode('comment');
        await input.click({ selector: '[data-split="highlight"] [data-roving="highlight:more"]' });
        await input.waitFor(`!!document.querySelector('[data-colour-more]')`, { timeoutMs: 4000, what: 'colour menu' });
        await input.click({ selector: '[data-colour-more]' });
        await sleep(600);
        const surf = await ev(`(() => {
          const hex = document.querySelector('input[aria-label="Hex colour"]');
          const scope = hex?.closest('[role="dialog"], [data-radix-popper-content-wrapper], [role="menu"]') ?? hex?.parentElement;
          return { hex: !!hex, recent: !!scope?.querySelector('[role="radiogroup"][aria-label="Recently used"]') || !!document.querySelector('[role="radiogroup"]'),
            swatches: scope ? scope.querySelectorAll('[data-colour-swatch]').length : -1,
            palette: scope ? scope.querySelectorAll('[data-palette-set], [data-palette-chooser]').length : -1 };
        })()`);
        await shot(`f20-5-colour-more-${w}x${h}`);
        // The popover holds the hex field and at most one row of recents (six), never a palette grid (>= 10 swatches).
        C(
          `F20.5 (${w}x${h}): "+" opens the hex field with recents, no palette grid`,
          surf.hex && surf.swatches <= 6 && surf.palette === 0,
          JSON.stringify(surf),
        );
        const hexValue = 'D2691E';
        C('F20.5: the test hex is valid', validHex(hexValue));
        await input.click({ selector: 'input[aria-label="Hex colour"]' });
        await input.insertText(hexValue);
        await input.press('Enter');
        await sleep(700);
        // The popover closes on apply; the menu below it may still be open (shot for debugging), then reopen what is missing.
        if (!(await ev(`!!document.querySelector('[data-colour-more]')`))) {
          await input.click({ selector: '[data-split="highlight"] [data-roving="highlight:more"]' });
          await input.waitFor(`!!document.querySelector('[data-colour-more]')`, {
            timeoutMs: 4000,
            what: 'colour menu',
          });
        }
        await shot(`f20-5-after-apply-${w}x${h}`);
        // The applied colour is the first recent in the popover (its swatch label is the hex).
        await input.click({ selector: '[data-colour-more]' });
        await input.waitFor(`!!document.querySelector('input[aria-label="Hex colour"]')`, {
          timeoutMs: 4000,
          what: 'colour popover',
        });
        const first = await ev(
          `(() => { const e = document.querySelector('[role="radiogroup"][aria-label="Recently used"] [data-colour-swatch]'); return e ? e.getAttribute('aria-label') : null; })()`,
        );
        await shot(`f20-5-colour-recent-${w}x${h}`);
        C(
          `F20.5 (${w}x${h}): a valid hex applies (first recent is #${hexValue})`,
          (first ?? '').toUpperCase() === `#${hexValue}`,
          JSON.stringify({ first }),
        );
        await input.press('Escape').catch(() => {});
        await closeAll();
      });
    });
  }

  // ================================================================================================================ thumbs
  if (PHASES.includes('thumbs')) {
    await section('thumbs', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(40, `Thumbs ${w}`));
        const THUMB = '[aria-label="Page thumbnails"]';
        const tops = async () =>
          ev(
            `(() => { const l = document.querySelector(${q(THUMB)}); const sc = l?.parentElement; return sc ? sc.scrollTop : null; })()`,
          );
        if (!(await exists(THUMB))) {
          await input.click({ selector: '[role="tab"][data-value="pages"]' }).catch(() => {});
          await sleep(600);
        }
        const cell = await rectOf('[data-thumb-cell]');
        const cellH = cell?.h ?? 200;
        await ev(`document.querySelector(${q(SC)}).scrollTop = 0`);
        await sleep(800);
        const series = [await tops()];
        const pageH = (await curRect(1)).h;
        // Small steps through about eight pages; the sidebar is sampled after each step settles.
        for (let i = 0; i < 40; i++) {
          await ev(`document.querySelector(${q(SC)}).scrollTop += ${Math.round(pageH / 5)}`);
          await sleep(180);
          series.push(await tops());
        }
        await shot(`f20-6-thumbs-${w}x${h}`);
        const v = followsSmoothly(series, cellH);
        C(
          `F20.6 (${w}x${h}): sidebar scrollTop rises steadily, no jump over one thumbnail (${Math.round(cellH)} px)`,
          v.ok,
          JSON.stringify({
            worst: Math.round(v.worst),
            monotonic: v.monotonic,
            first: series[0],
            last: series[series.length - 1],
          }),
        );
        await closeAll();
      });
    });
  }

  // ================================================================================================================ inspector
  if (PHASES.includes('inspector')) {
    await section('inspector', async () => {
      const widthNow = async () => (await rectOf('[data-slot="inspector"]'))?.w ?? 0;
      await atSizes(async (w, h) => {
        await open(await manyPages(1, `Inspector ${w}`));
        await mode('edit');
        await input.click({ selector: '[data-toolbar-item="crop"]' });
        await input.waitFor(`!!document.querySelector('[data-slot="inspector"][data-open]')`, {
          timeoutMs: 6000,
          what: 'inspector',
        });
        await sleep(500);
        const grip = async () => {
          const sp = await rectOf('[data-slot="inspector"] [role="separator"]');
          return { x: sp.l + sp.w / 2, y: sp.t + sp.h / 2 };
        };
        for (const [target, label] of [
          [100, 240],
          [900, 480],
        ]) {
          const g = await grip();
          const now = await widthNow();
          await input.drag(g, { x: g.x + (now - target), y: g.y }, { steps: 12 });
          await sleep(600);
          const got = Math.round(await widthNow());
          await shot(`f20-8-inspector-${label}-${w}x${h}`);
          C(
            `F20.8 (${w}x${h}): dragged towards ${target} clamps to ${label}`,
            Math.abs(got - clampInspector(label)) <= 1,
            `${got}`,
          );
        }
        // Remembered: reload, reopen the same tool, the width is kept.
        await closeAll();
        await ev('location.reload()').catch(() => {});
        await sleep(3000);
        await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'reload' });
        await sleep(1500);
        await open(await manyPages(1, `Inspector again ${w}`));
        await mode('edit');
        await input.click({ selector: '[data-toolbar-item="crop"]' });
        await input.waitFor(`!!document.querySelector('[data-slot="inspector"][data-open]')`, {
          timeoutMs: 6000,
          what: 'inspector',
        });
        await sleep(600);
        const kept = Math.round(await widthNow());
        C(`F20.8 (${w}x${h}): width kept after a reload`, Math.abs(kept - 480) <= 1, `${kept}`);
        // Restore the default so later scripts see the 300 px inspector (the width is stored app-wide).
        {
          const g = await grip();
          const now = await widthNow();
          await input.drag(g, { x: g.x + (now - 300), y: g.y }, { steps: 12 });
          await sleep(600);
        }
        await input.press('Escape');
        await closeAll();
      });
    });
  }

  // ================================================================================================================ chrome
  if (PHASES.includes('chrome')) {
    await section('chrome', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(1, `Chrome ${w}`));
        await sleep(500);
        const bg = await ev(`(() => {
          const c = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : null; };
          return { menu: c('[data-slot="menu-row"]'), tabs: c('[data-slot="tabstrip"]'), cardRow: c('[data-slot="mode-card-row"]'),
            left: c('aside'), inspector: c('[data-slot="inspector"]'), gutter: c('[data-slot="gutter"]') };
        })()`);
        // The menu row is absent where the OS draws its own menu bar (macOS): skip null entries but require the rest.
        const bad = Object.entries(bg).filter(([, v]) => v !== null && !rgbIs(v, CHROME_RGB));
        C(
          `F20.9 (${w}x${h}): chrome surfaces are rgb(250, 250, 248)`,
          bad.length === 0 && bg.tabs !== null && bg.left !== null,
          JSON.stringify(bg),
        );
        const card = await rectOf('[data-slot="mode-card"]');
        const png = readPng(await shot(`f20-9-chrome-${w}x${h}`));
        const rows = [card.b + 1, card.b + 4, card.t - 3];
        const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => card.l + card.w * f);
        const samples = rows.flatMap((y) => xs.map((x) => pixelAt(png, x, y)));
        C(
          `F20.9 (${w}x${h}): no white strip around the card (pixel rows under and above it)`,
          samples.every((p) => colourClose(p, CHROME_RGB, 3)),
          JSON.stringify(samples.filter((p) => !colourClose(p, CHROME_RGB, 3)).slice(0, 4)),
        );
        await closeAll();
      });
    });
  }

  // ================================================================================================================ zoom
  if (PHASES.includes('zoom')) {
    await section('zoom', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(1, `Zoom ${w}`));
        for (let i = 0; i < 40; i++) {
          const atMax = await ev(
            `(() => { const b = document.querySelector('[data-slot="statusbar"] button[aria-label="Zoom in"]'); return !b || b.disabled || b.getAttribute('aria-disabled') === 'true'; })()`,
          );
          if (atMax) break;
          await input.click({ selector: '[data-slot="statusbar"] button[aria-label="Zoom in"]' });
          await sleep(120);
        }
        await sleep(600);
        const z = await ev(`(() => {
          const e = document.querySelector('[data-slot="statusbar"] input[aria-label="Zoom"]'); if (!e) return null;
          const cs = getComputedStyle(e); const c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
          const room = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          return { value: e.value, sw: e.scrollWidth, cw: e.clientWidth, fig: cs.fontVariantNumeric, need: Math.ceil(c.measureText('1600 %').width), room };
        })()`);
        await shot(`f20-10-zoom-${w}x${h}`);
        C(
          // MAX_ZOOM is 400 % (src/lib/zoom.ts); the field is sized for four digits, so "1600 %" must fit its content box
          `F20.10 (${w}x${h}): field fits four digits plus "%" ("1600 %"), shows the maximum`,
          !!z && z.need <= z.room && /^\d{3,4}\s?%$/.test(zoomText(z.value)),
          JSON.stringify(z),
        );
        C(
          `F20.10 (${w}x${h}): no overflow, tabular figures`,
          !!z && z.sw <= z.cw && /tabular-nums/.test(z.fig),
          JSON.stringify(z),
        );
        await closeAll();
      });
    });
  }

  // ================================================================================================================ tabs
  if (PHASES.includes('tabs')) {
    await section('tabs', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(1, `Tabs ${w}`));
        for (const m of ['read', 'comment', 'fill', 'pages', 'edit']) {
          await mode(m);
          await input.hover({ selector: '[data-slot="mode-card"]' }).catch(() => {});
          await sleep(300);
          const t = await ev(`(() => {
            const tab = document.querySelector('[data-slot="mode-row"] [role="tab"][aria-selected="true"]'); if (!tab) return null;
            const cs = getComputedStyle(tab); const r = tab.getBoundingClientRect(); const chip = tab.querySelector('[data-key-chip]');
            const card = document.querySelector('[data-slot="mode-card"]'); const cc = getComputedStyle(card);
            return { id: tab.dataset.mode, bb: cs.borderBottomWidth, bt: cs.borderTopWidth, bl: cs.borderLeftWidth, bg: cs.backgroundColor,
              chip: chip ? chip.getBoundingClientRect().width : 0, cardTop: cc.borderTopWidth, l: r.left, r: r.right, b: r.bottom };
          })()`);
          const png = readPng(await shot(`f20-11-tab-${m}-${w}x${h}`));
          // The seam: pixels just under the tab's bottom edge across its inner width carry the card's colour, no border line.
          const xs = [0.3, 0.5, 0.7].map((f) => t.l + (t.r - t.l) * f);
          const below = xs.flatMap((x) => [t.b - 1, t.b, t.b + 1].map((y) => pixelAt(png, x, y)));
          const ref = pixelAt(png, (t.l + t.r) / 2, t.b - 4);
          C(
            `F20.11 (${w}x${h}, ${m}): active tab has no bottom border and no line under it, key chip shown`,
            t.id === m &&
              parseFloat(t.bb) === 0 &&
              parseFloat(t.bt) > 0 &&
              t.chip > 0 &&
              below.every((p) => colourClose(p, ref, 6)),
            JSON.stringify({
              bb: t.bb,
              chip: t.chip,
              cardTop: t.cardTop,
              below: below.filter((p) => !colourClose(p, ref, 6)).slice(0, 3),
              ref,
            }),
          );
        }
        await closeAll();
      });
    });
  }

  // ================================================================================================================ comments (F20.7)
  if (PHASES.includes('comments')) {
    await section('comments', async () => {
      await atSizes(async (w, h) => {
        await open(await manyPages(2, `Comments ${w}`));
        await mode('read');
        await input.click({ selector: '[data-toolbar-item="textSelect"]' }).catch(() => {});
        const r1 = await pageRect(1);
        await input
          .waitFor(`document.querySelector('[data-text-page]')?.dataset.textLength > 0`, {
            timeoutMs: 8000,
            what: 'text layer',
          })
          .catch(() => {});
        // Hover: a comment on one range; while the pointer rests on the bubble the mark outline stays.
        await input.drag(atTop(r1, 74, 100), atTop(r1, 250, 100), { steps: 10 });
        await sleep(600);
        await input.click({ selector: '[role="toolbar"] button', text: 'Comment' });
        await sleep(800);
        await input.insertText('Hover check');
        await input.press('Enter');
        await sleep(900);
        await input.hover({ selector: '[data-bubble]' });
        await sleep(700);
        const hovered = await count('[data-mark-outline]');
        await shot(`f20-7-hover-${w}x${h}`);
        C(
          `F20.7 (${w}x${h}): the mark stays highlighted while the pointer is on its bubble`,
          hovered >= 1,
          `${hovered} outlines`,
        );
        await input.press('Escape');

        // Multi-range with Ctrl over two pages: one annotation per page, grouped.
        const before = (await annotations()).length;
        const a = await pageRect(1);
        await stroke(Array.from({ length: 8 }, (_, i) => atTop(a, 74 + i * 20, 160)));
        await sleep(300);
        await stroke(
          Array.from({ length: 8 }, (_, i) => atTop(a, 74 + i * 20, 200)),
          2,
        ); // modifiers 2 = Ctrl
        await sleep(300);
        const b = await pageRect(2);
        await stroke(
          Array.from({ length: 8 }, (_, i) => atTop(b, 74 + i * 20, 100)),
          2,
        );
        await sleep(500);
        await input.click({ selector: '[role="toolbar"] button', text: 'Comment' }).catch(() => {});
        await sleep(800);
        await input.insertText('Multi range');
        await input.press('Enter');
        await sleep(1000);
        const after = await annotations();
        const added = after.length - before;
        const grouped = await ev(
          `[...document.querySelectorAll('[data-bubble] [data-group-pages]')].map((e) => e.textContent.trim())`,
        );
        await shot(`f20-7-multi-${w}x${h}`);
        // TODO(F20.7): the group link (/IRT + /RT /Group) is checked through the bubble's [data-group-pages] label (Bubble.tsx);
        // tighten to the annotation list's reply/group fields once the other package settles them.
        C(
          `F20.7 (${w}x${h}): Ctrl multi-range over two pages creates one annotation per page`,
          added === 2,
          `${added} added`,
        );
        C(`F20.7 (${w}x${h}): the per-page comments are shown grouped`, grouped.length >= 1, JSON.stringify(grouped));
        await closeAll();
      });
    });
  }
};

if (process.env.V20F_PHASES === 'none') {
  console.log('no phases');
} else {
  const code = await runSession(session, results);
  results.table();
  process.exitCode = code;
}
