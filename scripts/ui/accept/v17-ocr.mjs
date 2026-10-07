// Acceptance v1.7 "Scan & OCR" (DESIGN 3.12 O-AC 1/3/7/8/9/11/14, ADR-134/135) on the generated scans (review/generated/scans, from
// `npm run fixtures:scans`) and one owner file by ID (owner-pdf-F2, ADR-133; resolved via review/owner/INDEX.md, never named here).
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v17-ocr.mjs   (UI language German, recognition de-DE)
// Phases (one script, one acceptance launch each): main (generated scans, de), owner (owner-scan-S7, de), en (English UI + scan),
// langs-de / langs-none (env SHEER_AUTOMATION_OCR_LANGS masks the installed languages, ADR-137 item 1). Env: V17_PHASES=main,owner,... to select.
// Not covered here: certified / read-only documents (O-AC 12), mocked capabilities (O-AC 6, 13), keyboard-only and reduced motion.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createResults, runSession, openAndWait, sleep } from './harness.mjs';
import { parseIndex, tryCorpusProbe } from './corpus.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const SCANS = resolve(ROOT, 'review/generated/scans');
const OUT = resolve(ROOT, 'review/v170/out');
const SHOTS = 'v170/shots';
const q = (s) => JSON.stringify(s);

const expectedFile = join(SCANS, 'expected.json');
if (!existsSync(expectedFile)) {
  console.log('SKIPPED: review/generated/scans/expected.json is missing (run: npm run fixtures:scans)');
  process.exit(0);
}
const EXPECTED = JSON.parse(readFileSync(expectedFile, 'utf8'));
for (const name of Object.keys(EXPECTED)) {
  if (!existsSync(join(SCANS, name))) {
    console.log(`SKIPPED: review/generated/scans/${name} is missing (run: npm run fixtures:scans)`);
    process.exit(0);
  }
}
const PHASES = (process.env.V17_PHASES ?? 'main,owner,en,langs-de,langs-none').split(',');
mkdirSync(OUT, { recursive: true });
// A second copy of s2 for the cancel run (the first one is recognized completely in the same session).
rmSync(join(OUT, 's1-ocr.pdf'), { force: true });
const S2_CANCEL = join(OUT, 's2-cancel.pdf');
copyFileSync(join(SCANS, 's2-multi-en.pdf'), S2_CANCEL);

/** Owner file by ID; null (with a message) when it cannot be resolved. Never prints the file name (ADR-133). */
function ownerFile(id) {
  const index = resolve(ROOT, 'review/owner/INDEX.md');
  if (!existsSync(index)) return (console.log(`${id}: skipped, review/owner/INDEX.md is missing`), null);
  const name = parseIndex(readFileSync(index, 'utf8')).get(id);
  if (!name) return (console.log(`${id}: skipped, not listed in the index`), null);
  const file = resolve(ROOT, 'review/owner/corpus', name);
  if (!existsSync(file)) return (console.log(`${id}: skipped, file not in review/owner/corpus`), null);
  return file;
}

/** Letters-and-digits only, NFC, lower case: tolerant to spacing, hyphenation marks and punctuation of the recognizer. */
const norm = (s) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
const linesOf = (pages) =>
  pages
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);
/** n distinct words (>= 6 letters) spread evenly over the expected text. */
function probeWords(pages, n = 20) {
  const all = [...new Set(pages.join(' ').match(/\p{L}{6,}/gu) ?? [])];
  if (all.length <= n) return all;
  return Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);
}

const results = createResults();
const { check: C } = results;

