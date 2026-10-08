// Acceptance v2.0.0-rc.2, F19 part 1 (docs/FEEDBACK.md F19.1 to F19.15; ADR-141 level 4: touched areas only). Self-made PDFs only.
// Prereq: npm run build:acceptance (a build younger than the F19 commits). Run: node scripts/ui/accept/v20rc2.mjs
//   V20_PHASES=home,comments,crop,redact,hf,shapes,props,sidebar to select (default all). English UI, one launch (plus one relaunch
//   for the sidebar width). Output: review/v20rc2/out (generated PDFs), review/v20rc2/shots/*.png (window captures only).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createResults, runSession, sleep } from './harness.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/v20rc2/out');
const SHOTS = 'v20rc2/shots';
const q = (s) => JSON.stringify(s);
const PHASES = (process.env.V20_PHASES ?? 'home,comments,crop,redact,hf,shapes,props,sidebar').split(',');
const RUN = Date.now().toString(36);

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true });
const WORK = (name) => join(OUT, name.replace(/(\.pdf)$/, `-${RUN}$1`));

// ---- PDF generator --------------------------------------------------------------------------------------------------------
/** objs: strings (object bodies) or { dict, data } streams; object n is objs[n - 1]. Returns a Buffer with a correct xref. */
function buildPdf(objs) {
  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const body =
      typeof o === 'string'
        ? `${i + 1} 0 obj\n${o}\nendobj\n`
        : `${i + 1} 0 obj\n<< ${o.dict ?? ''} /Length ${Buffer.byteLength(o.data, 'latin1')} >>\nstream\n${o.data}\nendstream\nendobj\n`;
    const b = Buffer.from(body, 'latin1');
    parts.push(b);
    pos += b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
const textStream = (lines, size = 14, x = 72, y0 = 700, step = 20) =>
  `BT /F1 ${size} Tf ${lines.map((l, i) => `1 0 0 1 ${x} ${y0 - i * step} Tm (${l}) Tj`).join(' ')} ET`;

/** F19.1/F19.9/F19.10/F19.11: page 1 portrait, page 2 landscape; Acrobat-style comments. */
function commentsPdf() {
  const date = '(D:20260101120000Z)';
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R 9 0 R 10 0 R 11 0 R 12 0 R 13 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R /Annots [14 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    {
      data: textStream([
        'Alpha line one of the sample text',
        'Bravo line two of the sample text',
        'Charlie line three of the sample text',
        'Delta line four of the sample text',
      ]),
    },
    { data: textStream(['Landscape page text line one', 'Landscape page text line two']) },
    `<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (Acrobat note text) /T (Alice Acrobat) /M ${date} /C [1 0.8 0] /Name /Comment /Popup 9 0 R /F 28 /P 3 0 R >>`,
    '<< /Type /Annot /Subtype /Popup /Rect [450 600 600 700] /Parent 8 0 R /Open false >>',
    `<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (Reply from Bob) /T (Bob Reviewer) /M ${date} /IRT 8 0 R /RT /R /Name /Comment /F 28 /P 3 0 R >>`,
    `<< /Type /Annot /Subtype /FreeText /Rect [72 500 300 540] /DA (0 0 0 rg /Helv 12 Tf) /RC (<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>Rich only text</p></body>) /T (Carol Rich) /M ${date} /F 4 /P 3 0 R >>`,
    `<< /Type /Annot /Subtype /Highlight /Rect [72 698 300 714] /QuadPoints [72 714 300 714 72 698 300 698] /C [1 1 0] /Contents (Highlight note text) /T (Dave Highlighter) /M ${date} /F 4 /P 3 0 R >>`,
    `<< /Type /Annot /Subtype /Ink /Rect [100 300 220 360] /InkList [[100 300 160 360 220 300]] /C [1 0 0] /BS << /W 2 >> /Contents (Ink note text) /T (Erin Ink) /M ${date} /F 4 /P 3 0 R >>`,
    `<< /Type /Annot /Subtype /Text /Rect [700 500 720 520] /Contents (Landscape note) /T (Frank Wide) /M ${date} /C [0.2 0.6 1] /Name /Comment /F 28 /P 4 0 R >>`,
  ]);
}

/** A plain document of n Letter pages with a few text lines at the top (and an optional running header and footer). */
function plainPdf({ pages = 1, header = false, title = 'Plain' } = {}) {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`];
  const first = 3 + pages;
  for (let i = 0; i < pages; i++)
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${first} 0 R >> >> /Contents ${first + 1 + i} 0 R >>`,
    );
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    let s = textStream([
      `${title} page ${i + 1} first line`,
      'Second line of body text here',
      'Third line of body text here',
    ]);
    // A filled block stands in for an image (crop must not stretch it).
    s += ' 0.2 0.4 0.8 rg 100 300 300 200 re f';
    if (header) s += ` BT /F1 10 Tf 1 0 0 1 266 762 Tm (Quarterly Report) Tj 1 0 0 1 480 30 Tm (Page ${i + 1}) Tj ET`;
    objs.push({ data: s });
  }
  return buildPdf(objs);
}
const write = (name, buf) => {
  const p = WORK(name);
  writeFileSync(p, buf);
  return p;
};

const results = createResults();
const { check: C } = results;

