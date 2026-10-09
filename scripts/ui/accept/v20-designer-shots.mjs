// Designer screenshots for v2.0 (ADR-140 section 6) from the acceptance build over CDP (Page.captureScreenshot, never the screen;
// rule 13). Self-made documents only: copies of tests/fixtures/text.pdf and signed.pdf. German UI, 1280x800.
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v20-designer-shots.mjs
// Output: review/v200/designer-{a-home,b-document,c-menu,d-stamps}.png. Empties the acceptance recent list first. The recovery banner of earlier killed sessions is hidden
// with "Später entscheiden" (session only, the records stay).
import { enterMode } from './modes.mjs';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResults, openAndWait, runSession, sleep } from './harness.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = resolve(ROOT, 'review/v200');
mkdirSync(OUT, { recursive: true });
const DOC = join(OUT, `designer-${Date.now().toString(36)}.pdf`);
copyFileSync(resolve(ROOT, 'tests/fixtures/text.pdf'), DOC);
// Disabled items carry a reason only for a cause the user can act on (signed, read-only, ...): a signed copy for shot (c).
const SIGNED = join(OUT, `designer-signed-${Date.now().toString(36)}.pdf`);
copyFileSync(resolve(ROOT, 'tests/fixtures/signed.pdf'), SIGNED);
const q = (s) => JSON.stringify(s);

const results = createResults();
const { check: C } = results;

const code = await runSession(async (ctx) => {
  const { input, ev } = ctx;
  const patch = {
    language: 'de',
    welcomeTour: 'shown',
    authorPrompt: 'done',
    pageSidebarCollapsed: false,
    tipsEnabled: false,
  };
  await ev(`window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(patch)} })`);
  // The acceptance profile's recent list holds earlier runs, owner corpus files among them (rule 16): empty it, so (a) shows the
  // empty state. Only the list of this acceptance build changes; the files stay where they are.
  await ev(`(async () => { const i = window.__TAURI_INTERNALS__.invoke;
    for (const r of await i('list_recents')) await i('remove_recent', { recentId: r.id }); })()`);
  await ev('location.reload()').catch(() => {});
  await sleep(2000);
  await input.waitFor(`document.documentElement.lang === 'de'`, { timeoutMs: 20000, what: 'UI language' });
  const hideRecovery = async () => {
    if (
      await ev(
        `!![...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Später entscheiden')`,
      )
    ) {
      await input.click({ selector: 'button[aria-label="Später entscheiden"]' });
      await sleep(500);
    }
  };
  const shot = async (name) =>
    C(`shot ${name}`, !!(await input.screenshot(`v200/designer-${name}.png`)), `review/v200/designer-${name}.png`);
  const menu = async (top) => {
    await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: top });
    await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: `menu ${top}` });
    await sleep(500);
  };

  // (a) home
  await hideRecovery();
  await sleep(800);
  await shot('a-home');

  // (b) document, read mode, left panel open
  await openAndWait(ctx, DOC);
  await hideRecovery();
  if (!(await ev(`!!document.querySelector('[role="tab"][data-value="thumbnails"],[role="tablist"] [role="tab"]')`)))
    await input.click({ selector: 'button', text: 'Seitenleiste einblenden' }).catch(() => {});
  await enterMode(input, 'read', sleep);
  await sleep(1500);
  await shot('b-document');

  // (c) a menu with a disabled item and its reason line, on the signed copy
  await openAndWait(ctx, SIGNED);
  await hideRecovery();
  await sleep(1000);
  let found = null;
  for (const top of ['Bearbeiten', 'Werkzeuge', 'Datei', 'Ansicht']) {
    await menu(top);
    const n = await ev(
      `document.querySelectorAll('[role="menu"] [role^="menuitem"][aria-disabled="true"][aria-description]').length`,
    );
    if (n > 0) {
      found = `${top}: ${n} with a reason`;
      break;
    }
    await input.press('Escape');
    await sleep(300);
  }
  C('menu with a disabled item and reason line', !!found, found ?? 'none found');
  await shot('c-menu');
  await input.press('Escape');
  await sleep(400);

  // (d) comment mode, stamp picker, back on the unsigned copy (its tab)
  await ev(`document.activeElement?.blur()`);
  await openAndWait(ctx, DOC); // already open: Open brings its tab to the front
  await sleep(1000);
  C(
    'stamp shot on the unsigned copy',
    (await ev(`document.title + ' ' + document.body.innerText.slice(0, 400)`)).includes(basename(DOC).slice(0, 14)),
    '',
  );
  await enterMode(input, 'comment', sleep);
  await sleep(600);
  await menu('Bearbeiten');
  await input.click({ selector: '[role="menu"] [role="menuitem"]', text: 'Stempel…' });
  await input.waitFor(`!!document.querySelector('[data-surface="stamp-picker"]')`, {
    timeoutMs: 5000,
    what: 'stamp picker',
  });
  await sleep(800);
  await shot('d-stamps');
  await input.press('Escape');
}, results);
results.table();
process.exit(code);
