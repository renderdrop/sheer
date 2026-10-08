// Acceptance v2.0 performance budget (ADR-140 section 3), measured in the acceptance build (release profile) on generated documents only:
//   open     500-page text PDF -> first rendered page image < 1 s
//   frames   scroll through 100 pages, zoom in/out/fit, panel switches (thumbnails, outline, comments, search): p95 <= 20 ms, avg >= 58 fps
//   ocr      generated 10-page image-only PDF, recognition <= 2 s per page on average
//   textedit keystroke -> line preview p95 <= 150 ms, Apply (Enter) <= 500 ms
// Prereq: npm run build:acceptance; npm run fixtures:scans (for the OCR document). Run: node scripts/ui/accept/v20-perf.mjs
// Phases: V20_PERF_PHASES=open,frames,ocr,textedit (default all). German UI. Output: table + review/perf-v20.json. Exit 1 on a miss.
// Frame times are requestAnimationFrame deltas collected in the page while the node side drives the UI (same method as `cdp.mjs fps`).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createResults, runSession, sleep, SCROLLER } from './harness.mjs';
import {
  BUDGET,
  buildImageOnlyPdf,
  extractImageStreams,
  formatPerfTable,
  frameStats,
  judgeFrames,
  quantile,
} from './v20-pure.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/generated/perf');
const JSON_OUT = resolve(ROOT, 'review/perf-v20.json');
const SCANS = resolve(ROOT, 'review/generated/scans');
const PHASES = (process.env.V20_PERF_PHASES ?? 'open,frames,ocr,textedit').split(',');
const q = (s) => JSON.stringify(s);
const RUN = Date.now().toString(36);

mkdirSync(OUT, { recursive: true });

// ---- documents (generated, rule 13) -------------------------------------------------------------------------------------------
const TEXT500 = join(OUT, `text-500-${RUN}.pdf`);
execFileSync(process.execPath, [resolve(ROOT, 'scripts/ui/gen-pdf.mjs'), TEXT500, '500'], { stdio: 'inherit' });
const EDIT_PDF = join(OUT, `edit-${RUN}.pdf`);
copyFileSync(resolve(ROOT, 'tests/fixtures/text.pdf'), EDIT_PDF);
let OCR_PDF = null;
if (PHASES.includes('ocr')) {
  const src = join(SCANS, 's2-multi-en.pdf');
  if (existsSync(src)) {
    OCR_PDF = join(OUT, `scan-10-${RUN}.pdf`);
    writeFileSync(OCR_PDF, buildImageOnlyPdf(extractImageStreams(readFileSync(src)), 10));
  } else console.log('ocr: skipped, review/generated/scans/s2-multi-en.pdf is missing (run: npm run fixtures:scans)');
}

const results = createResults();
const { check: C } = results;
/** Rows of the printed table and the JSON. */
const rows = [];
const report = { run: new Date().toISOString(), budget: BUDGET, measurements: {} };
const ms = (n) => `${n.toFixed(0)} ms`;
function frameRow(name, deltas) {
  const s = frameStats(deltas);
  const j = judgeFrames(s);
  report.measurements[name] = { ...s, ok: j.ok };
  rows.push({
    name,
    value: `p95 ${s.p95.toFixed(1)} ms, avg ${s.avgFps.toFixed(1)} fps (${s.frames} frames)`,
    budget: `p95 <= ${BUDGET.frameP95Ms} ms, avg >= ${BUDGET.frameAvgFps} fps`,
    ok: j.ok,
    why: j.why,
  });
  C(`frames: ${name}`, j.ok, j.why || `p95 ${s.p95.toFixed(1)} ms, ${s.avgFps.toFixed(1)} fps`);
}

