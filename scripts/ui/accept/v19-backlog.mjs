// Acceptance v1.9 "Backlog" (DESIGN 3.14 ST-AC, 3.15 HF-AC, 3.16 CE-AC, 3.17 DZ-AC as far as scriptable). Self-made documents only:
// tests/fixtures/text.pdf (copied to review/v190/out) and tests/fixtures/signed.pdf (refusal). Prereq: npm run build:acceptance.
// Run: node scripts/ui/accept/v19-backlog.mjs   (German UI; V19_PHASES=stamps,hf,export,cite to select; one launch, shared state)
// Screenshots (light): review/v190/shots/*.png (1280x800; the HF and export dialogs again at 960x640).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createResults, runSession, openAndWait, sleep } from './harness.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const TEXT = resolve(ROOT, 'tests/fixtures/text.pdf');
const OUT = resolve(ROOT, 'review/v190/out');
const SHOTS = 'v190/shots';
const q = (s) => JSON.stringify(s);
const PHASES = (process.env.V19_PHASES ?? 'stamps,hf,export,cite').split(',');

if (!existsSync(TEXT)) {
  console.log(`SKIPPED: ${TEXT} is missing`);
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
// The app keeps recovery data per path: every run works on fresh, uniquely named copies of the fixture.
const RUN = Date.now().toString(36);
for (const f of readdirSync(OUT))
  if (/^(stamps|hf|comments|cites2?)-/.test(f) || /^export-/.test(f)) rmSync(join(OUT, f), { force: true });
const WORK = (name) => join(OUT, name.replace(/(.pdf)$/, `-${RUN}$1`));
for (const name of ['stamps.pdf', 'hf.pdf', 'comments.pdf', 'cites.pdf', 'cites2.pdf']) copyFileSync(TEXT, WORK(name));

const results = createResults();
const { check: C } = results;

const session = async (ctx) => {
  const { input, dialogs, ev, session: s } = ctx;
  const T = {
    file: 'Datei',
    edit: 'Bearbeiten',
    tools: 'Werkzeuge',
    close: 'Dokument schließen',
    stamp: 'Stempel…',
    hf: 'Kopf- und Fußzeile…',
    exportComments: 'Kommentare exportieren…',
    view: 'Ansicht',
    leftPanel: 'Linke Seitenleiste',
  };
  // rc.3 (DESIGN 3.18): the tool inspector is the 300 px column right of the canvas; stamp picker and header/footer panel live in it.
  const INSPECTOR = '[data-slot="inspector"][data-open]';
  const SPLITTER = '[role="separator"][aria-label="Breite der Seitenleiste ändern"]';

  // ---- helpers ------------------------------------------------------------------------------------------------------------
  async function fresh(lang = 'de') {
    const patch = {
      language: lang,
      welcomeTour: 'shown',
      authorPrompt: 'done',
      pageSidebarCollapsed: true,
      tipsEnabled: false,
    };
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(patch)} }).then(() => 'ok', (e) => 'ERR ' + JSON.stringify(e))`,
    );
    if (r !== 'ok') throw new Error(`update_settings failed: ${r}`);
    await ev(
      `['sheer.tools.stamp', 'sheer.commentExport.format', 'sheer.citations.style'].forEach((k) => localStorage.removeItem(k))`,
    );
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === ${q(lang)}`, { timeoutMs: 20000, what: 'UI language' });
  }
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      C(`${name}: ran to the end`, false, e.message);
      await input.press('Escape').catch(() => {});
    }
  };
  const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);
  const open = (path) => openAndWait(ctx, path);
  const mode = async (id) => {
    await input.click({ selector: `[data-mode="${id}"]` });
    await sleep(500);
  };
  async function menu(top, item) {
    await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: top });
    await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: `menu ${top}` });
    await sleep(250);
    await input.click({ selector: '[role="menu"] [role="menuitem"]', text: item });
    await sleep(600);
  }

  async function openComments() {
    // rc.3: no top-bar toggle any more; the sidebar comes back through View > Left panel (F4), else the splitter's grip.
    if (!(await exists('[role="tab"][data-value="comments"]'))) {
      await menu(T.view, T.leftPanel).catch(() => {});
      if (!(await exists('[role="tab"][data-value="comments"]'))) await input.click({ selector: SPLITTER });
      await sleep(500);
    }
    if (process.env.V19_DEBUG) await input.screenshot(`${SHOTS}/debug-comments`);
    await input.click({ selector: '[role="tab"][data-value="comments"]' });
    await sleep(900);
  }
  async function saveDoc() {
    // Shortcuts never run from a text field (src/actions/keys.ts): a dialog closed after a search gives focus back to the search
    // box, where Ctrl+S would be ignored. Leave the field first.
    await ev(
      `document.activeElement?.closest?.('input,textarea,[contenteditable="true"]') && document.activeElement.blur()`,
    );
    await input.press('s', { ctrl: true });
    await sleep(2000);
  }
  async function closeDoc() {
    await menu(T.file, T.close);
    await sleep(1000);
    if (await exists('[role="alertdialog"]')) {
      C('close after save: no unsaved prompt', false, 'prompt appeared');
      await input.press('Escape');
    }
  }
  const count = (sel) => ev(`document.querySelectorAll(${q(sel)}).length`);
  const SC = '[data-action-scope="canvas"] > [role="region"]';
  /** Page n (1-based) rect in client px, after the page was scrolled so that the page fraction (fx, fy) is in the middle. */
  async function pageAt(n, fy = 0.5) {
    // Pages far away are not in the DOM: scroll towards the page until it is.
    for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('[data-page="${n}"]')`)); i++) {
      const dir = await ev(
        `(() => { const nums = [...document.querySelectorAll('[data-page]')].map((e) => Number(e.dataset.page)); return nums.length && nums[0] > ${n} ? -1 : 1; })()`,
      );
      await ev(`document.querySelector(${q(SC)}).scrollTop += ${'${DIR}'} * 500`.replace('${DIR}', String(dir)));
      await sleep(250);
    }
    await ev(`(() => { const sc = document.querySelector(${q(SC)}); const e = document.querySelector('[data-page="${n}"]');
      const r = e.getBoundingClientRect(); const sr = sc.getBoundingClientRect();
      sc.scrollTop += r.top + r.height * ${fy} - (sr.top + sr.height / 2); })()`);
    await sleep(500);
    return ev(`(() => { const r = document.querySelector('[data-page="${n}"]').getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  }
  /** Rect of an annotation frame in PDF points relative to the (unrotated) page n, plus its element facts. */
  async function frameOf(id, n = 1) {
    for (let i = 0; i < 10; i++) {
      if (!(await ev(`!!document.querySelector('[data-page="${n}"]')`))) await pageAt(n, 0.5);
      if (await ev(`!!document.querySelector('[data-annot-frame="${id}"]')`)) break;
      await sleep(300);
    }
    return ev(`(() => { const p = document.querySelector('[data-page="${n}"]').getBoundingClientRect();
      const f = document.querySelector('[data-annot-frame="${id}"]'); if (!f) return null;
      const r = f.getBoundingClientRect(); const k = p.width / 612;
      const art = document.querySelector('[data-annot-item="${id}"] [data-stamp-art]');
      return { x: (r.left - p.left) / k, y: (r.top - p.top) / k, w: r.width / k, h: r.height / k,
        tone: art?.getAttribute('data-tone'), text: art?.textContent ?? '', label: f.getAttribute('aria-label'), px: { l: r.left, t: r.top, w: r.width, h: r.height } }; })()`);
  }
  const frameIds = () =>
    ev(`[...document.querySelectorAll('[data-annot-frame]')].map((e) => Number(e.getAttribute('data-annot-frame')))`);
  /** Non-near-white pixels in a client rect of the current window (page image only: the vector overlay is hidden meanwhile). */
  async function inkIn(rect, { hideOverlay = true } = {}) {
    if (hideOverlay)
      await ev(`document.querySelectorAll('[data-annot-layer]').forEach((e) => (e.style.visibility = 'hidden'))`);
    await sleep(150);
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    const n = await ev(`(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const k = img.width / window.innerWidth;
      const d = g.getImageData(Math.round(${rect.l} * k), Math.round(${rect.t} * k), Math.max(1, Math.round(${rect.w} * k)), Math.max(1, Math.round(${rect.h} * k))).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
      return n; })()`);
    if (hideOverlay)
      await ev(`document.querySelectorAll('[data-annot-layer]').forEach((e) => (e.style.visibility = ''))`);
    return n;
  }
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const undo = async () => {
    await input.press('z', { ctrl: true });
    await sleep(700);
  };

  // ---- stamps (ST-AC) -----------------------------------------------------------------------------------------------------
  if (PHASES.includes('stamps')) {
    await section('stamps', async () => {
      await fresh('de');
      await open(WORK('stamps.pdf'));
      await mode('edit');
      const slots = await count('[data-toolbar-item]');
      const openPicker = async () => {
        await menu(T.edit, T.stamp);
        await input.waitFor(`!!document.querySelector('[data-surface="stamp-picker"]')`, {
          timeoutMs: 5000,
          what: 'stamp picker',
        });
        await sleep(400);
      };
      await openPicker();
      // rc.3: Stempel is an own item of the tool row (no longer the Notiz split's variant) and its picker is the tool inspector.
      const stampItem = await ev(
        `(() => { const b = document.querySelector('[data-slot="tool-row"] [data-toolbar-item="stamp"]'); return b ? { text: b.textContent.trim() || b.getAttribute('aria-label'), on: b.getAttribute('data-on'), inSplit: !!b.closest('[data-split="note"]') } : null; })()`,
      );
      C(
        'ST-AC 1 (rc.3): Stempel is its own tool item (not in the Notiz split), active, picker open in the inspector',
        stampItem !== null &&
          /Stempel/.test(stampItem.text ?? '') &&
          !stampItem.inSplit &&
          stampItem.on === 'true' &&
          (await exists(`${INSPECTOR} [data-surface="stamp-picker"]`)),
        `item ${JSON.stringify(stampItem)}, items ${slots}`,
      );
      const tiles = await ev(
        `[...document.querySelectorAll('[data-stamp-tile]')].map((e) => e.getAttribute('aria-label'))`,
      );
      C(
        'ST-AC 2: tiles read ENTWURF, GENEHMIGT, VERTRAULICH, ERHALTEN + dd.mm.yyyy',
        tiles.length === 4 &&
          tiles[0] === 'ENTWURF' &&
          tiles[1] === 'GENEHMIGT' &&
          tiles[2] === 'VERTRAULICH' &&
          /^ERHALTEN, \d{2}\.\d{2}\.\d{4}$/.test(tiles[3]),
        JSON.stringify(tiles),
      );
      await input.screenshot(`${SHOTS}/stamp-picker`);
      await input.press('Escape');
      await sleep(400);

      const plan = [
        { name: 'draft', tone: 'ink', tile: 'draft', text: 'ENTWURF', fx: 0.28, fy: 0.5, h: 40 },
        { name: 'approved', tone: 'solar', tile: 'approved', text: 'GENEHMIGT', fx: 0.72, fy: 0.5, h: 40 },
        { name: 'confidential', tone: 'solar', tile: 'confidential', text: 'VERTRAULICH', fx: 0.28, fy: 0.68, h: 40 },
        { name: 'received', tone: 'ink', tile: 'received', text: 'ERHALTEN', fx: 0.72, fy: 0.68, h: 56 },
        { name: 'own Solar', tone: 'solar', own: 'Größe prüfen ÄÖÜ ß', fx: 0.28, fy: 0.88, h: 40 },
        { name: 'own Ink + date', tone: 'ink', own: 'Bezahlt äöü', date: true, fx: 0.72, fy: 0.88, h: 56 },
      ];
      const placed = [];
      for (const p of plan) {
        const before = await frameIds();
        await openPicker();
        await input.click({
          selector: '[data-surface="stamp-picker"] [role="radio"]',
          text: p.tone === 'solar' ? 'Gelb' : 'Schwarz',
        });
        await sleep(200);
        if (p.own !== undefined) {
          const box = await ev(
            `document.querySelector('[data-surface="stamp-picker"] input[type="checkbox"]')?.checked`,
          );
          if (box !== !!p.date)
            await input.click({ selector: '[data-surface="stamp-picker"] label', text: 'Heutiges Datum' });
          await sleep(200);
          // The field last: Enter in it chooses (Enter on the checkbox would not).
          await input.click({ selector: '[data-surface="stamp-picker"] input:not([type="checkbox"])' });
          await input.press('a', { ctrl: true });
          await input.insertText(p.own);
          await sleep(200);
          await input.press('Enter');
        } else {
          await input.click({ selector: `[data-stamp-tile="${p.tile}"]` });
        }
        await sleep(500);
        const g = await pageAt(1, p.fy);
        const cx = g.l + g.w * p.fx;
        const cy = g.t + g.h * p.fy;
        if (process.env.V19_DEBUG)
          console.log(
            'hit',
            await ev(
              `(() => { const e = document.elementFromPoint(${cx}, ${cy}); return e ? e.tagName + ' ' + (e.getAttribute('class') ?? '').slice(0, 60) + ' ' + Object.keys(e.dataset).join(',') + ' parent ' + e.parentElement?.tagName : null; })()`,
            ),
            await ev(`window.__TAURI_INTERNALS__ ? 1 : 0`),
          );
        await input.click({ x: cx, y: cy });
        await sleep(300);
        if (process.env.V19_DEBUG) {
          await sleep(1500);
          console.log(
            p.name,
            await ev(
              `JSON.stringify({ layers: document.querySelectorAll('[data-stamp-layer]').length, ghost: document.querySelector('[data-stamp-ghost]')?.textContent, frames: document.querySelectorAll('[data-annot-frame]').length, picker: !!document.querySelector('[data-surface="stamp-picker"]'), active: document.activeElement?.tagName })`,
            ),
          );
        }
        await input.waitFor(`document.querySelectorAll('[data-annot-frame]').length === ${before.length + 1}`, {
          timeoutMs: 8000,
          what: `stamp ${p.name} placed`,
        });
        await sleep(500);
        const ids = await frameIds();
        const id = ids.find((x) => !before.includes(x));
        const f = await frameOf(id);
        const g2 = await pageAt(1, p.fy);
        const k = g2.w / 612;
        const px = near((f.x + f.w / 2) * k, g2.w * p.fx, 4) && near((f.y + f.h / 2) * k, g2.h * p.fy, 4);
        C(
          `ST-AC 3: ${p.name}: placed by click, centred on the point, default height ${p.h}pt`,
          px && near(f.h, p.h, 1) && f.tone === p.tone && f.text.includes(p.text ?? p.own.slice(0, 5)),
          `centre ${((f.x + f.w / 2) * k).toFixed(0)},${((f.y + f.h / 2) * k).toFixed(0)} vs ${(g2.w * p.fx).toFixed(0)},${(g2.h * p.fy).toFixed(0)}; h ${f.h.toFixed(1)}; ${f.tone}; "${f.text}"`,
        );
        if (p.own !== undefined) {
          const dated = f.text.length > p.own.length;
          C(
            `ST-AC 4: ${p.name}: umlauts survive${p.date ? ', date second line' : ''}`,
            f.text.includes(p.own) && dated === !!p.date,
            f.text,
          );
        }
        placed.push({ ...p, id });
      }
      // Recent list
      await openPicker();
      const recent = await ev(`[...document.querySelectorAll('[data-stamp-recent]')].map((e) => e.textContent.trim())`);
      C(
        'ST-AC 4: own texts are listed under "Zuletzt", newest first',
        recent.length === 2 && recent[0] === 'Bezahlt äöü',
        JSON.stringify(recent),
      );
      await input.press('Escape');
      await sleep(400);
      await input.screenshot(`${SHOTS}/stamps-page`);

      // Drag placement on page 3 (ST-AC 3)
      await openPicker();
      await input.click({ selector: '[data-stamp-tile="draft"]' });
      await sleep(400);
      const g3 = await pageAt(3, 0.4);
      const before = await frameIds();
      await input.drag(
        { x: g3.l + g3.w * 0.15, y: g3.t + g3.h * 0.35 },
        { x: g3.l + g3.w * 0.65, y: g3.t + g3.h * 0.45 },
      );
      await input.waitFor(`document.querySelectorAll('[data-annot-frame]').length === ${before.length + 1}`, {
        timeoutMs: 8000,
        what: 'dragged stamp',
      });
      await sleep(500);
      let did = (await frameIds()).find((x) => !before.includes(x));
      // Replacing a stamp (Ändern…, Undo) may give it a new id: the lone stamp on page 3 is followed by position, not by id.
      const curId = () =>
        ev(
          `(() => { const e = [...document.querySelectorAll('[data-page="3"] [data-annot-frame], [data-annot-frame]')].find((f) => f.closest('[data-page]')?.dataset.page === '3'); return e ? Number(e.getAttribute('data-annot-frame')) : null; })()`,
        );
      const f3 = async () => {
        did = (await curId()) ?? did;
        return frameOf(did, 3);
      };
      const df = await frameOf(did, 3);
      const aspect = df.w / df.h;
      const def = placed[0];
      const defAspect = (placed[0] && (await frameOf(def.id)))?.w / 40;
      C(
        'ST-AC 3: a drag sizes the stamp with its aspect kept',
        near(aspect, defAspect, 0.08) && df.h > 40,
        `aspect ${aspect.toFixed(2)} vs ${defAspect.toFixed(2)}, h ${df.h.toFixed(1)}`,
      );

      // Mini bar (ST-AC 5) on the dragged stamp, each change one undo step
      const hasBar = await exists('[data-minibar]');
      C('ST-AC 5: the new stamp is selected with the mini bar', hasBar, '');
      const toneOf = async () => (await f3()).tone;
      const t0 = await toneOf();
      await input.click({ selector: '[data-minibar] [role="radio"]', text: t0 === 'solar' ? 'Schwarz' : 'Gelb' });
      await sleep(700);
      const t1 = await toneOf();
      await undo();
      C(
        'ST-AC 5: colour switch changes the tone, one Undo step restores it',
        t1 !== t0 && (await toneOf()) === t0,
        `${t0} -> ${t1} -> ${await toneOf()}`,
      );
      const wasText = (await f3()).text;
      const c0 = await f3();
      await input.click({ selector: '[data-minibar] button', text: 'Ändern…' });
      await input.waitFor(`!!document.querySelector('[data-surface="stamp-picker"]')`, {
        timeoutMs: 4000,
        what: 'change picker',
      });
      await sleep(300);
      await input.click({ selector: '[data-stamp-tile="confidential"]' });
      await sleep(800);
      const c1 = await f3();
      C(
        'ST-AC 5: Ändern… replaces the text keeping centre and height',
        c1.text.includes('VERTRAULICH') &&
          near(c1.h, c0.h, 1) &&
          near(c1.x + c1.w / 2, c0.x + c0.w / 2, 2) &&
          near(c1.y + c1.h / 2, c0.y + c0.h / 2, 2),
        `"${wasText}" -> "${c1.text}"`,
      );
      await undo();
      C('ST-AC 5: Undo restores the previous text', (await f3()).text === wasText, (await f3()).text);
      const selectIt = async () => {
        await f3();
        await input.click({ selector: `[data-annot-hit="${did}"]` });
        await sleep(500);
      };
      // corner drag resizes proportionally
      await selectIt();
      const r0 = await f3();
      const se = await input.rectOf({ selector: `[data-annot-frame="${did}"] [data-annot-handle="se"]` });
      await input.drag(
        { x: se.left + se.width / 2, y: se.top + se.height / 2 },
        { x: se.left + se.width / 2 + 40, y: se.top + se.height / 2 + 40 },
      );
      await sleep(700);
      const r1 = await f3();
      C(
        'ST-AC 5: a corner drag resizes proportionally',
        near(r1.w / r1.h, r0.w / r0.h, 0.05) && (r1.w > r0.w + 3 || r1.w < r0.w - 3),
        `${r0.w.toFixed(0)}x${r0.h.toFixed(0)} -> ${r1.w.toFixed(0)}x${r1.h.toFixed(0)}`,
      );
      await undo();
      const r2 = await f3();
      C(
        'ST-AC 5: Undo restores the size (one step)',
        near(r2.w, r0.w, 1) && near(r2.h, r0.h, 1),
        `${r2.w.toFixed(0)}x${r2.h.toFixed(0)}`,
      );
      // move by body drag
      await selectIt();
      const body = await input.rectOf({ selector: `[data-annot-hit="${did}"]` });
      await input.drag(
        { x: body.left + body.width / 2, y: body.top + body.height / 2 },
        { x: body.left + body.width / 2 + 50, y: body.top + body.height / 2 + 30 },
      );
      await sleep(700);
      const m1 = await f3();
      C(
        'stamps: a body drag moves the stamp',
        near(m1.x - r2.x, 37.5, 6) && near(m1.y - r2.y, 22.5, 6),
        `dx ${(m1.x - r2.x).toFixed(1)} dy ${(m1.y - r2.y).toFixed(1)}`,
      );
      await undo();
      // delete via the mini bar, then undo
      await selectIt();
      const n0 = (await frameIds()).length;
      await input.click({ selector: '[data-minibar] button', text: 'Löschen' });
      await sleep(800);
      const n1 = (await frameIds()).length;
      await undo();
      const n2 = (await frameIds()).length;
      C(
        'ST-AC 5: Löschen deletes the stamp, Undo brings it back',
        n1 === n0 - 1 && n2 === n0,
        `${n0} -> ${n1} -> ${n2}`,
      );

      // Save, close, reopen
      await saveDoc();
      await closeDoc();
      await open(WORK('stamps.pdf'));
      await sleep(1500);
      await openComments();
      // The comments list is virtualized: scroll it from top to bottom and collect the cards by key.
      const seen = new Map();
      const collect = async () => {
        const got = await ev(
          `[...document.querySelectorAll('article[data-key]')].map((e) => [e.getAttribute('data-key'), e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)])`,
        );
        for (const [k, v] of got) seen.set(k, v);
      };
      const scrollList = (to) =>
        ev(`(() => { let e = document.querySelector('article[data-key]'); while (e && e.scrollHeight <= e.clientHeight + 1) e = e.parentElement;
          if (!e) return false; e.scrollTop = ${to}; return e.scrollHeight; })()`);
      await scrollList(0);
      await sleep(400);
      await collect();
      for (let top = 200; top < 4000; top += 200) {
        if (!(await scrollList(top))) break;
        await sleep(250);
        await collect();
      }
      await scrollList(0);
      const cards = [...seen.values()];
      C(
        'ST-AC: reopened file lists the 7 stamps in the comments panel (excerpt = text)',
        cards.length === 7 &&
          cards.some((c) => c.includes('ENTWURF')) &&
          cards.some((c) => c.includes('Bezahlt äöü')) &&
          cards.some((c) => c.includes('Größe prüfen ÄÖÜ ß')),
        JSON.stringify(cards),
      );
      // rendered: non-blank pixels of the PDFium page image inside each stamp rect (vector overlay hidden meanwhile)
      const inks = [];
      for (const pg of [1, 3]) {
        await pageAt(pg, 0.5);
        const ids = await ev(
          `[...document.querySelectorAll('[data-annot-frame]')].filter((f) => f.closest('[data-page]')?.dataset.page === '${pg}').map((f) => Number(f.getAttribute('data-annot-frame')))`,
        );
        for (const id of ids) {
          const fr0 = await frameOf(id, pg);
          await pageAt(pg, (fr0.y + fr0.h / 2) / 792);
          const fr = await frameOf(id, pg);
          inks.push(await inkIn(fr.px));
        }
      }
      C(
        'ST-AC 6: after reopen all 7 stamp rects are non-blank in the rendered page image',
        inks.length === 7 && inks.every((n) => n >= 150),
        `ink px ${inks.join(',')}`,
      );
      await pageAt(1, 0.68);
      await input.screenshot(`${SHOTS}/stamps-reopened`);
    });
  }

  // ---- shared by hf / export / cite ---------------------------------------------------------------------------------------
  const NONE = (w) => `Keine Treffer für „${w}“`;
  /** Ctrl+F, replace the query, wait for hit rows or the "no hits" message; true when there are hits. */
  async function find(word) {
    if (!(await exists('[role="searchbox"]'))) {
      await input.press('f', { ctrl: true });
      await input.waitFor(`!!document.querySelector('[role="searchbox"]')`, { timeoutMs: 5000, what: 'search field' });
    }
    await input.click({ selector: '[role="searchbox"]' });
    await input.press('a', { ctrl: true });
    await input.press('Backspace');
    await input
      .waitFor(`!document.querySelector('[data-search-list] [data-hit]')`, { timeoutMs: 4000, what: 'cleared hits' })
      .catch(() => {});
    await input.insertText(word);
    await sleep(350);
    const none = `document.body.textContent.includes(${q(NONE(word))})`;
    const r = await input
      .waitFor(`(${none}) ? 'none' : (document.querySelector('[data-search-list] [data-hit]') ? 'hit' : '')`, {
        timeoutMs: 6000,
        intervalMs: 150,
        what: `search ${word}`,
      })
      .catch(() => 'timeout');
    return r === 'hit';
  }
  /** The pages (sorted, with repeats) of the hit rows of a query; [] when there is none. */
  async function hitPages(word) {
    if (!(await find(word))) return [];
    await sleep(500);
    const pages = await ev(
      `[...document.querySelectorAll('[data-search-list] [data-hit]')].map((e) => /^Seite ([0-9]+)(?:,|$)/.exec(e.getAttribute('aria-label') ?? '')?.[1]).filter(Boolean).map(Number)`,
    );
    return pages.sort((a, b) => a - b);
  }
  const resize = (w, h) =>
    s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  /** Selects the text run that contains `needle` (the selection bar then settles in 300 ms). */
  async function selectText(needle) {
    await input.waitFor(`!!document.querySelector('[data-text-page] [data-run-start]')`, {
      timeoutMs: 15000,
      what: 'text layer',
    });
    const ok = await ev(`(() => {
      const run = [...document.querySelectorAll('[data-text-page] [data-run-start]')].find((e) => e.textContent.includes(${q(needle)}) && e.firstChild);
      if (!run) return false;
      run.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(run.firstChild);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return true; })()`);
    if (!ok) throw new Error(`no text run contains "${needle}"`);
    await sleep(700);
  }
  const barButton = (text) => input.click({ selector: '[role="toolbar"] button', text });
  const waitFile = async (path, what) => {
    for (let i = 0; i < 100 && !existsSync(path); i++) await sleep(200);
    if (!existsSync(path)) throw new Error(`${what}: file was not written`);
    await sleep(500);
  };
  // rc.3: the HF and cite panels are the inspector column (inside the window, not covering the canvas), the export dialog stays a dialog.
  const dialogFits = () =>
    ev(`(() => { const f = document.querySelector('[data-slot="inspector"][data-open]') ?? document.querySelector('[role="dialog"]'); if (!f) return null; const r = f.getBoundingClientRect(); const c = document.querySelector('[data-action-scope="canvas"]')?.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth && (!c || f.matches('[role="dialog"]') || r.left >= c.right - 1); })()`);
  // ---- hf (HF-AC) ---------------------------------------------------------------------------------------------------------
  if (PHASES.includes('hf')) {
    await section('hf', async () => {
      const TOTAL = 3;
      const DATE = new Intl.DateTimeFormat('de', { dateStyle: 'medium' }).format(new Date());
      const CENTRE = 'Kopfzeile QX';
      const openHf = async () => {
        await menu(T.tools, T.hf);
        await input.waitFor(`!!document.querySelector('[data-surface="hf-dialog"]')`, {
          timeoutMs: 6000,
          what: 'header/footer dialog',
        });
        await sleep(600);
      };
      const apply = async () => {
        await input.click({ selector: '[data-inspector="apply"]' });
        await input.waitFor(`!document.querySelector('[data-surface="hf-dialog"]')`, {
          timeoutMs: 15000,
          what: 'dialog closed after Apply',
        });
        await sleep(1200);
      };
      const overlayOn = async (n) => {
        const g = await pageAt(n, 0.5);
        await sleep(400);
        return ev(`(() => [...document.querySelectorAll('[data-hf-overlay]')].filter((o) => {
          const r = o.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
          return cx >= ${g.l} && cx <= ${g.l + g.w} && cy >= ${g.t} && cy <= ${g.t + g.h}; }).map((o) => o.textContent))()`);
      };
      const reopen = async () => {
        await saveDoc();
        await closeDoc();
        await open(WORK('hf.pdf'));
        await sleep(1200);
      };
      const footerHits = async () => ({
        page: (await hitPages(`von ${TOTAL}`)).join(','),
        date: (await hitPages(DATE)).join(','),
      });
      const ONCE = Array.from({ length: TOTAL }, (_, i) => i + 1).join(',');

      await fresh('de');
      await open(WORK('hf.pdf'));

      // HF-AC 1 (rc.3): Kopf-/Fußzeile is a tool item of Bearbeiten (no longer the last slot of a row of actions); it opens the
      // inspector. The Werkzeuge menu still holds the command (openHf below).
      try {
        await input.click({ role: 'tab', text: T.edit });
        await sleep(700);
        const items = await ev(
          `[...document.querySelectorAll('[data-slot="tool-row"] [data-toolbar-item]')].map((e) => ({ id: e.getAttribute('data-toolbar-item'), label: ((e.getAttribute('aria-label') ?? '') + ' ' + e.textContent).trim() }))`,
        );
        const hfItem = items.find((i) => i.id === 'headerFooter');
        C(
          'HF-AC 1 (rc.3): Bearbeiten has the tool item "Kopf- und Fußzeile"',
          hfItem !== undefined && hfItem.label.includes('Kopf- und Fußzeile'),
          `${items.length} items, ids ${items.map((i) => i.id).join(',')}`,
        );
        await input.click({ selector: '[data-slot="tool-row"] [data-toolbar-item="headerFooter"]' });
        await input
          .waitFor(`!!document.querySelector('${INSPECTOR} [data-surface="hf-dialog"]')`, {
            timeoutMs: 6000,
            what: 'hf inspector',
          })
          .catch(() => {});
        C(
          'HF-AC 1 (rc.3): the tool item opens the header/footer panel in the inspector',
          await exists(`${INSPECTOR} [data-surface="hf-dialog"]`),
          '',
        );
        await input.click({ selector: '[data-inspector="close"]' }).catch(() => {});
        await sleep(500);
        await input.click({ role: 'tab', text: 'Lesen' });
        await sleep(500);
      } catch (e) {
        C('HF-AC 1 (rc.3): Bearbeiten has the tool item "Kopf- und Fußzeile"', false, e.message);
      }

      await openHf();
      const slotText = (slot) => ev(`document.querySelector('[data-hf-slot="${slot}"]')?.textContent.trim() ?? null`);
      const defaults = [await slotText('footerRight'), await slotText('footerLeft'), await slotText('headerCenter')];
      C(
        'HF-AC 2: defaults are Seitenzahl bottom right and Datum bottom left',
        defaults[0] === 'Seitenzahl' && defaults[1] === 'Datum' && defaults[2] === 'Keine',
        JSON.stringify(defaults),
      );
      C(
        'HF-AC 6: a file without headers shows no "existing" hint and no Entfernen',
        !(await exists('[data-hf="existing"]')) && !(await exists('[data-hf="remove"]')),
        '',
      );
      await input.screenshot(`${SHOTS}/hf-dialog-1280`);
      await resize(960, 640);
      await sleep(700);
      C('HF-AC 2: the dialog fits 960 x 640', (await dialogFits()) === true, '');
      await input.screenshot(`${SHOTS}/hf-dialog-960`);
      await resize(1280, 800);
      await sleep(500);
      await apply();

      for (let n = 1; n <= TOTAL; n++) {
        const texts = await overlayOn(n);
        C(
          `HF-AC 3: before saving, page ${n} shows the staged overlay (Seite ${n} von ${TOTAL} + date)`,
          texts.some((x) => x.includes(`Seite ${n} von ${TOTAL}`) && x.includes(DATE)),
          JSON.stringify(texts),
        );
      }
      await input.screenshot(`${SHOTS}/hf-overlay`);

      await reopen();
      let h = await footerHits();
      C('HF-AC 7: reopened, the page-number footer is found once on each page', h.page === ONCE, `pages ${h.page}`);
      C('HF-AC 7: reopened, the date is found once on each page', h.date === ONCE, `pages ${h.date}`);
      await input.press('Escape');

      // HF-AC 6: re-apply with a centre header text replaces, never duplicates
      await openHf();
      C(
        'HF-AC 6: reopening shows the "existing" hint and Entfernen',
        (await exists('[data-hf="existing"]')) && (await exists('[data-hf="remove"]')),
        '',
      );
      const kept = [await slotText('footerRight'), await slotText('footerLeft')];
      C(
        'HF-AC 6: the saved settings are loaded',
        kept[0] === 'Seitenzahl' && kept[1] === 'Datum',
        JSON.stringify(kept),
      );
      await input.click({ selector: '[data-hf-slot="headerCenter"]' });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'kind menu' });
      await sleep(250);
      // Menus anchored inside a modal render at --z-modal-popover (FX-Z), so a real click reaches the items.
      const textItem = `[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find((e) => e.textContent === 'Text')`;
      const reachable = await ev(
        `(() => { const i = ${textItem}; const r = i.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === i || i.contains(h); })()`,
      );
      C('HF-AC 2: the slot menu inside the dialog is clickable (menu above the modal)', reachable, '');
      await input.click({ selector: '[role="menu"] [data-id="text"]' });
      await sleep(400);
      await input.click({ selector: '[data-hf="text"]' });
      await input.insertText(CENTRE);
      await sleep(500);
      await input.screenshot(`${SHOTS}/hf-dialog-text`);
      await apply();
      await reopen();
      h = await footerHits();
      const centre = (await hitPages(CENTRE)).join(',');
      C('HF-AC 6: after re-apply the page number is still exactly once per page', h.page === ONCE, `pages ${h.page}`);
      C('HF-AC 6: after re-apply the date is still exactly once per page', h.date === ONCE, `pages ${h.date}`);
      C('HF-AC 6: the centre header text is exactly once per page', centre === ONCE, `pages ${centre}`);
      await input.press('Escape');

      // Remove, one step; gone after save
      await openHf();
      await input.click({ selector: '[data-hf="remove"]' });
      await input.waitFor(`!document.querySelector('[data-surface="hf-dialog"]')`, {
        timeoutMs: 15000,
        what: 'dialog closed after Entfernen',
      });
      await sleep(1000);
      await reopen();
      h = await footerHits();
      const centreGone = (await hitPages(CENTRE)).join(',');
      C(
        'HF-AC 6: after Entfernen and save, page number, date and header text are gone',
        h.page === '' && h.date === '' && centreGone === '',
        `page "${h.page}", date "${h.date}", header "${centreGone}"`,
      );
      await input.press('Escape');
      await closeDoc();
    });
  }

  // ---- export (CE-AC) -----------------------------------------------------------------------------------------------------
  if (PHASES.includes('export')) {
    await section('export', async () => {
      const MD = join(OUT, `export-comments-${RUN}.md`);
      const PDF = join(OUT, `export-comments-${RUN}.pdf`);
      const NOTE = 'Notiz mit *Stern* und #Hash';
      await fresh('de');
      await open(WORK('comments.pdf'));
      await openComments();
      const exportDisabled = () =>
        ev(
          `(() => { const b = document.querySelector('[data-comments="export"]'); return !b || b.disabled || b.getAttribute('aria-disabled') === 'true'; })()`,
        );
      C('CE-AC 1: without annotations the Comments Export button is disabled', await exportDisabled(), '');

      // highlight
      await selectText('quick');
      await barButton('Markieren');
      await input.waitFor(`document.querySelectorAll('article[data-key]').length === 1`, {
        timeoutMs: 8000,
        what: 'highlight card',
      });
      // note with a reply
      await selectText('Repeat');
      await barButton('Kommentieren');
      await input.waitFor(`!!document.querySelector('textarea[aria-label="Notiztext"]')`, {
        timeoutMs: 8000,
        what: 'note body field',
      });
      await input.click({ selector: 'textarea[aria-label="Notiztext"]' });
      await input.insertText(NOTE);
      await input.press('Enter');
      await input.waitFor(`!document.querySelector('textarea[aria-label="Notiztext"]')`, {
        timeoutMs: 8000,
        what: 'note committed',
      });
      await sleep(500);
      await input.waitFor(`!!document.querySelector('textarea[aria-label="Antwort schreiben"]')`, {
        timeoutMs: 8000,
        what: 'reply field',
      });
      await input.click({ selector: 'textarea[aria-label="Antwort schreiben"]' });
      await input.insertText('Erste Zeile');
      await input.insertText('\n');
      await input.insertText('- Zweite Zeile');
      await input.press('Enter');
      await sleep(1200);
      // citation
      await selectText('ends here');
      await barButton('Zitieren');
      await input.waitFor(`document.querySelectorAll('article[data-key]').length === 3`, {
        timeoutMs: 8000,
        what: 'three cards',
      });
      await sleep(600);
      C('CE-AC 1: with annotations the Export button is enabled', !(await exportDisabled()), '');

      // dialog from the panel button
      await input.click({ selector: '[data-comments="export"]' });
      await input.waitFor(`!!document.querySelector('[data-surface="comment-export"]')`, {
        timeoutMs: 6000,
        what: 'export dialog',
      });
      await sleep(600);
      const countText = await ev(`document.querySelector('[data-export="count"]')?.textContent.trim() ?? ''`);
      C('CE-AC 3: the count reads 3 Einträge', /^3 Einträge/.test(countText), countText);
      await input.screenshot(`${SHOTS}/export-dialog-1280`);
      await resize(960, 640);
      await sleep(700);
      C('CE-AC 12: the dialog fits 960 x 640', (await dialogFits()) === true, '');
      await input.screenshot(`${SHOTS}/export-dialog-960`);
      await resize(1280, 800);
      await sleep(500);
      await input.click({ selector: '[data-surface="comment-export"] [role="radio"]', text: 'Markdown' });
      await sleep(300);
      await dialogs.answerSave(MD);
      await input.click({ selector: '[data-export="start"]' });
      await waitFile(MD, 'Markdown export');
      await input.waitFor(`!document.querySelector('[data-surface="comment-export"]')`, {
        timeoutMs: 10000,
        what: 'dialog closed after export',
      });
      const md = readFileSync(MD, 'utf8');
      C(
        'CE-AC 6: Markdown has the title head and LF endings',
        /^# Kommentare: /m.test(md) && !md.includes('\r'),
        md.split('\n')[0],
      );
      C('CE-AC 5/6: a "## Seite 1" heading', /^## Seite 1\b/m.test(md), '');
      C('CE-AC 6: the marked text is quoted ("> ...quick")', /^> .*quick/m.test(md), '');
      C(
        'CE-AC 6: the note text is escaped (\\* and \\#)',
        md.includes('\\*Stern\\*') && md.includes('\\#Hash'),
        md.split('\n').find((l) => l.includes('Stern')) ?? '',
      );
      C(
        'CE-AC 6: the reply is a bullet with the author, the second line indented and its "- " escaped',
        /^- \*\*.+\*\* · .*Erste Zeile/m.test(md) && /^ {2,}\\- Zweite Zeile/m.test(md),
        md
          .split('\n')
          .filter((l) => /Zeile/.test(l))
          .join(' | '),
      );
      C('CE-AC 5: the citation appears as a quote block', /^> .*ends here/m.test(md), '');
      console.log(`export markdown: ${MD}`);

      // PDF from the Datei menu
      await menu(T.file, T.exportComments);
      await input.waitFor(`!!document.querySelector('[data-surface="comment-export"]')`, {
        timeoutMs: 6000,
        what: 'export dialog (Datei)',
      });
      await sleep(500);
      const remembered = await ev(
        `[...document.querySelectorAll('[data-surface="comment-export"] [role="radio"]')].filter((e) => /Markdown|PDF/.test(e.textContent)).map((e) => e.textContent.trim() + '=' + e.getAttribute('aria-checked')).join(' ')`,
      );
      C(
        'CE-AC 11: the dialog remembers the last format (Markdown)',
        /Markdown=true/.test(remembered) && !/PDF[^=]*=true/.test(remembered),
        remembered,
      );
      await input.click({ selector: '[data-surface="comment-export"] [role="radio"]', text: 'PDF-Zusammenfassung' });
      await sleep(300);
      await dialogs.answerSave(PDF);
      await input.click({ selector: '[data-export="start"]' });
      await waitFile(PDF, 'PDF export');
      await input.waitFor(`!document.querySelector('[data-surface="comment-export"]')`, {
        timeoutMs: 10000,
        what: 'dialog closed after PDF export',
      });
      const head = readFileSync(PDF).subarray(0, 5).toString('latin1');
      C(
        'CE-AC 5: the exported PDF is a PDF',
        head === '%PDF-' && statSync(PDF).size > 1000,
        `${statSync(PDF).size} bytes`,
      );

      // the exported PDF opens in the app and its text is searchable
      await open(PDF);
      await sleep(1000);
      const found = await find('quick');
      C('CE-AC 5: the exported PDF opens and its quoted word "quick" is searchable', found, '');
      await input.press('Escape');
      await input.screenshot(`${SHOTS}/export-pdf-opened`);
    });
  }

  // ---- cite (DZ-AC) -------------------------------------------------------------------------------------------------------
  if (PHASES.includes('cite')) {
    await section('cite', async () => {
      const SRC = [
        {
          file: 'cites.pdf',
          title: 'Digitale Lesekultur. Eine Einführung',
          family: 'Müller',
          given: 'Hans',
          year: '2021',
          place: 'Berlin',
          publisher: 'Beispielverlag',
        },
        {
          file: 'cites2.pdf',
          title: 'Papier und Bildschirm: Ein Vergleich',
          family: 'Abel',
          given: 'Eva',
          year: '2019',
          place: 'Leipzig',
          publisher: 'Andere Presse',
        },
      ];
      const setReference = async (src) => {
        // rc.3: Quellenangabe is the reference inspector (DESIGN 3.18 E5), no longer a tab of Dokumenteigenschaften. It opens from
        // the reference popover of the Kommentare panel ("Quellenangabe bearbeiten…").
        await openComments();
        await input.click({ selector: 'button[aria-label="Quellenangabe und Zitatliste"]' });
        await sleep(700);
        await input.click({
          selector: '[role="dialog"] button, [data-surface] button, button',
          text: 'Quellenangabe bearbeiten…',
        });
        await input.waitFor(`!!document.querySelector('${INSPECTOR} [data-surface="reference"] input[id$="-title"]')`, {
          timeoutMs: 8000,
          what: 'reference inspector',
        });
        await sleep(600);
        const D = `${INSPECTOR} [data-surface="reference"]`;
        const fill = async (sel, value) => {
          if (!(await exists(sel))) return false;
          await input.click({ selector: sel });
          await input.press('a', { ctrl: true });
          await input.insertText(value);
          return true;
        };
        // Publisher and place exist only for some types: choose "book" first (a native select, set the React-compatible way).
        await ev(`(() => { const s = document.querySelector('${D} select[id$="-kind"]'); if (!s) return;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'book');
          s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await sleep(500);
        const filled = {};
        filled.title = await fill(`${D} input[id$="-title"]`, src.title);
        filled.year = await fill(`${D} input[id$="-year"]`, src.year);
        filled.publisher = await fill(`${D} input[id$="-publisher"]`, src.publisher);
        filled.place = await fill(`${D} input[id$="-place"]`, src.place);
        if (!(await exists(`${D} [data-part="family"]`))) {
          await input.click({ selector: `${D} button`, text: 'Person hinzufügen' });
          await sleep(400);
        }
        filled.family = await fill(`${D} [data-part="family"]`, src.family);
        filled.given = await fill(`${D} [data-part="given"]`, src.given);
        await sleep(300);
        await input.click({ selector: '[data-inspector="apply"]' });
        await input.waitFor(`!document.querySelector('${D}')`, {
          timeoutMs: 8000,
          what: 'reference inspector closed',
        });
        await sleep(800);
        C(
          `DZ-AC: reference fields of ${src.file} could be filled`,
          Object.values(filled).every(Boolean),
          JSON.stringify(filled),
        );
      };
      const cite = async (needle) => {
        const n = await count('article[data-key]');
        await selectText(needle);
        await barButton('Zitieren');
        await input.waitFor(`document.querySelectorAll('article[data-key]').length === ${n + 1}`, {
          timeoutMs: 8000,
          what: `citation "${needle}"`,
        });
        await sleep(500);
      };
      const exportList = async (outPath) => {
        await input.click({ selector: 'button[aria-label="Quellenangabe und Zitatliste"]' });
        await sleep(700);
        // the file format: Markdown
        if (!(await exists('button[aria-label="Markdown"]'))) {
          await input.click({ selector: 'button[aria-label="Text"]' });
          await sleep(400);
          await input.click({ selector: '[role="menu"] [role^="menuitem"]', text: 'Markdown' });
          await sleep(400);
        }
        await dialogs.answerSave(outPath);
        await input.click({ selector: 'button', text: 'Liste speichern…' });
        await waitFile(outPath, 'citation list');
        await input.press('Escape');
        await sleep(400);
        return readFileSync(outPath, 'utf8');
      };

      await fresh('de');
      await open(WORK('cites.pdf'));
      await setReference(SRC[0]);
      await openComments();
      // style picker: five items, the fifth is Deutsche Zitierweise (DZ-AC 1)
      await input.click({ selector: 'button[aria-label="Quellenangabe und Zitatliste"]' });
      await sleep(700);
      await input.click({ selector: 'button', text: 'APA 7' });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'style menu' });
      await sleep(400);
      const styles = await ev(
        `[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((e) => e.textContent.trim())`,
      );
      C(
        'DZ-AC 1: the style list has five items, the fifth is Deutsche Zitierweise',
        styles.length === 5 && styles[4].startsWith('Deutsche Zitierweise'),
        JSON.stringify(styles),
      );
      await input.screenshot(`${SHOTS}/cite-style-picker`);
      await input.click({ selector: '[role="menu"] [role^="menuitem"]', text: 'Deutsche Zitierweise' });
      await sleep(600);
      const hint = await ev(`document.body.textContent.includes('Erste Fußnote mit Vollbeleg, danach Kurzbeleg.')`);
      const stored = await ev(`localStorage.getItem('sheer.citations.style')`);
      C(
        'DZ-AC 1: the hint caption shows and the choice is stored',
        hint && stored === 'germanNotes',
        `stored ${stored}`,
      );
      const previewText = await ev(
        `[...document.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent).join(' ')`,
      );
      C(
        'DZ-AC 2: the preview shows the bibliography entry',
        previewText.includes('Müller, Hans: Digitale Lesekultur'),
        previewText.slice(0, 160),
      );
      await input.screenshot(`${SHOTS}/cite-style-german`);
      await input.press('Escape');
      await sleep(400);

      // the same source twice
      await cite('quick');
      await cite('ends here');
      const cards = await ev(
        `[...document.querySelectorAll('article[data-key]')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`,
      );
      C(
        'DZ-AC 3: the cards show the short note without parentheses',
        /Müller, Digitale Lesekultur, S\. \d+/.test(cards) && !/\(Müller/.test(cards),
        cards.slice(0, 200),
      );
      const listA = join(OUT, `cites-list-a-${RUN}.md`);
      const mdA = await exportList(listA);
      // Markdown-unescape: emphasis marks (the italic title) and backslash escapes are dropped before comparing.
      const unmd = (t) => t.replace(/\\(.)/g, '$1').replace(/\*/g, '');
      const notes = [...mdA.matchAll(/^\[\^(\d+)\]: (.+)$/gm)].map((m) => ({ n: Number(m[1]), text: unmd(m[2]) }));
      C(
        'DZ-AC 5: two footnotes exist, numbered 1 and 2',
        notes.length === 2 && notes[0].n === 1 && notes[1].n === 2,
        JSON.stringify(notes),
      );
      C(
        'DZ-AC 5: note 1 is the full reference',
        notes[0]?.text === 'Müller, Hans: Digitale Lesekultur. Eine Einführung. Berlin: Beispielverlag, 2021, S. 1.',
        notes[0]?.text ?? '',
      );
      C(
        'DZ-AC 5: note 2 (the repeat) is the short reference',
        /^Müller, Digitale Lesekultur, S\. /.test(notes[1]?.text ?? '') &&
          !(notes[1]?.text ?? '').includes('Beispielverlag'),
        notes[1]?.text ?? '',
      );
      const iNotes = mdA.search(/^## Fußnoten/m);
      const iBib = mdA.search(/^## Literaturverzeichnis/m);
      C(
        'DZ-AC 5: the notes heading comes before the bibliography heading',
        iNotes >= 0 && iBib > iNotes,
        `${iNotes} < ${iBib}`,
      );
      const bib =
        iBib >= 0
          ? mdA
              .slice(iBib)
              .split('\n')
              .slice(1)
              .filter((l) => l.trim() !== '')
          : [];
      const sorted = [...bib].sort((a, b) => a.localeCompare(b, 'de'));
      C(
        'DZ-AC 5: the bibliography has the entry and is sorted',
        bib.length >= 1 && bib.join('\n') === sorted.join('\n') && bib[0].includes('Müller'),
        JSON.stringify(bib),
      );
      await saveDoc();
      await closeDoc();

      // a second source, cited once (one reference per document: its own list)
      await open(WORK('cites2.pdf'));
      await setReference(SRC[1]);
      await openComments();
      await cite('quick');
      const listB = join(OUT, `cites-list-b-${RUN}.md`);
      const mdB = await exportList(listB);
      const notesB = [...mdB.matchAll(/^\[\^(\d+)\]: (.+)$/gm)].map((m) => unmd(m[2]));
      C(
        'DZ-AC 5: the second source has one full note and its own bibliography entry',
        notesB.length === 1 &&
          notesB[0].includes('Abel, Eva: Papier und Bildschirm') &&
          /^## Literaturverzeichnis/m.test(mdB),
        JSON.stringify(notesB),
      );
      console.log(`citation lists: ${listA}, ${listB}`);
      await saveDoc();
      await closeDoc();
    });
  }

  const err = await dialogs.lastError();
  if (err) C('no automation error', false, JSON.stringify(err));
};

const code = await runSession(session, results);
results.table();
process.exit(code || results.failed() ? 1 : 0);
