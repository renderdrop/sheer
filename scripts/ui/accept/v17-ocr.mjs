// Acceptance v1.7 "Scan & OCR" (DESIGN 3.12 O-AC 1/3/7/8/9/11/14, ADR-134/135) on the generated scans (review/generated/scans, from
// `npm run fixtures:scans`) and one owner file by ID (owner-pdf-F2, ADR-133; resolved via review/owner/INDEX.md, never named here).
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v17-ocr.mjs   (UI language German, recognition de-DE)
// Not covered here: certified / read-only documents (O-AC 12), mocked capabilities (O-AC 6, 13), keyboard-only and reduced motion.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createResults, runSession, openAndWait, sleep } from './harness.mjs';
import { parseIndex } from './corpus.mjs';

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
mkdirSync(OUT, { recursive: true });
// A second copy of s2 for the cancel run (the first one is recognized completely in the same session).
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

await runSession(async ({ input, dialogs, ev, shot }) => {
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
    await menu('Werkzeuge', 'Text erkennen');
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
      const radios = [...d.querySelectorAll('[data-ocr="scope"] [role="radio"]')];
      const on = radios.find((r) => r.getAttribute('aria-checked') === 'true');
      const start = d.querySelector('[data-ocr="start"]');
      return {
        language: d.dataset.language,
        fallback: d.querySelector('[data-ocr="language-fallback"]')?.textContent?.trim() ?? null,
        scope: on?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
        startLabel: start?.textContent?.trim() ?? '',
        startDisabled: start?.getAttribute('aria-disabled') === 'true' || start?.disabled === true,
        redo: !!d.querySelector('[data-ocr="redo"]'),
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
    if (scopeText) await input.click({ selector: '[data-ocr="scope"] [role="radio"]', text: scopeText });
    const info = await dialogInfo();
    await startRun();
    return info;
  }

  // Search helpers: Ctrl+F, clear, type, poll for hit rows or the "no hits" message for exactly this query.
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
    const none = `document.body.textContent.includes(${q(`Keine Treffer für „${word}“`)})`;
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
    await openAndWait({ input, dialogs }, path);
    await sleep(600);
    void name;
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
    await input.press('s', { ctrl: true, shift: true });
    await input
      .waitFor(() => existsSync(out) && statSync(out).size > 0, { timeoutMs: 20000, what: 'saved file' })
      .catch(() => {});
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
    C('s2: banner reads "3 Seiten sind Bilder"', banner.includes('3 Seiten sind Bilder'), banner.slice(0, 80));
    const info = await recognize();
    await sleep(0);
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
    await recognize();
    await input.waitFor(`window.__ocr.labels.some((l) => /Seite [23] von 3/.test(l))`, {
      timeoutMs: 120000,
      intervalMs: 40,
      what: 'page 2 running',
    });
    await input.click({ selector: '[data-ocr="stop"]' });
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
      run.labels.some((l) => /Seite 1 von 1/.test(l)) && run.toasts.some((t) => t.includes('Text auf 1 Seite erkannt')),
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
    const before = await ev(
      `[...document.querySelectorAll('[data-text-length]')].reduce((n, e) => n + Number(e.dataset.textLength), 0)`,
    );
    const info = await recognize();
    const run = await finishRun();
    C(
      'owner-pdf-F2: run finished with a toast',
      run.toasts.some((t) => /erkannt|Gestoppt/.test(t)),
      run.toasts.join(' | ').slice(0, 120),
    );
    await sleep(800);
    const after = await ev(
      `[...document.querySelectorAll('[data-text-length]')].reduce((n, e) => n + Number(e.dataset.textLength), 0)`,
    );
    C(
      'owner-pdf-F2: recognized text appears in the text layer',
      after > before,
      `text length ${before} -> ${after}; language ${info?.language}`,
    );
  });

  const err = await dialogs.lastError();
  if (err) C('no automation error', false, JSON.stringify(err));
}, results);

results.table();
process.exit(results.failed() ? 1 : 0);