// ---- the session --------------------------------------------------------------------------------------------------------
const session = async (ctx) => {
  const { input, dialogs, ev, session: s } = ctx;
  const SC = '[data-action-scope="canvas"] > [role="region"]';
  const shot = (name) => input.screenshot(`${SHOTS}/${name}`);
  const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);
  const count = (sel) => ev(`document.querySelectorAll(${q(sel)}).length`);

  async function setViewport(w, h) {
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    s.vp = { w, h };
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
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'UI language' });
    await sleep(500);
    // The acceptance app is killed at the end of every run: the next start offers recovery. Dismiss that banner (it only shifts the layout).
    await sleep(1500);
    if (await exists('[data-region="banner"] button[aria-label="Dismiss"]')) {
      await input.click({ selector: '[data-region="banner"] button[aria-label="Dismiss"]' });
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
  async function save() {
    await blurField();
    await input.press('s', { ctrl: true });
    await sleep(2200);
    if (process.env.V20_DEBUG) {
      await shot('debug-save');
      const notes = await ev(
        `[...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=alert],[role=status]')].map((d) => d.textContent.slice(0, 120))`,
      );
      console.log('DEBUG after save:', JSON.stringify(notes), JSON.stringify(await dialogs.state()));
    }
  }
  async function closeDoc() {
    await blurField();
    await input.press('w', { ctrl: true });
    await sleep(1000);
  }
  async function openComments() {
    if (!(await exists('[role="tab"][data-value="comments"]'))) throw new Error('no comments tab (sidebar closed?)');
    await input.click({ selector: '[role="tab"][data-value="comments"]' });
    await sleep(1000);
  }
  /** Scrolls page n into view (top aligned) and returns its rect. */
  async function pageRect(n) {
    for (let i = 0; i < 40 && !(await exists(`[data-page="${n}"]`)); i++) {
      await ev(`document.querySelector(${q(SC)}).scrollTop += 500`);
      await sleep(250);
    }
    await ev(`(() => { const e = document.querySelector('[data-page="${n}"]'); if (!e) return;
      const sc = document.querySelector(${q(SC)}); const r = e.getBoundingClientRect(); const sr = sc.getBoundingClientRect();
      sc.scrollTop += r.top - sr.top - 8; })()`);
    await sleep(600);
    return ev(`(() => { const r = document.querySelector('[data-page="${n}"]').getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  }
  const curRect = (n) =>
    ev(
      `(() => { const r = document.querySelector('[data-page="${n}"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`,
    );
  /** A page point (pt, y up) as a client point, for a page of size (pw, ph) pt. */
  const toClient = (r, pw, ph, x, y) => ({ x: r.l + (x / pw) * r.w, y: r.t + ((ph - y) / ph) * r.h });
  /** A point given in pt from the page's top left (Letter width 612), as a client point (the page is taller than the window at 100 %). */
  const atTop = (r, x, yTop) => ({ x: r.l + (x * r.w) / 612, y: r.t + (yTop * r.w) / 612 });
  const frac = (r, fx, fy) => ({ x: r.l + fx * r.w, y: r.t + fy * r.h });
  /** A pointer path with many samples (a freehand stroke) through CDP mouse events. */
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
  const dialogCount = () => count('[role="dialog"], [role="alertdialog"]');
  const cardOf = (text) =>
    `(() => [...document.querySelectorAll('article[data-key]')].find((a) => a.textContent.includes(${q(text)})))()`;

  // ================================================================================================================ F19.4/5/6
  if (PHASES.includes('home')) {
    await section('home', async () => {
      await fresh();
      // Recent files: ten small documents opened and closed, so that "Recent" has more than two rows.
      for (let i = 1; i <= 10; i++) {
        const p = write(`recent-${String(i).padStart(2, '0')}.pdf`, plainPdf({ title: `Recent ${i}` }));
        await open(p);
        if (i === 1) {
          await menu('File', 'Close Document');
          await sleep(1200);
          const home = await ev(
            `!!document.querySelector('[data-slot="home"]') && !document.querySelector('[data-page]')`,
          );
          C('F19.4: closing the only tab leads to Home', home);
          await shot('f19-04-home-after-close');
        } else if (i < 10) {
          await closeDoc();
        }
      }
      // Document 10 stays open; Home with an open tab.
      await input.click({ selector: 'button', text: 'Back to Home' });
      await sleep(1500);
      for (const [w, h] of [
        [1280, 800],
        [960, 640],
      ]) {
        await setViewport(w, h);
        await sleep(600);
        const tag = `${w}x${h}`;
        const info = await ev(`(() => {
          const sec = [...document.querySelectorAll('[data-home-body] main section')];
          const head = (s) => s.querySelector('h2')?.textContent ?? '';
          const open = sec.find((s) => head(s) === 'Open');
          const recent = sec.find((s) => head(s) === 'Recent');
          const tools = document.querySelector('[data-home-tools]');
          const main = document.querySelector('[data-home-body] main');
          const cards = [...document.querySelectorAll('[data-recent-card]')];
          const tops = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)));
          const tr = tools?.getBoundingClientRect();
          const showAll = [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Show all');
          return { openTop: open?.getBoundingClientRect().top ?? null, recentTop: recent?.getBoundingClientRect().top ?? null,
            openCards: document.querySelectorAll('[data-open-card]').length, cards: cards.length, rows: tops.size, showAll,
            toolsBottom: tr?.bottom ?? null, vh: window.innerHeight, mainScrolls: main.scrollHeight > main.clientHeight + 1,
            mainBottom: main.getBoundingClientRect().bottom };
        })()`);
        await shot(`f19-06-home-${tag}`);
        C(
          `F19.6 (${tag}): section Open above Recent`,
          info.openTop !== null && info.recentTop !== null && info.openTop < info.recentTop && info.openCards >= 1,
          JSON.stringify(info),
        );
        C(
          `F19.6 (${tag}): Recent shows at most two rows, "Show all" offered`,
          info.rows >= 1 && info.rows <= 2 && info.showAll && info.cards < 10,
          `rows ${info.rows}, cards ${info.cards}, showAll ${info.showAll}`,
        );
        if (w === 1280)
          C(
            'F19.6 (1280x800): tools visible without scrolling',
            info.toolsBottom !== null && info.toolsBottom <= info.vh && !info.mainScrolls,
            `tools bottom ${info.toolsBottom}/${info.vh}, scrolls ${info.mainScrolls}`,
          );
        else
          console.log(
            `INFO  F19.6 (960x640): tools bottom ${info.toolsBottom}/${info.vh}, scrolls ${info.mainScrolls}`,
          );
      }
      await setViewport(1280, 800);
      // The star: top right inside the card, not over the title, Solar fill once marked.
      await input.hover({ selector: '[data-recent-card]', nth: 0 });
      await sleep(400);
      const star = async () =>
        ev(`(() => {
          const card = document.querySelector('[data-recent-card]'); const cr = card.getBoundingClientRect();
          const btn = card.querySelector('button[aria-pressed]'); const br = btn.getBoundingClientRect();
          const title = card.querySelector('.t-label').getBoundingClientRect();
          const svg = btn.querySelector('svg');
          const probe = document.createElement('i'); probe.style.color = 'var(--color-hl-solar)'; document.body.append(probe);
          const solar = getComputedStyle(probe).color; probe.remove();
          return { inside: br.left >= cr.left && br.right <= cr.right && br.top >= cr.top && br.bottom <= cr.bottom,
            topRight: br.left + br.width / 2 > cr.left + cr.width / 2 && br.top + br.height / 2 < cr.top + cr.height / 2,
            overTitle: br.left < title.right && br.right > title.left && br.top < title.bottom && br.bottom > title.top,
            pressed: btn.getAttribute('aria-pressed'), fill: getComputedStyle(svg).fill, solar, label: btn.getAttribute('aria-label') };
        })()`);
      let st = await star();
      await input.click({ selector: '[data-recent-card] button[aria-pressed]', nth: 0 });
      await sleep(500);
      await input.hover({ selector: '[data-recent-card]', nth: 0 });
      await sleep(400);
      st = { ...(await star()), before: st };
      await shot('f19-05-star-1280x800');
      C(
        'F19.5: star top right inside the card, not over the title',
        st.inside && st.topRight && !st.overTitle,
        JSON.stringify({ inside: st.inside, topRight: st.topRight, overTitle: st.overTitle }),
      );
      C(
        'F19.5: starred star is filled Solar',
        st.pressed === 'true' && st.fill === st.solar,
        `fill ${st.fill}, solar ${st.solar}, pressed ${st.pressed}`,
      );
      await input.click({ selector: '[data-recent-card] button[aria-pressed]', nth: 0 }); // unstar again
      await sleep(400);
      // F19.5/6 at 960x640 once more for the layout shot
      await setViewport(960, 640);
      await shot('f19-05-star-960x640');
      await setViewport(1280, 800);
      // Chrome height with four open tabs (1280x800).
      for (let i = 1; i <= 3; i++) await open(write(`tab-${i}.pdf`, plainPdf({ title: `Tab ${i}` })));
      await input.click({ selector: 'button', text: 'Back to Home' });
      await sleep(1200);
      const four = await ev(
        `(() => { const t = document.querySelector('[data-home-tools]')?.getBoundingClientRect(); return { open: document.querySelectorAll('[data-open-card]').length, bottom: t?.bottom ?? null, vh: window.innerHeight }; })()`,
      );
      await shot('f19-06-home-4tabs-1280x800');
      C(
        'F19.6 (1280x800, four open tabs): tools visible',
        four.open >= 4 && four.bottom !== null && four.bottom <= four.vh,
        JSON.stringify(four),
      );
      for (let i = 0; i < 3; i++) await closeDoc();
      // Without an open tab (the common case): tools reachable?
      await closeDoc();
      await sleep(800);
      const bare =
        await ev(`(() => { const t = document.querySelector('[data-home-tools]')?.getBoundingClientRect(); const m = document.querySelector('[data-home-body] main');
        return { top: t?.top ?? null, bottom: t?.bottom ?? null, vh: window.innerHeight, scrolls: m.scrollHeight > m.clientHeight + 1 }; })()`);
      await shot('f19-06-home-no-open-1280x800');
      console.log(
        `INFO  F19.6 (1280x800, no open tab): tools top ${bare.top}, bottom ${bare.bottom}/${bare.vh}, scrolls ${bare.scrolls}`,
      );
      C(
        'F19.6 (1280x800, no open tab): tools visible without scrolling',
        bare.bottom !== null && bare.bottom <= bare.vh,
        JSON.stringify(bare),
      );
    });
  }

  // ================================================================================================================ comments
  if (PHASES.includes('comments')) {
    await section('comments', async () => {
      if (!PHASES.includes('home')) await fresh();
      const path = write('comments.pdf', commentsPdf());
      await open(path);
      await openComments();
      await sleep(1500);
      await shot('f19-01-comments-panel-1280x800');
      const cards = await ev(
        `[...document.querySelectorAll('article[data-key]')].map((a) => a.textContent.replace(/\\s+/g, ' ').trim())`,
      );
      const want = [
        ['Acrobat note text', 'Alice Acrobat', 'Text with popup'],
        ['Reply from Bob', 'Bob Reviewer', 'reply via /IRT'],
        ['Rich only text', 'Carol Rich', 'FreeText with /RC only'],
        ['Highlight note text', 'Dave Highlighter', 'Highlight'],
        ['Ink note text', 'Erin Ink', 'Ink'],
      ];
      for (const [text, author, what] of want) {
        const ok = cards.some((c) => c.includes(text) && c.includes(author));
        C(
          `F19.1: ${what} listed with author and text`,
          ok,
          ok ? '' : `cards: ${cards.map((c) => c.slice(0, 60)).join(' | ')}`,
        );
      }
      C(
        'F19.1: no stray Popup entry (5 threads, the reply is nested)',
        cards.length === 5 && !cards.some((c) => /popup/i.test(c)),
        `${cards.length} cards`,
      );

      // F19.11: only the quote span is tinted
      const tint = await ev(`(() => {
        const a = ${cardOf('Highlight note text')}; if (!a) return null;
        const marks = [...a.querySelectorAll('[data-cite-fill]')]; const m = a.querySelector('[data-quote-mark]');
        const alpha = (e) => { const c = getComputedStyle(e).backgroundColor; const mt = c.match(/[\\d.]+/g) ?? []; return mt.length >= 4 ? Number(mt[3]) : (c === 'transparent' ? 0 : 1); };
        const ar = a.getBoundingClientRect(); const mr = m?.getBoundingClientRect();
        return { tinted: marks.length, quoteTinted: m ? alpha(m) > 0 : false, parentClear: m ? alpha(m.parentElement) === 0 : false,
          articleClear: alpha(a) === 1 || alpha(a) === 0 ? 'plain' : 'tinted', narrow: mr ? mr.width < ar.width * 0.95 : false,
          others: [...a.querySelectorAll('*')].filter((e) => !e.matches('[data-cite-fill], svg, svg *, button, button *, input, textarea') && alpha(e) > 0 && e.tagName === 'SPAN' && e !== m).length };
      })()`);
      await shot('f19-11-quote-tint');
      C(
        'F19.11: card tint only on the quote span',
        tint !== null && tint.tinted === 1 && tint.quoteTinted && tint.parentClear && tint.narrow,
        JSON.stringify(tint),
      );

      // F19.10: bubbles in the margin column, right of their page, for both orientations and both window sizes
      for (const [w, h] of [
        [1280, 800],
        [960, 640],
      ]) {
        await setViewport(w, h);
        for (const n of [1, 2]) {
          await pageRect(n);
          await sleep(500);
          const r = await ev(`(() => {
            const pages = [...document.querySelectorAll('[data-page]')].map((e) => { const r = e.getBoundingClientRect(); return { n: Number(e.dataset.page), l: r.left, r: r.right, t: r.top, b: r.bottom }; });
            const items = [...document.querySelectorAll('[data-margin-column] [data-item]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.item, l: r.left, r: r.right, t: r.top, b: r.bottom }; });
            return { pages, items, column: document.querySelector('[data-margin-column]')?.getAttribute('data-margin-column') ?? null, vw: window.innerWidth };
          })()`);
          const page = r.pages.find((p) => p.n === n);
          // An item belongs to the page whose vertical span holds its top; it must start right of that page's edge, not overlap any page.
          const inPage = r.items.filter((it) => page && it.t >= page.t - 2 && it.t <= page.b);
          const bad = r.items.filter((it) =>
            r.pages.some((p) => it.l < p.r - 0.5 && it.r > p.l + 0.5 && it.t < p.b && it.b > p.t),
          );
          await shot(`f19-10-bubbles-p${n}-${w}x${h}`);
          C(
            `F19.10 (${w}x${h}, page ${n}${n === 2 ? ' landscape' : ''}): every bubble right of its page, no overlap`,
            r.column !== null && inPage.length >= 1 && bad.length === 0 && inPage.every((it) => it.l >= page.r - 0.5),
            `column ${r.column}, ${inPage.length}/${r.items.length} items on the page, ${bad.length} overlapping`,
          );
        }
      }
      await setViewport(1280, 800);

      // F19.9: two lines selected -> one bar per line
      await openComments(); // keep the panel; select tool lives in Read
      await mode('read');
      await input.click({ selector: '[data-toolbar-item="select"]' }).catch(() => {});
      const r1 = await pageRect(1);
      await input
        .waitFor(`document.querySelector('[data-text-page="0"], [data-text-page="1"]')?.dataset.textLength > 0`, {
          timeoutMs: 8000,
          what: 'text layer',
        })
        .catch(() => {});
      const a = toClient(r1, 612, 792, 90, 684); // inside line 2 (line 1 carries the highlight comment)
      const b = toClient(r1, 612, 792, 200, 664); // inside line 3
      await input.drag(a, b, { steps: 12 });
      await sleep(600);
      const bars = await ev(
        `(() => [...document.querySelectorAll('[data-selection-bars] rect')].map((e) => ({ y: Number(e.getAttribute('y')), h: Number(e.getAttribute('height')), w: Number(e.getAttribute('width')) })))()`,
      );
      await shot('f19-09-selection-bars');
      const distinct = new Set(bars.map((x) => Math.round(x.y))).size;
      C(
        'F19.9: selection across two lines = one bar element per line (2)',
        bars.length === 2 && distinct === 2,
        JSON.stringify(bars),
      );
      await input.press('Escape');
      await ev('window.getSelection()?.removeAllRanges()');

      // F19.2: hover inside the split button
      await mode('comment');
      await sleep(600);
      for (const slot of ['highlight', 'shapes']) {
        for (const part of ['main', 'chevron']) {
          const sel =
            part === 'main'
              ? `[data-split="${slot}"] [data-toolbar-item="${slot}"]`
              : `[data-split="${slot}"] [data-roving="${slot}:more"]`;
          await input.hover({ selector: sel });
          await sleep(350);
          const hv = await ev(`(() => {
            const split = document.querySelector('[data-split="${slot}"]'); const sr = split.getBoundingClientRect();
            const kids = [...split.querySelectorAll('button')].filter((c) => c.getBoundingClientRect().width > 0);
            const ub = { l: Math.min(...kids.map((k) => k.getBoundingClientRect().left)), r: Math.max(...kids.map((k) => k.getBoundingClientRect().right)),
              t: Math.min(...kids.map((k) => k.getBoundingClientRect().top)), b: Math.max(...kids.map((k) => k.getBoundingClientRect().bottom)) };
            const hovered = [...document.querySelectorAll(':hover')].filter((e) => split.contains(e) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
            const out = (e) => { const r = e.getBoundingClientRect(); return Math.max(0, sr.left - r.left, r.right - sr.right, sr.top - r.top, r.bottom - sr.bottom); };
            const alpha = (e) => { const c = getComputedStyle(e).backgroundColor; const m = c.match(/[\\d.]+/g) ?? []; return m.length >= 4 ? Number(m[3]) : (c === 'transparent' ? 0 : 1); };
            const painted = hovered.filter((e) => alpha(e) > 0);
            return { overshoot: Math.max(0, ...hovered.map(out)), painted: painted.length, extra: Math.max(Math.abs(ub.l - sr.left), Math.abs(ub.r - sr.right), Math.abs(ub.t - sr.top), Math.abs(ub.b - sr.bottom)),
              clip: getComputedStyle(split).overflow,
              dbg: { split: [sr.left, sr.right, sr.top, sr.bottom].map(Math.round), kids: kids.map((k) => k.tagName + (k.getAttribute('data-roving') ?? '') + ':' + [k.getBoundingClientRect().left, k.getBoundingClientRect().right].map(Math.round)), hov: hovered.map((e) => e.tagName + '.' + String(e.className).slice(0, 20) + ':' + [e.getBoundingClientRect().left, e.getBoundingClientRect().right].map(Math.round)) } };
          })()`);
          C(
            `F19.2: hover on ${slot} ${part} stays inside the button box (0 px)`,
            hv.overshoot <= 0.5 && hv.painted >= 1 && hv.extra <= 0.5,
            JSON.stringify(hv),
          );
        }
      }
      await shot('f19-02-hover-highlight');
      await ev(`document.activeElement?.blur?.()`);

      // F19.1: edit a comment in the panel, save, reopen
      await mode('comment');
      await openComments();
      const idx = await ev(
        `[...document.querySelectorAll('article[data-key]')].findIndex((a) => a.textContent.includes(${q(process.env.V20_EDIT ?? 'Acrobat note text')}))`,
      );
      C('F19.1: adopted Text comment is findable for editing', idx >= 0, `index ${idx}`);
      if (idx >= 0) {
        const art = `article[data-key]`;
        await input.click({ selector: `${art} button[aria-label="Comment options"]`, nth: idx });
        await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'card menu' });
        await input.click({ selector: '[role="menu"] [role="menuitem"]', text: 'Edit' });
        await sleep(600);
        await input.waitFor(`!!document.querySelector('article[data-key] textarea')`, {
          timeoutMs: 4000,
          what: 'edit field',
        });
        await input.press('a', { ctrl: true });
        await input.insertText('Edited by the script');
        await sleep(300);
        await input.click({ selector: 'article[data-key] div.justify-end button', text: 'Comment' });
        await sleep(900);
        const edited = await ev(
          `[...document.querySelectorAll('article[data-key]')].some((a) => a.textContent.includes('Edited by the script'))`,
        );
        C('F19.1: change of the comment text shows in the panel', edited);
        if (process.env.V20_DEBUG)
          console.log(
            'DEBUG before save:',
            JSON.stringify(
              await ev(`[...document.querySelectorAll('[role=status]')].map((d) => d.textContent.slice(0, 60))`),
            ),
            JSON.stringify(
              await ev(
                `[...document.querySelectorAll('[data-slot="topbar"] *')].filter((e) => !e.children.length && e.textContent.trim()).map((e) => e.textContent.trim()).slice(0, 12)`,
              ),
            ),
          );
        // The edit is staged: it must make the document unsaved.
        C(
          'F19.1: editing an adopted comment marks the document unsaved',
          await ev(`!/Saved/.test(document.querySelector('[data-slot="topbar"]')?.textContent ?? '')`),
        );
        await save();
        await closeDoc();
        const dirtyPrompt = await dialogCount();
        if (dirtyPrompt) {
          C('F19.1: no unsaved prompt after save', false, 'prompt appeared');
          await input.press('Escape');
        }
        await open(path);
        await openComments();
        await sleep(1500);
        const kept = await ev(
          `[...document.querySelectorAll('article[data-key]')].some((a) => a.textContent.includes('Edited by the script') && a.textContent.includes('Alice Acrobat'))`,
        );
        const others = await ev(
          `['Reply from Bob', 'Rich only text', 'Highlight note text', 'Ink note text'].every((t) => [...document.querySelectorAll('article[data-key]')].some((a) => a.textContent.includes(t)))`,
        );
        C(
          'F19.1: after save and reopen the edited text is kept (author unchanged)',
          kept,
          kept
            ? ''
            : (
                await ev(
                  `[...document.querySelectorAll('article[data-key]')].map((a) => a.textContent.replace(/\s+/g, ' ').slice(0, 70))`,
                )
              ).join(' | '),
        );
        C('F19.1: after reopen the other adopted comments are still all listed', others);
        await shot('f19-01-comments-reopened');
      }
    });
  }

  // ================================================================================================================ F19.7 crop
  if (PHASES.includes('crop')) {
    await section('crop', async () => {
      if (!PHASES.includes('home') && !PHASES.includes('comments')) await fresh();
      await setViewport(1280, 800);
      await open(write('crop.pdf', plainPdf({ title: 'Crop' })));
      await mode('edit');
      const before = await pageRect(1);
      await input.click({ selector: '[data-toolbar-item="crop"]' });
      await input.waitFor(`!!document.querySelector('[data-crop-catcher]')`, { timeoutMs: 6000, what: 'crop layer' });
      await sleep(500);
      const r0 = await ev(
        `(() => { const r = document.querySelector('[data-page]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`,
      );
      // Cancel first: no popup is left behind.
      await input.drag(atTop(await curRect(1), 300, 235), atTop(await curRect(1), 560, 380), { steps: 8 });
      await input
        .waitFor(`!!document.querySelector('[data-crop-bar]')`, { timeoutMs: 4000, what: 'crop bar' })
        .catch(async (e) => {
          await shot('debug-crop');
          throw e;
        });
      await shot('f19-07-crop-drawn');
      await input.click({ selector: '[data-crop-bar] button', text: 'Cancel' });
      await sleep(800);
      const afterCancel =
        await ev(`({ dialogs: document.querySelectorAll('[role="dialog"]').length, bar: !!document.querySelector('[data-crop-bar]'),
        on: document.querySelector('[data-toolbar-item="crop"]')?.getAttribute('aria-pressed') })`);
      C(
        'F19.7: Cancel leaves no popup and the tool off',
        afterCancel.dialogs === 0 && !afterCancel.bar && afterCancel.on === 'false',
        JSON.stringify(afterCancel),
      );
      // Apply with one click.
      await input.click({ selector: '[data-toolbar-item="crop"]' });
      await input.waitFor(`!!document.querySelector('[data-crop-catcher]')`, { timeoutMs: 6000, what: 'crop layer' });
      await sleep(500);
      const r1 = await ev(
        `(() => { const r = document.querySelector('[data-page]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`,
      );
      await input.drag(atTop(await curRect(1), 290, 225), atTop(await curRect(1), 570, 385), { steps: 8 });
      await input.waitFor(`!!document.querySelector('[data-crop-bar]')`, { timeoutMs: 4000, what: 'crop bar' });
      await input.click({ selector: '[data-crop-bar] button', text: 'Apply' });
      await sleep(600);
      const probe = () =>
        ev(`(() => { const p = document.querySelector('[data-page="1"]'); const img = p?.querySelector('img'); if (!p || !img) return null;
          const r = p.getBoundingClientRect(); const ir = img.getBoundingClientRect();
          const text = document.querySelector('[data-text-page]');
          return { aspect: r.width / r.height, imgAspect: img.naturalWidth / img.naturalHeight, boxAspect: ir.width / ir.height, nat: img.naturalWidth, shown: ir.width,
            bar: !!document.querySelector('[data-crop-bar]'), dialogs: document.querySelectorAll('[role="dialog"]').length, textLen: Number(text?.getAttribute('data-text-length') ?? 0) }; })()`);
      let p = await probe();
      for (let i = 0; i < 20 && p && (Math.abs(p.imgAspect / p.boxAspect - 1) > 0.02 || p.nat < p.shown * 0.9); i++) {
        await sleep(400);
        p = await probe();
      }
      await shot('f19-07-crop-applied');
      const orig = 612 / 792;
      C(
        'F19.7: Apply in one click crops the page (shape changed, bar gone, no popup)',
        p && !p.bar && p.dialogs === 0 && Math.abs(p.aspect / orig - 1) > 0.05,
        JSON.stringify(p),
      );
      C(
        'F19.7: cropped page is sharp, not a stretched stand-in',
        p && Math.abs(p.imgAspect / p.boxAspect - 1) <= 0.02 && p.nat >= p.shown * 0.9,
        JSON.stringify(p),
      );
      // Text still selectable: select by dragging across the first line.
      const r2 = await pageRect(1);
      await input.press('Escape');
      await mode('read');
      await input.click({ selector: '[data-toolbar-item="select"]' }).catch(() => {});
      await sleep(500);
      await input.drag(atTop(r2, 80, 95), atTop(r2, 330, 95), { steps: 10 });
      await sleep(500);
      const sel = await ev(`window.getSelection()?.toString().length ?? 0`);
      const textLen = (await probe())?.textLen ?? 0;
      C(
        'F19.7: text on the cropped page is still there and selectable',
        textLen > 0 && sel > 0,
        `text layer ${textLen}, selection ${sel} chars`,
      );
      await ev('window.getSelection()?.removeAllRanges()');
      void before;
    });
  }

  // ================================================================================================================ F19.8 redact
  if (PHASES.includes('redact')) {
    await section('redact', async () => {
      if (!PHASES.some((p) => ['home', 'comments', 'crop'].includes(p))) await fresh();
      await setViewport(1280, 800);
      await open(write('redact.pdf', plainPdf({ title: 'Redact' })));
      await mode('edit');
      await input.click({ selector: '[data-toolbar-item="redact"]' });
      await input.waitFor(`!!document.querySelector('[data-banner="redact"]')`, {
        timeoutMs: 6000,
        what: 'redact band',
      });
      await sleep(500);
      const r = await pageRect(1);
      const areas = [
        [72, 170, 200, 195],
        [260, 170, 400, 195],
        [72, 215, 200, 240],
      ];
      for (const [x0, y0, x1, y1] of areas) {
        await input.drag(atTop(await curRect(1), x0, y0), atTop(await curRect(1), x1, y1), { steps: 8 });
        await sleep(700);
      }
      const ids = () =>
        ev(
          `new Set([...document.querySelectorAll('[data-redact-mark]')].map((e) => e.getAttribute('data-redact-mark'))).size`,
        );
      const n = await ids();
      const noise = await ev(
        `({ dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length, minibar: !!document.querySelector('[data-minibar]') })`,
      );
      await shot('f19-08-redact-3-marks');
      C('F19.8: three marks placed', n === 3, `${n} marks`);
      C(
        'F19.8: placing marks opens no dialog and no mini bar',
        noise.dialogs === 0 && !noise.minibar,
        JSON.stringify(noise),
      );
      // Leave the mode (keeps the marks), delete one with the Select tool.
      await input.click({ selector: '[data-banner="redact"] button', text: 'Cancel' });
      await sleep(900);
      await mode('read');
      await input.click({ selector: '[data-toolbar-item="select"]' }).catch(() => {});
      await sleep(600);
      const before = await ids();
      await input.click({ selector: '[data-redact-layer] [role="button"]', nth: 0 });
      await sleep(500);
      await input.press('Delete');
      await sleep(900);
      const after = await ids();
      await shot('f19-08-redact-deleted');
      C('F19.8: click a mark in Select, Delete removes it', before === 3 && after === 2, `${before} -> ${after}`);
      // Apply: exactly one confirmation.
      await mode('edit');
      await input.click({ selector: '[data-toolbar-item="redact"]' });
      await input.waitFor(`!!document.querySelector('[data-banner="redact"]')`, {
        timeoutMs: 6000,
        what: 'redact band',
      });
      await sleep(500);
      const none = await ev(
        `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((d) => /Redact permanently/.test(d.textContent)).length`,
      );
      await input.click({ selector: '[data-banner="redact"] button', text: 'Apply' });
      await sleep(900);
      const dlgs = await ev(
        `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => d.textContent.replace(/\\s+/g, ' ').slice(0, 60))`,
      );
      await shot('f19-08-redact-confirm');
      C(
        'F19.8: Apply opens exactly one confirmation',
        none === 0 && dlgs.filter((d) => /Redact permanently/.test(d)).length === 1,
        `${none} before, ${dlgs.length} after: ${dlgs.join(' | ')}`,
      );
      await input
        .click({ selector: '[role="dialog"] button, [role="alertdialog"] button', text: 'Cancel' })
        .catch(() => input.press('Escape'));
      await sleep(600);
      await input.click({ selector: '[data-banner="redact"] button', text: 'Cancel' }).catch(() => {});
      await sleep(500);
    });
  }

  // ================================================================================================================ F19.12 hf
  if (PHASES.includes('hf')) {
    await section('hf', async () => {
      if (!PHASES.some((p) => ['home', 'comments', 'crop', 'redact'].includes(p))) await fresh();
      await setViewport(1280, 800);
      const path = write('hf.pdf', plainPdf({ pages: 3, header: true, title: 'Report' }));
      await open(path);
      await mode('edit');
      await input.click({ selector: '[data-toolbar-item="headerFooter"]' });
      await input.waitFor(`!!document.querySelector('[data-surface="hf-dialog"]')`, {
        timeoutMs: 6000,
        what: 'hf dialog',
      });
      await input
        .waitFor(`!!document.querySelector('[data-hf="detected"]')`, { timeoutMs: 15000, what: 'detected headers' })
        .catch(() => {});
      const det = await ev(`document.querySelector('[data-hf="detected"]')?.textContent ?? ''`);
      C('F19.12: existing running header detected and listed', /Quarterly Report/.test(det), det.slice(0, 160));
      // A new header text in the centre, on top of the old one.
      await input.click({ selector: '[data-hf-slot="headerCenter"]' });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'slot menu' });
      await input.click({ selector: '[role^="menuitem"]', text: 'Text' });
      await sleep(500);
      await input.click({ selector: '[data-hf="text"]' });
      await input.press('a', { ctrl: true });
      await input.insertText('Draft');
      await input
        .waitFor(`!!document.querySelector('[data-hf="overlap"]')`, { timeoutMs: 8000, what: 'overlap warning' })
        .catch(() => {});
      const warn = await ev(`document.querySelector('[data-hf="overlap"]')?.textContent ?? ''`);
      await shot('f19-12-hf-overlap-1280x800');
      C(
        'F19.12: overlap warning shown for the new text on the old header',
        /Overlaps existing text/.test(warn),
        warn.slice(0, 160),
      );
      await setViewport(960, 640);
      await shot('f19-12-hf-overlap-960x640');
      const fits = await ev(
        `(() => { const f = document.querySelector('[data-surface="hf-dialog"]').closest('[role="dialog"]') ?? document.querySelector('[data-surface="hf-dialog"]'); const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1; })()`,
      );
      console.log(`INFO  F19.12 (960x640): dialog inside the window: ${fits}`);
      await setViewport(1280, 800);
      // Background on: the warning turns into "covers", Apply writes a box.
      await input
        .click({ selector: '[data-hf="background-toggle"]' })
        .catch(async () => input.click({ selector: 'label', text: 'Cover what is underneath' }));
      await sleep(700);
      const covers = await ev(`document.querySelector('[data-hf="covers"]')?.textContent ?? ''`);
      await shot('f19-12-hf-background');
      C(
        'F19.12: with the background option the warning says it covers the text',
        /Covers existing text/.test(covers),
        covers.slice(0, 160),
      );
      await input.click({ selector: '[data-hf="apply"]' });
      await input.waitFor(`!document.querySelector('[data-surface="hf-dialog"]')`, {
        timeoutMs: 15000,
        what: 'dialog closed',
      });
      await sleep(800);
      await save();
      const raw = readFileSync(path);
      let streams = raw.toString('latin1');
      for (const m of raw.toString('latin1').matchAll(/stream\r?\n/g)) {
        const start = m.index + m[0].length;
        const end = raw.indexOf('endstream', start);
        if (end < 0) continue;
        try {
          streams += '\n' + inflateSync(raw.subarray(start, end)).toString('latin1');
        } catch {
          /* not Flate */
        }
      }
      const box =
        /[\d.]+ [\d.]+ [\d.]+ rg\s+[-\d.]+ [-\d.]+ m [-\d.]+ [-\d.]+ l [-\d.]+ [-\d.]+ l [-\d.]+ [-\d.]+ l h f/.test(
          streams,
        );
      C('F19.12: background option wrote a filled box into the saved file', box, `saved ${raw.length} bytes`);
      await closeDoc();
    });
  }

  // ================================================================================================================ F19.13 shapes
  if (PHASES.includes('shapes')) {
    await section('shapes', async () => {
      if (!PHASES.some((p) => ['home', 'comments', 'crop', 'redact', 'hf'].includes(p))) await fresh();
      await setViewport(1280, 800);
      await open(write('shapes.pdf', plainPdf({ title: 'Shapes' })));
      await mode('comment');
      await openComments();
      await input.click({ selector: '[data-toolbar-item="draw"]' });
      await sleep(600);
      const r = await pageRect(1);
      const cardsNow = () =>
        ev(
          `[...document.querySelectorAll('article[data-key]')].map((a) => a.querySelector('header')?.textContent.replace(/\\s+/g, ' ').trim() ?? a.textContent.slice(0, 40))`,
        );
      const n0 = (await cardsNow()).length;
      // Arrow: a shaft of 200 px with a hook (arm out, back, other arm) at the tip.
      const x0 = atTop(r, 100, 0).x;
      const y0 = atTop(r, 0, 170).y;
      const pts = [];
      for (let i = 0; i <= 24; i++) pts.push({ x: x0 + (200 * i) / 24, y: y0 });
      const tip = { x: x0 + 200, y: y0 };
      for (let i = 1; i <= 5; i++) pts.push({ x: tip.x - (18 * i) / 5, y: tip.y - (24 * i) / 5 });
      for (let i = 4; i >= 0; i--) pts.push({ x: tip.x - (18 * i) / 5, y: tip.y - (24 * i) / 5 });
      for (let i = 1; i <= 5; i++) pts.push({ x: tip.x - (18 * i) / 5, y: tip.y + (24 * i) / 5 });
      await stroke(pts);
      await sleep(2200);
      let cards = await cardsNow();
      await shot('f19-13-arrow');
      C(
        'F19.13: a drawn arrow becomes an arrow shape',
        cards.length === n0 + 1 && /arrow/i.test(cards.join(' | ')),
        cards.join(' | ').slice(0, 200),
      );
      // Open circles: 85 % (the brief), and 83 % and 80 % (F19.13 says "from 80 %").
      for (const [share, cxPt, brief] of [
        [0.85, 400, true],
        [0.83, 280, false],
        [0.8, 160, false],
      ]) {
        const cx = atTop(r, cxPt, 0).x;
        const cy = atTop(r, 0, 250).y;
        const rad = 50;
        const circle = [];
        const total = share * 2 * Math.PI;
        for (let i = 0; i <= 70; i++) {
          const a = -Math.PI / 2 + (total * i) / 70;
          circle.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
        }
        await stroke(circle);
        await sleep(2200);
        cards = await cardsNow();
        const ellipses = cards.filter((c) => /ellipse/i.test(c)).length;
        const nth = [0.85, 0.83, 0.8].indexOf(share) + 1;
        if (brief) await shot('f19-13-ellipse');
        C(
          `F19.13: an open circle of ${Math.round(share * 100)} % becomes an ellipse`,
          ellipses === nth,
          cards.join(' | ').slice(0, 240),
        );
      }
      await input.press('Escape');
    });
  }

  // ================================================================================================================ F19.15 props
  if (PHASES.includes('props')) {
    await section('props', async () => {
      if (!PHASES.some((p) => ['home', 'comments', 'crop', 'redact', 'hf', 'shapes'].includes(p))) {
        await fresh();
        await open(write('props.pdf', plainPdf({ title: 'Props' })));
      }
      await setViewport(960, 640);
      await menu('File', 'Document Properties');
      await input.waitFor(`!!document.querySelector('[role="dialog"] [role="tabpanel"]')`, {
        timeoutMs: 6000,
        what: 'properties dialog',
      });
      await sleep(600);
      // Keyboard focus into a field of the scrolling panel.
      let inPanel = false;
      for (let i = 0; i < 12 && !inPanel; i++) {
        await input.press('Tab');
        await sleep(150);
        inPanel = await ev(
          `!!document.activeElement?.closest?.('[role="tabpanel"]') && document.activeElement.matches('input, textarea')`,
        );
      }
      C('F19.15: keyboard focus reaches a field in the scrolling panel', inPanel);
      const measure = () =>
        ev(`(() => {
          const el = document.activeElement; const panel = el.closest('[role="tabpanel"]'); const ring = document.querySelector('[data-focus-ring]');
          if (!ring) return { noRing: true };
          const rr = ring.getBoundingClientRect(); const er = el.getBoundingClientRect(); const pr = panel.getBoundingClientRect();
          const clip = ring.style.clipPath; const m = clip.match(/inset\\(([^)]*)\\)/);
          const hidden = ring.style.opacity === '0' || clip === 'hidden' || getComputedStyle(ring).visibility === 'hidden';
          const raw = m ? m[1].trim().split(/\\s+/).map((v) => parseFloat(v)) : [0];
          const ins = [raw[0], raw[1] ?? raw[0], raw[2] ?? raw[0], raw[3] ?? raw[1] ?? raw[0]];
          const vis = { t: rr.top + Math.max(0, ins[0]), r: rr.right - Math.max(0, ins[1]), b: rr.bottom - Math.max(0, ins[2]), l: rr.left + Math.max(0, ins[3]) };
          const within = vis.t >= pr.top - 1 && vis.b <= pr.bottom + 1 && vis.l >= pr.left - 1 && vis.r <= pr.right + 1;
          const aligned = Math.abs(rr.top - er.top) <= 3 && Math.abs(rr.left - er.left) <= 3 && Math.abs(rr.width - er.width) <= 4 && Math.abs(rr.height - er.height) <= 4;
          return { clip, ring: [rr.top, rr.bottom].map(Math.round), el: [er.top, er.bottom].map(Math.round), panel: [pr.top, pr.bottom].map(Math.round), hidden, within, aligned, scrollTop: panel.scrollTop, canScroll: panel.scrollHeight > panel.clientHeight + 1, elInView: er.top >= pr.top && er.bottom <= pr.bottom };
        })()`);
      const scrollBy = async (dy) => {
        await ev(`(() => { const p = document.activeElement.closest('[role="tabpanel"]'); p.scrollTop += ${dy}; })()`);
        await sleep(450);
      };
      const m0 = await measure();
      await shot('f19-15-props-focus');
      C('F19.15: ring on its field before scrolling', !m0.noRing && (m0.hidden || m0.aligned), JSON.stringify(m0));
      if (!m0.canScroll) {
        console.log('INFO  F19.15: the panel does not scroll at 960x640; shrinking the window to 960x420');
        await setViewport(960, 420);
        await sleep(600);
      }
      const m1pre = await measure();
      await scrollBy(40);
      const m1 = await measure();
      await shot('f19-15-props-scrolled-small');
      C(
        'F19.15: after a small scroll the ring stays on its field (or is clipped to the panel)',
        m1pre.canScroll && !m1.noRing && (m1.hidden || (m1.within && (!m1.elInView || m1.aligned))),
        JSON.stringify({ canScroll: m1pre.canScroll, ...m1 }),
      );
      await scrollBy(2000);
      const m2 = await measure();
      await shot('f19-15-props-scrolled-far');
      C(
        'F19.15: scrolled far, the ring is clipped to the panel and never over other fields',
        !m2.noRing && (m2.hidden || m2.within),
        JSON.stringify(m2),
      );
      await scrollBy(-4000);
      await input.press('Escape');
      await setViewport(1280, 800);
    });
  }

  // ================================================================================================================ F19.3 sidebar (part 1)
  if (PHASES.includes('sidebar')) {
    await section('sidebar', async () => {
      await setViewport(1280, 800);
      await ev(
        `document.querySelector('[role="dialog"]') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`,
      );
      const sep = '[role="separator"][aria-label="Resize left panel"]';
      if (!(await exists(sep))) {
        await open(write('sidebar.pdf', plainPdf({ title: 'Sidebar' })));
      }
      await mode('read');
      const w0 = await ev(`Number(document.querySelector(${q(sep)}).getAttribute('aria-valuenow'))`);
      const rect = await input.rectOf({ selector: sep });
      await input.drag(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        { x: rect.left + 600, y: rect.top + rect.height / 2 },
        { steps: 14 },
      );
      await sleep(700);
      const w1 = await ev(`Number(document.querySelector(${q(sep)}).getAttribute('aria-valuenow'))`);
      const px = await ev(`document.querySelector('[data-region="left"]')?.getBoundingClientRect().width ?? null`);
      await shot('f19-03-sidebar-480');
      C(
        'F19.3: dragging the sidebar edge far right stops at 480 px',
        w0 < 480 && w1 === 480,
        `${w0} -> ${w1}, panel ${px} px`,
      );
      await sleep(2500); // the width is written to the settings after it has been still
    });
  }

  const err = await dialogs.lastError();
  if (err) C('no automation error', false, JSON.stringify(err));
};

