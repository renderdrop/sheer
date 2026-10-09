// Acceptance v1.7 "Range chooser" (ADR-133 section 2, DESIGN 3.11 L14 / L-AC 15) on a self-generated PDF (review/v170/range.pdf).
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v16-range.mjs   (UI language German)
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createResults, runSession, setUiLanguage, openAndWait, sleep, SCROLLER } from './harness.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const PDF = resolve(ROOT, 'review/v170/range.pdf');
execFileSync(process.execPath, [resolve(ROOT, 'scripts/ui/gen-range-pdf.mjs'), PDF], { stdio: 'ignore' });

const q = (s) => JSON.stringify(s);
const results = createResults();
const { check: C } = results;

await runSession(async ({ input, dialogs, ev, shot }) => {
  await setUiLanguage({ ev, input }, 'de');
  await openAndWait({ input, dialogs }, PDF);
  await input.waitFor(`document.querySelectorAll('[data-links-list] [data-smartlink]').length > 0`, {
    timeoutMs: 20000,
    what: 'smart links',
  });
  await sleep(500);
  const labels = await ev(
    `[...document.querySelectorAll('[data-links-list] [data-smartlink]')].map((e) => e.getAttribute('aria-label'))`,
  );
  const sel = (marker) =>
    ev(`(() => { const e = [...document.querySelectorAll('[data-links-list] [data-smartlink]')]
      .find((x) => (x.getAttribute('aria-label') ?? '').includes(${q(marker)})); return e ? e.dataset.linkKey : null; })()`);
  const runOf = (key) => `[data-link-key=${q(key)}] [data-smartlink-run]`;
  const k35 = await sel('3–5');
  const k7 = (await sel('[7]')) ?? (await sel('7'));
  C('range "[3–5]" detected as a link', k35 !== null, JSON.stringify(labels));
  C('"[2, 4–6]" detected (range part)', (await sel('4–6')) !== null, JSON.stringify(labels));
  if (k35 === null) return;

  await input.hover({ selector: runOf(k35) });
  const preview = await input
    .waitFor(`document.querySelector('[data-link-preview]')?.textContent || ''`, { timeoutMs: 4000, what: 'preview' })
    .catch(() => '');
  C(
    'hover: "Erkannt · Quelle · 3 Einträge"',
    /Erkannt\s*·\s*Quelle\s*·\s*3 Einträge/.test(preview),
    preview.slice(0, 120),
  );
  await sleep(400);
  await shot('v170/range-01-hover');

  await input.click({ selector: runOf(k35) });
  await input.waitFor(`!!document.querySelector('[data-surface="range-chooser"]')`, {
    timeoutMs: 4000,
    what: 'chooser',
  });
  await sleep(500);
  const rows = await ev(
    `[...document.querySelectorAll('[data-range-row]')].map((r) => r.querySelector('span')?.textContent?.trim())`,
  );
  C('click: chooser lists rows 3, 4, 5', JSON.stringify(rows) === '["3","4","5"]', JSON.stringify(rows));
  const header = await ev(`document.querySelector('[data-surface="range-chooser"]')?.textContent ?? ''`);
  C('chooser header "Erkannt · 3 Einträge"', /Erkannt\s*·\s*3 Einträge/.test(header), header.slice(0, 80));
  await shot('v170/range-02-chooser');

  const band = `document.querySelector('[data-history-mark]')?.closest('[data-page]')?.dataset.page ?? ''`;
  await input.press('ArrowDown');
  await sleep(200);
  const cur = await ev(
    `document.querySelector('[data-range-row][data-current]')?.querySelector('span')?.textContent?.trim()`,
  );
  C('ArrowDown moves to entry 4', cur === '4', String(cur));
  await shot('v170/range-03-arrow');
  await input.press('Enter');
  const page = await input.waitFor(band, { timeoutMs: 6000, what: 'band' }).catch(() => '');
  await sleep(500);
  C(
    'Enter jumps to the bibliography page (2) and closes the chooser',
    page === '2' && !(await ev(`!!document.querySelector('[data-surface="range-chooser"]')`)),
    `band page ${page || 'none'}`,
  );
  await shot('v170/range-04-jumped');

  await input.press('ArrowLeft', { alt: true });
  await sleep(900);
  const back =
    await ev(`(() => { const s = document.querySelector(${q(SCROLLER)}); const p = document.querySelector('[data-page="1"]');
    const r = p?.getBoundingClientRect(), sr = s.getBoundingClientRect();
    return !!r && r.bottom > sr.top && r.top < sr.bottom; })()`);
  C('Back returns to page 1', back, '');
  await shot('v170/range-05-back');

  // Esc closes and returns focus to the origin
  await input.click({ selector: runOf(k35) });
  await input.waitFor(`!!document.querySelector('[data-surface="range-chooser"]')`, {
    timeoutMs: 4000,
    what: 'chooser again',
  });
  await sleep(400);
  await input.press('Escape');
  await sleep(500);
  const closed = !(await ev(`!!document.querySelector('[data-surface="range-chooser"]')`));
  const focus = await ev(
    `document.activeElement?.getAttribute('data-link-key') ?? document.activeElement?.tagName ?? ''`,
  );
  C('Esc closes the chooser', closed, '');
  C('Esc returns focus to the range link', focus === k35, `active: ${focus}`);
  await shot('v170/range-06-esc');

  // "[7]" is a plain link: no chooser, jumps straight
  if (k7 === null) C('"[7]" detected', false, JSON.stringify(labels));
  else {
    await input.click({ selector: runOf(k7) });
    await sleep(800);
    const chooser = await ev(`!!document.querySelector('[data-surface="range-chooser"]')`);
    const p7 = await ev(band);
    C('"[7]" is a plain link: no chooser, jumps to page 2', !chooser && p7 === '2', `chooser=${chooser} band=${p7}`);
    await shot('v170/range-07-plain');
  }
  const err = await dialogs.lastError();
  if (err) C('no automation error', false, JSON.stringify(err));
}, results);

results.table();
process.exit(results.failed() ? 1 : 0);