const session = async (ctx) => {
  const { input, dialogs, ev } = ctx;
  const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);
  async function fresh() {
    const patch = {
      language: 'de',
      welcomeTour: 'shown',
      authorPrompt: 'done',
      pageSidebarCollapsed: false,
      tipsEnabled: false,
    };
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(patch)} }).then(() => 'ok', (e) => 'ERR ' + JSON.stringify(e))`,
    );
    if (r !== 'ok') throw new Error(`update_settings failed: ${r}`);
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === 'de'`, { timeoutMs: 20000, what: 'UI language' });
  }
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      C(`${name}: ran to the end`, false, e.message);
      rows.push({ name, value: 'error', budget: '-', ok: false, why: e.message });
      await input.press('Escape').catch(() => {});
    }
  };

  // ---- in-page frame collector ------------------------------------------------------------------------------------------------
  const startFrames = () =>
    ev(`(() => {
      const f = (window.__frames = { t: [], last: performance.now(), on: true });
      const tick = (now) => { f.t.push(now - f.last); f.last = now; if (f.on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return true;
    })()`);
  const stopFrames = () =>
    ev(
      `(async () => { window.__frames.on = false; await new Promise((r) => requestAnimationFrame(r)); return window.__frames.t.slice(1); })()`,
    );
  /** Collects frames while `fn` runs. */
  async function framesDuring(fn) {
    await startFrames();
    let failure = null;
    try {
      await fn();
    } catch (e) {
      failure = e;
    }
    const t = await stopFrames();
    if (failure) throw failure;
    return t;
  }

  /** Opens `path`; returns the ms from the Open request to a decoded first page image. */
  async function openTimed(path) {
    await input.sleep(800);
    await dialogs.queue({ kind: 'openMany', paths: [resolve(path)] });
    const t0 = Date.now();
    await input.press('o', { ctrl: true });
    const ok = await input
      .waitFor(
        `(() => { const i = document.querySelector('[data-page] img'); return !!i && i.complete && i.naturalWidth > 0; })()`,
        { timeoutMs: 40000, intervalMs: 10, what: 'first page image' },
      )
      .catch(() => false);
    const took = Date.now() - t0;
    await input.sleep(800);
    return ok ? took : null;
  }

  await fresh();

  // ---- open ------------------------------------------------------------------------------------------------------------------------
  let opened = false;
  if (PHASES.includes('open') || PHASES.includes('frames')) {
    await section('open', async () => {
      const took = await openTimed(TEXT500);
      opened = took !== null;
      const ok = took !== null && took < BUDGET.openMs;
      report.measurements.open = { ms: took, ok };
      rows.push({
        name: 'open 500 pages -> first page',
        value: took === null ? 'no page image' : ms(took),
        budget: `< ${BUDGET.openMs} ms`,
        ok,
      });
      C('open: 500-page PDF to first rendered page', ok, took === null ? 'no page image' : ms(took));
    });
  }

  // ---- frames ----------------------------------------------------------------------------------------------------------------------
  if (PHASES.includes('frames') && opened) {
    await section('scroll', async () => {
      // Scroll 100 pages in the page: ~200 px per frame, the way a fast wheel/drag does.
      const t = await framesDuring(() =>
        ev(`(async () => {
          const sc = document.querySelector(${q(SCROLLER)});
          const p = document.querySelector('[data-page]').getBoundingClientRect();
          const target = sc.scrollTop + 100 * (p.height + 16);
          while (sc.scrollTop < target && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) {
            sc.scrollTop += 200;
            await new Promise((r) => requestAnimationFrame(r));
          }
        })()`),
      );
      frameRow('scroll 100 pages', t);
      await ev(`document.querySelector(${q(SCROLLER)}).scrollTop = 0`);
      await sleep(600);
    });
    await section('zoom', async () => {
      const step = async (key, mods) => {
        await input.press(key, mods);
        await sleep(350);
      };
      frameRow(
        'zoom in x4, out x4',
        await framesDuring(async () => {
          for (let i = 0; i < 4; i++) await step('=', { ctrl: true });
          for (let i = 0; i < 4; i++) await step('-', { ctrl: true });
        }),
      );
      frameRow(
        'fit width / fit page / 100%',
        await framesDuring(async () => {
          for (let i = 0; i < 2; i++) {
            await step('2', { ctrl: true });
            await step('0', { ctrl: true });
            await step('1', { ctrl: true });
          }
        }),
      );
    });
    await section('panels', async () => {
      const tabs = await ev(
        `[...document.querySelectorAll('[role="tab"][data-value]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getAttribute('data-value'))`,
      );
      C('panels: sidebar tabs found', tabs.length >= 3, tabs.join(', ') || 'none');
      const t = await framesDuring(async () => {
        for (let round = 0; round < 3; round++) {
          for (const v of tabs) {
            await input.click({ selector: `[role="tab"][data-value=${q(v)}]` });
            await sleep(300);
          }
          // search panel (Ctrl+F) and back
          await input.press('f', { ctrl: true });
          await sleep(300);
          if (await exists('[role="searchbox"]')) await input.insertText('Page');
          await sleep(300);
          await input.press('Escape');
          await sleep(200);
        }
      });
      frameRow(`panel switches (${tabs.join(', ')}, search)`, t);
    });
  }

  // ---- OCR -------------------------------------------------------------------------------------------------------------------------
  if (PHASES.includes('ocr') && OCR_PDF) {
    await section('ocr', async () => {
      await ev(`(() => {
        window.__ocr = { values: [], toasts: [], progress: false };
        new MutationObserver(() => {
          const bar = document.querySelector('[data-ocr="bar"]');
          if (bar) { window.__ocr.progress = true; const v = bar.getAttribute('aria-valuenow') + '/' + bar.getAttribute('aria-valuemax'); if (!window.__ocr.values.includes(v)) window.__ocr.values.push(v); }
          for (const t of document.querySelectorAll('[data-toast]')) { const s = t.textContent?.trim(); if (s && !window.__ocr.toasts.includes(s)) window.__ocr.toasts.push(s); }
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      })()`);
      const took0 = await openTimed(OCR_PDF);
      if (took0 === null) throw new Error('scan document did not open');
      // Tools > Recognize text (German labels as in v17-ocr.mjs)
      await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: 'Werkzeuge' });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'tools menu' });
      await sleep(250);
      await input.click({ selector: '[role="menu"] [role="menuitem"]', text: 'Text erkennen' });
      await input.waitFor(`!!document.querySelector('[data-surface="ocr-dialog"]')`, {
        timeoutMs: 5000,
        what: 'ocr dialog',
      });
      await input.waitFor(
        `!['loading', ''].includes(document.querySelector('[data-surface="ocr-dialog"]')?.dataset.language ?? '')`,
        { timeoutMs: 15000, what: 'language state' },
      );
      await sleep(300);
      const t0 = Date.now();
      await input.click({ selector: '[data-ocr="start"]' });
      await input.waitFor(
        `window.__ocr.progress && !document.querySelector('[data-variant="progress"]') && window.__ocr.toasts.length > 0`,
        {
          timeoutMs: 400000,
          intervalMs: 100,
          what: 'ocr run finished',
        },
      );
      const total = Date.now() - t0;
      const info = await ev('window.__ocr');
      const pages = Number((info.values.at(-1) ?? '/10').split('/')[1]) || 10;
      const per = total / 1000 / pages;
      const ok = per <= BUDGET.ocrSecPerPage;
      report.measurements.ocr = {
        totalMs: total,
        pages,
        secPerPage: per,
        progress: info.values,
        toasts: info.toasts,
        ok,
      };
      rows.push({
        name: `OCR ${pages}-page scan`,
        value: `${per.toFixed(2)} s/page (${(total / 1000).toFixed(1)} s total)`,
        budget: `<= ${BUDGET.ocrSecPerPage} s/page`,
        ok,
      });
      C(
        'ocr: average seconds per page',
        ok,
        `${per.toFixed(2)} s/page over ${pages} pages; toast: ${info.toasts.join(' | ')}`,
      );
    });
  }

  // ---- text edit -------------------------------------------------------------------------------------------------------------------
  if (PHASES.includes('textedit')) {
    await section('textedit', async () => {
      if ((await openTimed(EDIT_PDF)) === null) throw new Error('text.pdf did not open');
      await input.click({ selector: '[role="tab"]', text: 'Bearbeiten' });
      await input.click({ text: 'Text bearbeiten' });
      await sleep(600);
      // The first line of text.pdf: 72 pt from the left, baseline 152 pt below the top of a 612 x 792 page.
      await ev(`document.querySelector('[data-page="1"]')?.scrollIntoView({ block: 'start' })`);
      await sleep(400);
      await input.click({ selector: '[data-page="1"]' }, { offset: { fx: (72 + 60) / 612, fy: 146 / 792 } });
      await input.waitFor(`!!document.querySelector('[data-textedit-box]')`, { timeoutMs: 8000, what: 'edit box' });
      await sleep(800); // first preview of the untouched line
      // page side: keystroke time (beforeinput) and the preview frame's load; Enter time and the box going away
      await ev(`(() => {
        window.__te = { key: [], lat: [], applyAt: 0, applyMs: null, pending: null };
        document.addEventListener('beforeinput', () => { window.__te.pending = performance.now(); }, true);
        document.addEventListener('load', (e) => {
          const t = e.target;
          if (t instanceof Element && t.matches('[data-textedit-preview]') && window.__te.pending !== null) {
            requestAnimationFrame(() => { window.__te.lat.push(performance.now() - window.__te.pending); window.__te.pending = null; });
          }
        }, true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__te.applyAt = performance.now(); }, true);
        new MutationObserver(() => {
          if (window.__te.applyAt && window.__te.applyMs === null && !document.querySelector('[data-textedit-box]')) {
            requestAnimationFrame(() => { window.__te.applyMs = performance.now() - window.__te.applyAt; });
          }
        }).observe(document.body, { subtree: true, childList: true });
      })()`);
      await input.press('End');
      const typed = 'Sheer perf check 0123456789';
      for (const ch of typed) {
        await input.insertText(ch);
        await sleep(350); // let the preview of this keystroke land before the next one
      }
      const lat = await ev('window.__te.lat');
      const p95 = quantile(lat, 0.95);
      const okKey = lat.length >= typed.length * 0.8 && p95 <= BUDGET.keystrokeP95Ms;
      report.measurements.keystroke = { samples: lat.length, p50: quantile(lat, 0.5), p95, ok: okKey };
      rows.push({
        name: 'text edit keystroke -> preview',
        value: `p95 ${ms(p95)}, p50 ${ms(quantile(lat, 0.5))} (${lat.length}/${typed.length} previews)`,
        budget: `p95 <= ${BUDGET.keystrokeP95Ms} ms`,
        ok: okKey,
      });
      C('textedit: keystroke -> line preview p95', okKey, `p95 ${ms(p95)} over ${lat.length}/${typed.length} previews`);
      await input.press('Enter');
      await input.waitFor(`window.__te.applyMs !== null`, { timeoutMs: 8000, what: 'apply finished' }).catch(() => {});
      const apply = await ev('window.__te.applyMs');
      const okApply = apply !== null && apply <= BUDGET.applyMs;
      report.measurements.apply = { ms: apply, ok: okApply };
      rows.push({
        name: 'text edit Apply',
        value: apply === null ? 'never finished' : ms(apply),
        budget: `<= ${BUDGET.applyMs} ms`,
        ok: okApply,
      });
      C('textedit: Apply', okApply, apply === null ? 'edit box never closed' : ms(apply));
    });
  }
};

const code = await runSession(session, results);
console.log('\n' + formatPerfTable(rows));
report.rows = rows;
report.ok = code === 0 && rows.every((r) => r.ok);
mkdirSync(resolve(ROOT, 'review'), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(`\nwritten: ${JSON_OUT}`);
console.log(statSync(JSON_OUT).size > 0 && report.ok ? 'PERF OK' : 'PERF MISS');
process.exit(report.ok ? 0 : 1);