let code = await runSession(session, results);

// ---- relaunch: the sidebar keeps its width (F19.3) ---------------------------------------------------------------------------
if (PHASES.includes('sidebar')) {
  const second = async (ctx) => {
    const { input, dialogs, ev } = ctx;
    await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'UI language' });
    const path = write('sidebar2.pdf', plainPdf({ title: 'Sidebar again' }));
    await sleep(800);
    await dialogs.openFile(path);
    await input.waitFor(`document.querySelectorAll('[data-page] img').length > 0`, {
      timeoutMs: 40000,
      what: 'page image',
    });
    await sleep(1200);
    const sep = '[role="separator"][aria-label="Resize left panel"]';
    const w = await ev(`Number(document.querySelector(${q(sep)})?.getAttribute('aria-valuenow'))`);
    await input.screenshot(`${SHOTS}/f19-03-sidebar-relaunched`);
    results.check('F19.3: after a relaunch the sidebar keeps 480 px', w === 480, `width ${w}`);
    // leave the settings as found
    await ev(`window.__TAURI_INTERNALS__.invoke('update_settings', { patch: { leftPanelWidth: 200 } })`);
    await sleep(500);
  };
  const c2 = await runSession(second, results);
  code = code || c2;
}

results.table();
process.exit(code || results.failed() ? 1 : 0);
void existsSync;