const makeSession =
  (phase) =>
  async ({ input, dialogs, ev, shot }) => {
    const uiLang = phase === 'main' || phase === 'owner' ? 'de' : 'en';
    const T =
      uiLang === 'de'
        ? {
            tools: 'Werkzeuge',
            ocr: 'Text erkennen',
            file: 'Datei',
            open: 'Öffnen…',
            none: (w) => `Keine Treffer für „${w}“`,
          }
        : { tools: 'Tools', ocr: 'Recognize Text…', file: 'File', open: 'Open…', none: (w) => `No results for "${w}"` };
    // The acceptance build has its own settings: set the UI language explicitly (the other phases may have changed it).
    await ev(`window.__TAURI_INTERNALS__.invoke('update_settings', { patch: { language: ${q(uiLang)} } })`);
    // The settings store reads the language once at start: reload the page so the new language applies.
    await ev('location.reload()').catch(() => {});
    await sleep(1500);
    // The menu bar exists only with a document open; the start screen sets <html lang> from the settings.
    await input.waitFor(`document.documentElement.lang === ${q(uiLang)}`, {
      timeoutMs: 20000,
      what: 'UI language applied',
    });

    // In-page recorder: progress labels, bar values, toast texts (the toast lives only a few seconds).
    await ev(`(() => {
    window.__ocr = { labels: [], values: [], toasts: [] };
    const push = (a, v) => { if (v && !a.includes(v)) a.push(v); };
    new MutationObserver(() => {
      push(window.__ocr.labels, document.querySelector('[data-ocr="label"]')?.textContent?.trim());
      const bar = document.querySelector('[data-ocr="bar"]');
      if (bar) push(window.__ocr.values, bar.getAttribute('aria-valuenow') + '/' + bar.getAttribute('aria-valuemax'));
      for (const t of document.querySelectorAll('[data-toast]')) push(window.__ocr.toasts, t.textContent?.trim());
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  })()`);
    const resetLog = () => ev(`window.__ocr = { labels: [], values: [], toasts: [] }`);
    const log = () => ev(`window.__ocr`);

    const section = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        C(`${name}: ran to the end`, false, e.message);
      }
    };
    const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);
    const text = (sel) => ev(`document.querySelector(${q(sel)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`);

    async function menu(top, item) {
      await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: top });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: `menu ${top}` });
      await sleep(250);
      await input.click({ selector: '[role="menu"] [role="menuitem"]', text: item });
      await sleep(500);
    }

    async function openDialog() {
      await menu(T.tools, T.ocr);
      await input.waitFor(`!!document.querySelector('[data-surface="ocr-dialog"]')`, {
        timeoutMs: 5000,
        what: 'ocr dialog',
      });
      // capabilities load asynchronously: wait until the language state settled
      await input.waitFor(
        `!['loading', ''].includes(document.querySelector('[data-surface="ocr-dialog"]')?.dataset.language ?? '')`,
        {
          timeoutMs: 15000,
          what: 'language state',
        },
      );
      await sleep(300);
    }
    const dialogInfo = () =>
      ev(`(() => {
      const d = document.querySelector('[data-surface="ocr-dialog"]');
      if (!d) return null;
      const on = d.querySelector('[data-ocr="scope"] label[data-checked]');
      const start = d.querySelector('[data-ocr="start"]');
      return {
        language: d.dataset.language,
        fallback: d.querySelector('[data-ocr="language-fallback"]')?.textContent?.trim() ?? null,
        scope: on?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
        startLabel: start?.textContent?.trim() ?? '',
        startDisabled: start?.getAttribute('aria-disabled') === 'true' || start?.disabled === true,
        redo: !!d.querySelector('[data-ocr="redo"]'),
        value: d.querySelector('[data-ocr="language-value"]')?.textContent?.trim() ?? '',
        noneNote: !!d.querySelector('[data-ocr="language-none"]'),
        settingsButton: !!d.querySelector('[data-ocr="settings"]'),
      };
    })()`);
    const startRun = async () => {
      await resetLog();
      await input.click({ selector: '[data-ocr="start"]' });
      await input.waitFor(`!document.querySelector('[data-surface="ocr-dialog"]')`, {
        timeoutMs: 5000,
        what: 'dialog closed',
      });
    };
    /** Waits until the run is over (no progress banner after one was started) and returns the recorded log. */
    async function finishRun(timeoutMs = 180000) {
      await input.waitFor(
        `window.__ocr.labels.length > 0 && !document.querySelector('[data-variant="progress"]') && window.__ocr.toasts.length > 0`,
        { timeoutMs, intervalMs: 150, what: 'ocr run finished' },
      );
      await sleep(300);
      return log();
    }
    async function recognize(scopeText) {
      await openDialog();
      if (scopeText) await input.click({ selector: '[data-ocr="scope"] label', text: scopeText });
      const info = await dialogInfo();
      await startRun();
      return info;
    }

    // Search helpers: Ctrl+F, clear, type, poll for hit rows or the "no hits" message for exactly this query.
    async function find(word) {
      if (!(await exists('[role="searchbox"]'))) {
        await input.press('f', { ctrl: true });
        await input.waitFor(`!!document.querySelector('[role="searchbox"]')`, {
          timeoutMs: 5000,
          what: 'search field',
        });
      }
      await input.click({ selector: '[role="searchbox"]' });
      await input.press('a', { ctrl: true });
      await input.press('Backspace');
      await input
        .waitFor(`!document.querySelector('[data-search-list] [data-hit]')`, { timeoutMs: 4000, what: 'cleared hits' })
        .catch(() => {});
      await input.insertText(word);
      await sleep(350);
      const none = `document.body.textContent.includes(${q(T.none(word))})`;
      const r = await input
        .waitFor(`(${none}) ? 'none' : (document.querySelector('[data-search-list] [data-hit]') ? 'hit' : '')`, {
          timeoutMs: 6000,
          intervalMs: 150,
          what: `search ${word}`,
        })
        .catch(() => 'timeout');
      return r === 'hit';
    }
    async function probe(name, pages, min) {
      const words = probeWords(pages);
      let hit = 0;
      const missed = [];
      for (const w of words) (await find(w)) ? hit++ : missed.push(w);
      // the probe words come from the generated fixture texts (not owner data)
      C(
        `${name}: search finds >= ${min}/${words.length} probe words`,
        hit >= min,
        `${hit}/${words.length}, missed: ${missed.join(', ') || '-'}`,
      );
      return hit;
    }
    /** Selects up to `max` laid-out lines of the first text layer and reads what Copy would take (the selection string). */
    const sampleLines = (max) =>
      ev(`(() => {
      const layer = document.querySelector('[data-text-page]');
      if (!layer) return [];
      const rows = new Map();
      for (const s of layer.querySelectorAll('[data-run-start]')) {
        const k = Math.round(parseFloat(s.style.top) / 4);
        (rows.get(k) ?? rows.set(k, []).get(k)).push(s);
      }
      const lines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)));
      const usable = lines.filter((l) => l.map((s) => s.textContent).join('').trim().length >= 12);
      const step = Math.max(1, Math.floor(usable.length / ${max}));
      const out = [];
      for (let i = 0; i < usable.length && out.length < ${max}; i += step) {
        const l = usable[i];
        const range = document.createRange();
        range.setStart(l[0].firstChild, 0);
        const last = l[l.length - 1].firstChild;
        range.setEnd(last, last.length);
        const sel = getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        out.push(sel.toString());
      }
      getSelection().removeAllRanges();
      return out;
    })()`);

    async function openScan(name, path) {
      await resetLog();
      // Through the menu: Ctrl+O is swallowed while the search field has the focus (ADR-131: no real input, CDP only).
      await input.press('Escape');
      if (await exists('[data-page]')) {
        await dialogs.answerOpenMany([path]);
        await menu(T.file, T.open);
      } else await dialogs.openFile(path);
      const stem = path
        .split(/[\\/]/)
        .pop()
        .replace(/\.pdf$/i, '');
      await input
        .waitFor(`document.body.innerText.includes(${q(stem)})`, { timeoutMs: 20000, what: `tab ${name}` })
        .catch(() => {});
      await sleep(1500);
    }
    const offerText = () => text('[data-surface="ocr-banner"][data-variant="offer"]');
    const waitOffer = () =>
      input
        .waitFor(`!!document.querySelector('[data-surface="ocr-banner"][data-variant="offer"]')`, {
          timeoutMs: 15000,
          what: 'offer banner',
        })
        .then(
          () => true,
          () => false,
        );

    if (phase === 'main') {
      // ---- s1: German letter, one page ------------------------------------------------------------------------------------
      const s1 = EXPECTED['s1-letter-de.pdf'];
      await section('s1', async () => {
        await openScan('s1', join(SCANS, 's1-letter-de.pdf'));
        const offered = await waitOffer();
        const banner = await offerText();
        C(
          's1: banner offers OCR ("Diese Seite ist ein Bild")',
          offered && banner.includes('Diese Seite ist ein Bild'),
          banner.slice(0, 80),
        );
        await shot(`${SHOTS}/ocr-01-offer`);

        await openDialog();
        const info = await dialogInfo();
        C(
          's1: dialog opens via Werkzeuge > Text erkennen, scope defaults to scanned pages',
          info?.scope?.startsWith('Gescannte Seiten') ?? false,
          `${info?.scope}; language ${info?.language}`,
        );
        C(
          's1: Start enabled, reads "1 Seite erkennen"',
          !info?.startDisabled && info?.startLabel === '1 Seite erkennen',
          info?.startLabel ?? '',
        );
        await shot(`${SHOTS}/ocr-02-dialog`);
        await startRun();
        const run = await finishRun();
        await shot(`${SHOTS}/ocr-03-done`);
        C(
          's1: toast counts "Text auf 1 Seite erkannt"',
          run.toasts.some((t) => t.includes('Text auf 1 Seite erkannt')),
          run.toasts.join(' | '),
        );
        C(
          's1: progress banner appeared',
          run.labels.some((l) => /Erkenne Seite 1 von 1/.test(l)),
          run.labels.join(' | '),
        );
        C('s1: offer banner gone after the run', !(await exists('[data-surface="ocr-banner"][data-variant="offer"]')));

        await probe('s1', s1.pages, 18);
        await shot(`${SHOTS}/ocr-04-search`);

        // copy: lines laid out on the page vs. the expected lines (letters/digits only)
        await input.press('Escape');
        const copied = await sampleLines(10);
        const want = new Set(linesOf(s1.pages).map(norm));
        const ok = copied.filter((l) => want.has(norm(l))).length;
        C(
          's1: copy of selected lines equals the expected line for >= 80 %',
          copied.length >= 5 && ok / copied.length >= 0.8,
          `${ok}/${copied.length} lines (selection string used as the copy source)`,
        );

        // undo removes the layer, redo restores it
        await menu('Bearbeiten', 'Widerrufen');
        await sleep(900);
        const word = probeWords(s1.pages, 3)[1];
        const afterUndo = await find(word);
        C('s1: Undo removes the layer (search returns 0)', !afterUndo, `"${word}"`);
        await shot(`${SHOTS}/ocr-05-undo`);
        await menu('Bearbeiten', 'Wiederholen');
        await sleep(900);
        C('s1: Redo restores the layer', await find(word), `"${word}"`);

        // save through the dialog queue, reopen, search again
        const out = join(OUT, 's1-ocr.pdf');
        await dialogs.answerSave(out);
        await menu('Datei', 'Speichern unter…');
        for (let i = 0; i < 80 && !(existsSync(out) && statSync(out).size > 0); i++) await sleep(250);
        await sleep(1000);
        C('s1: Save wrote review/v170/out/s1-ocr.pdf', existsSync(out) && statSync(out).size > 0, '');
        await dialogs.openFile(out);
        await input
          .waitFor(`document.body.innerText.includes('s1-ocr')`, { timeoutMs: 20000, what: 'reopened tab' })
          .catch(() => {});
        await sleep(3000);
        const again = await find(word);
        C('s1: reopened file keeps search working', again, `"${word}"`);
        C(
          's1: reopened file shows no offer banner',
          !(await exists('[data-surface="ocr-banner"][data-variant="offer"]')),
          '',
        );
        await shot(`${SHOTS}/ocr-06-reopened`);
      });

      // ---- s2: three English pages, complete run then a cancelled run on the copy -----------------------------------------
      const s2 = EXPECTED['s2-multi-en.pdf'];
      await section('s2', async () => {
        await openScan('s2', join(SCANS, 's2-multi-en.pdf'));
        await waitOffer();
        const banner = await offerText();
        // DESIGN O1: the page variant shows while the current page (page 1) is a scan; the count shows in the dialog scope.
        C(
          's2: banner offers OCR for the scanned current page',
          banner.includes('Diese Seite ist ein Bild'),
          banner.slice(0, 80),
        );
        const info = await recognize();
        C('s2: dialog scope counts 3 scanned pages', info?.scope === 'Gescannte Seiten (3)', `${info?.scope}`);
        if (info?.fallback) console.log(`NOTE s2: fallback notice shown: ${info.fallback}`);
        const run = await finishRun();
        C(
          's2: toast counts "Text auf 3 Seiten erkannt"',
          run.toasts.some((t) => t.includes('Text auf 3 Seiten erkannt')),
          run.toasts.join(' | '),
        );
        C(
          's2: progress shows "Erkenne Seite 2 von 3" and the bar advances',
          run.labels.some((l) => /Seite 2 von 3/.test(l)) && run.values.length >= 2,
          `${run.labels.join(' | ')} ; bar ${run.values.join(', ')}`,
        );
        await shot(`${SHOTS}/ocr-07-s2-done`);
        const hit = await probe('s2', s2.pages, 18);
        if (hit < 18 && info?.fallback)
          console.log('NOTE s2: recognition used the fallback language (see notice above), misses are expected');
        C(
          's2: language fallback noted instead of failing',
          true,
          info?.fallback ? `fallback: ${info.fallback.slice(0, 90)}` : `no fallback (${info?.language})`,
        );

        // cancel mid-run on the second copy
        await openScan('s2c', S2_CANCEL);
        await waitOffer();
        // Page recognition takes well under a second, a CDP poll would miss the window: an in-page observer presses Stop (a DOM click on
        // the real button, the same handler) as soon as page 2 is shown.
        await ev(`(() => {
      const mo = new MutationObserver(() => {
        const label = document.querySelector('[data-ocr="label"]')?.textContent ?? '';
        if (/Seite 2 von 3/.test(label)) {
          document.querySelector('[data-ocr="stop"]')?.click();
          mo.disconnect();
        }
      });
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    })()`);
        await recognize();
        const stopped = await finishRun();
        const t = stopped.toasts.find((x) => x.startsWith('Gestoppt')) ?? '';
        const m = /Text auf (\d+) von (\d+) Seiten/.exec(t);
        const applied = m ? Number(m[1]) : -1;
        C(
          's2: cancel mid-run keeps finished pages (toast "Gestoppt. Text auf X von 3")',
          applied >= 1 && applied < 3,
          t || stopped.toasts.join(' | '),
        );
        await shot(`${SHOTS}/ocr-08-stopped`);
        const first = probeWords(s2.pages.slice(0, 1), 3)[1];
        C('s2: a finished page stays searchable after the stop', await find(first), `"${first}"`);
      });

      // ---- s3: rotated page --------------------------------------------------------------------------------------------------
      await section('s3', async () => {
        const s3 = EXPECTED['s3-rotated.pdf'];
        await openScan('s3', join(SCANS, 's3-rotated.pdf'));
        await waitOffer();
        await recognize();
        const run = await finishRun();
        C(
          's3: recognized',
          run.toasts.some((t) => t.includes('Text auf 1 Seite erkannt')),
          run.toasts.join(' | '),
        );
        await shot(`${SHOTS}/ocr-09-s3`);
        await probe('s3 (rotated)', s3.pages, 16);
      });

      // ---- s5: mixed, scope "scanned pages" must recognize page 2 only --------------------------------------------------
      await section('s5', async () => {
        const s5 = EXPECTED['s5-mixed.pdf'];
        await openScan('s5', join(SCANS, 's5-mixed.pdf'));
        await waitOffer();
        const banner = await offerText();
        C('s5: banner counts 1 image page', /1 Seite ist ein Bild/.test(banner), banner.slice(0, 80));
        await openDialog();
        const info = await dialogInfo();
        C(
          's5: scope "Gescannte Seiten (1)" and Start "1 Seite erkennen"',
          info?.scope === 'Gescannte Seiten (1)' && info?.startLabel === '1 Seite erkennen',
          `${info?.scope}; ${info?.startLabel}`,
        );
        await startRun();
        const run = await finishRun();
        C(
          's5: run covers 1 page only (page 2)',
          run.labels.some((l) => /Seite 1 von 1/.test(l)) &&
            run.toasts.some((t) => t.includes('Text auf 1 Seite erkannt')),
          `${run.labels.join(' | ')} ; ${run.toasts.join(' | ')}`,
        );
        const word = probeWords([s5.pages[1]], 3)[1];
        C('s5: page 2 text is searchable', await find(word), `"${word}"`);
        await shot(`${SHOTS}/ocr-10-s5`);
        // O-AC 11: the redo row appears after a first run
        await openDialog();
        const again = await dialogInfo();
        C(
          's5: second dialog offers the redo row, nothing to do by default',
          again?.redo === true && again?.startDisabled === true,
          JSON.stringify(again),
        );
        await input.press('Escape');
        await sleep(400);
      });

      // ---- owner-pdf-F2 --------------------------------------------------------------------------------------------------------
      await section('owner-pdf-F2', async () => {
        const file = ownerFile('owner-pdf-F2');
        if (!file) return;
        await openScan('F2', file);
        const offered = await waitOffer();
        if (!offered) {
          C('owner-pdf-F2: no scanned pages offered (nothing to recognize)', true, 'skipped run');
          return;
        }
        // Page classes by page index of the newest open document (F2 was opened last). The viewer mounts only the visible pages, so the
        // text layer of the DOM cannot tell whether the recognized page got its layer; the classes can.
        const classes = async () => {
          let found = null;
          for (let id = 0; id < 40; id++) {
            const r = await ev(
              `window.__TAURI_INTERNALS__.invoke('ocr_classify_pages', { docId: ${id} }).then((x) => x.map((e) => e.class), () => null)`,
            );
            if (r) found = r;
          }
          return found ?? [];
        };
        const before = await classes();
        const info = await recognize();
        const run = await finishRun();
        C(
          'owner-pdf-F2: run finished with a toast',
          run.toasts.some((t) => /erkannt|Gestoppt/.test(t)),
          run.toasts.join(' | ').slice(0, 120),
        );
        const scans = before.flatMap((k, i) => (k === 'scan' ? [i] : []));
        let after = await classes();
        for (let i = 0; i < 30 && scans.some((n) => after[n] !== 'sheerLayer'); i++)
          (await sleep(300), (after = await classes()));
        C(
          'owner-pdf-F2: scan pages become sheerLayer, all other pages unchanged',
          scans.length > 0 &&
            scans.every((n) => after[n] === 'sheerLayer') &&
            after.every((k, i) => scans.includes(i) || k === before[i]),
          `scan pages ${scans.join(',')} of ${before.length}; language ${info?.language}`,
        );
      });
    }

    // ---- owner scan S7 (ADR-138 §1, ADR-133: IDs and counts only; names, probes and text never printed or committed) -------------
    if (phase === 'owner') {
      const id = 'owner-scan-S7';
      await section(id, async () => {
        const index = resolve(ROOT, 'review/owner/INDEX.md');
        if (!existsSync(index)) return console.log(`${id}: skipped, review/owner/INDEX.md is missing`);
        const rel = parseIndex(readFileSync(index, 'utf8')).get(id);
        if (!rel) return console.log(`${id}: skipped, not listed in the index`);
        const file = resolve(ROOT, 'review/owner', rel);
        if (!existsSync(file)) return console.log(`${id}: skipped, file not found`);
        const probes = [];
        for (let n = 1; n <= 6; n++) {
          const raw = tryCorpusProbe(`${id}/p${n}`);
          if (raw === null) return console.log(`${id}: skipped, probe key p${n} missing in the index`);
          probes.push(
            raw
              .split(';')
              .map((w) => w.trim())
              .filter(Boolean),
          );
        }
        await openScan(id, file);
        await waitOffer();
        const t0 = Date.now();
        await openDialog();
        const scopes = await ev(
          `[...document.querySelectorAll('[data-surface="ocr-dialog"] [data-ocr="scope"] label')].map((l) => l.textContent.replace(/\s+/g, ' ').trim())`,
        );
        const pick = scopes.find((x) => /^Alle Seiten/.test(x)) ?? scopes.find((x) => /^Gescannte Seiten/.test(x));
        if (pick) await input.click({ selector: '[data-ocr="scope"] label', text: pick.split(' (')[0] });
        const info = await dialogInfo();
        await startRun();
        const run = await finishRun(900000);
        // "Alle Seiten" carries no count in its label: the pages recognized come from the finishing toast.
        const scanCount = Number(
          run.toasts.map((t) => /Text auf (\d+) Seiten erkannt/.exec(t)?.[1]).find(Boolean) ?? NaN,
        );
        const ms = Date.now() - t0;
        C(
          `${id}: run finished`,
          run.toasts.some((t) => /erkannt|Gestoppt/.test(t)),
          '',
        );
        C(`${id}: every page is a scan (>= 6 scanned pages)`, scanCount >= 6, `scanned pages: ${scanCount}`);
        console.log(
          `${id}: run ${Math.round(ms / 1000)} s${scanCount > 0 ? `, ${Math.round(ms / scanCount / 1000)} s per page` : ''}`,
        );
        // Search per word; the hit rows carry "Seite N, ..." in their aria-label (rows are virtualized, the visible ones are read).
        const pagesOf = () =>
          ev(
            `[...document.querySelectorAll('[data-search-list] [data-hit]')].map((e) => /^Seite ([0-9]+)(?:,|$)/.exec(e.getAttribute('aria-label') ?? '')?.[1]).filter(Boolean).map(Number)`,
          );
        const dump = [`run ${ms} ms, scope ${info?.scope}`];
        let total = 0;
        let count = 0;
        for (let n = 1; n <= 6; n++) {
          let k = 0;
          const lines = [];
          for (const w of probes[n - 1]) {
            const f = await find(w);
            let ok = false;
            let pages = [];
            if (f) {
              await sleep(400);
              pages = [...new Set(await pagesOf())];
              ok = pages.includes(n);
            }
            if (ok) k++;
            lines.push(`${ok ? 'FOUND ' : 'MISS  '}${w} (hit pages: ${pages.join(',') || '-'})`);
          }
          total += k;
          count += probes[n - 1].length;
          dump.push(`--- p${n}: ${k}/${probes[n - 1].length}`, ...lines);
          C(`${id}/p${n}: ${k}/${probes[n - 1].length}`, k >= 4, '');
        }
        console.log(`${id}: total ${total}/${count}`);
        const layers = await ev(
          `[...document.querySelectorAll('[data-text-page]')].map((l) => 'page-id ' + l.getAttribute('data-text-page') + ': ' + [...l.querySelectorAll('[data-run-start]')].map((s) => s.textContent).join(' ')).join(String.fromCharCode(10))`,
        );
        mkdirSync(resolve(ROOT, 'review/v180'), { recursive: true });
        writeFileSync(resolve(ROOT, 'review/v180/owner-scan-S7-words.txt'), `${dump.join('\n')}\n=====\n${layers}\n`);
        await shot(`${SHOTS}/owner-${id}`);
      });
    }

    // ---- English UI, English scan (ADR-137 item 1b) -----------------------------------------------------------------------------
    if (phase === 'en') {
      await section('en', async () => {
        const s2 = EXPECTED['s2-multi-en.pdf'];
        await openScan('en', join(SCANS, 's2-multi-en.pdf'));
        await waitOffer();
        await openDialog();
        const info = await dialogInfo();
        C(
          'en: recognition language en-US',
          info?.language === 'available' && /en-US/.test(info.value),
          `${info?.language}; ${info?.value}`,
        );
        C('en: no fallback notice', !info?.fallback, info?.fallback ?? '');
        await startRun();
        const run = await finishRun();
        C(
          'en: toast "Text recognized on 3 pages"',
          run.toasts.some((t) => t.includes('Text recognized on 3 pages')),
          run.toasts.join(' | '),
        );
        await probe('en', s2.pages, 18);
        await shot(`${SHOTS}/en-done`);
      });
    }

    // ---- missing-language mask (ADR-137 item 1c); the env var is set by the launcher below, only the acceptance build honours it ----
    if (phase === 'langs-de' || phase === 'langs-none') {
      await section(phase, async () => {
        const caps = await ev(`window.__TAURI_INTERNALS__.invoke('ocr_capabilities')`);
        const on = caps.languages.filter((l) => l.available).map((l) => l.tag);
        if (phase === 'langs-de')
          C('langs-de: only de-DE is available', on.length === 1 && on[0] === 'de-DE', on.join(','));
        else C('langs-none: no language is available', on.length === 0, on.join(','));
        await openScan(phase, join(SCANS, 's2-multi-en.pdf'));
        await waitOffer();
        await openDialog();
        const info = await dialogInfo();
        await shot(`${SHOTS}/${phase}-dialog`);
        if (phase === 'langs-de') {
          C(
            'langs-de: dialog shows the fallback notice',
            info?.language === 'fallback' && !!info.fallback,
            `${info?.language}; ${info?.fallback ?? ''}`,
          );
          C(
            'langs-de: notice names German as the language used',
            /German/.test(info?.fallback ?? ''),
            info?.fallback ?? '',
          );
          await startRun();
          const run = await finishRun();
          C(
            'langs-de: the run completes with German',
            run.toasts.some((t) => /recognized|Stopped/.test(t)),
            run.toasts.join(' | '),
          );
        } else {
          C(
            'langs-none: dialog shows the no-language state',
            info?.language === 'none' && info.noneNote,
            `${info?.language}`,
          );
          C('langs-none: "Open language settings" button present (not clicked)', info?.settingsButton === true, '');
          C('langs-none: Start is disabled', info?.startDisabled === true, info?.startLabel ?? '');
          await input.press('Escape');
        }
      });
    }

    const err = await dialogs.lastError();
    if (err) C('no automation error', false, JSON.stringify(err));
  };

// One launch per phase. The mask is read at app start, so the env var is set before the launch (launch.mjs passes the environment on).
const PHASE_ENV = { 'langs-de': 'de-DE', 'langs-none': '' };
for (const phase of PHASES) {
  if (phase in PHASE_ENV) process.env.SHEER_AUTOMATION_OCR_LANGS = PHASE_ENV[phase];
  else delete process.env.SHEER_AUTOMATION_OCR_LANGS;
  await runSession(makeSession(phase), results);
}
delete process.env.SHEER_AUTOMATION_OCR_LANGS;

results.table();
process.exit(results.failed() ? 1 : 0);
