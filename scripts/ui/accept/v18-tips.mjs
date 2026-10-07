// Acceptance v1.8 "Context help" (DESIGN 3.13 CT-AC 1-9 as far as scriptable; CT-AC 10 screen reader, 11 clip files and the cap/tour
// cases are not covered here). Self-made documents only: tests/fixtures/text.pdf and tests/fixtures/form-clip.pdf.
// Prereq: npm run build:acceptance; node scripts/fixtures/form-clip.mjs. Run: node scripts/ui/accept/v18-tips.mjs
// One launch. Cases 1-4 run in German and once more in English; 5-8 in German. Before every case `tipsSeen` is reset to [] and
// `tipsEnabled` to true (update_settings + reload, which also clears the per-session set of the tip runtime).
// Screenshots (light, German): review/v180/shots/tip-{highlightClip,formClip,signClip,pagesClip}.png.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createResults, runSession, openAndWait, sleep, SCROLLER } from './harness.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const TEXT = resolve(ROOT, 'tests/fixtures/text.pdf');
const FORM = resolve(ROOT, 'tests/fixtures/form-clip.pdf');
const SHOTS = 'v180/shots';
const q = (s) => JSON.stringify(s);

for (const f of [TEXT, FORM]) {
  if (!existsSync(f)) {
    console.log(`SKIPPED: ${f} is missing (run: node scripts/fixtures/form-clip.mjs)`);
    process.exit(0);
  }
}

const results = createResults();
const { check: C } = results;

const STRINGS = {
  de: {
    file: 'Datei',
    settings: 'Einstellungen…',
    reset: 'Tipps erneut zeigen',
    enabled: 'Tipps anzeigen',
    create: 'Erstellen',
  },
  en: { file: 'File', settings: 'Settings…', reset: 'Show tips again', enabled: 'Show tips', create: 'Create' },
};
const NEGATIVE_MS = 3500; // longer than the 2 s input-focus wait and the enter motion

const session = async (ctx) => {
  const { input, ev, session: s } = ctx;
  let T = STRINGS.de;
  let lang = 'de';

  // ---- helpers --------------------------------------------------------------------------------------------------------------
  const settings = () => ev(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  const seen = async () => (await settings()).tipsSeen ?? [];

  /** Resets the tip state, sets the UI language and reloads (start screen, no document, empty per-session set). */
  async function fresh({ enabled = true } = {}) {
    const patch = {
      language: lang,
      welcomeTour: 'shown',
      authorPrompt: 'done',
      pageSidebarCollapsed: true,
      tipsSeen: [],
      tipsEnabled: enabled,
    };
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(patch)} }).then(() => 'ok', (e) => 'ERR ' + JSON.stringify(e))`,
    );
    if (r !== 'ok') throw new Error(`update_settings failed: ${r}`);
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === ${q(lang)}`, {
      timeoutMs: 20000,
      what: 'UI language applied',
    });
  }
  const open = (path) => openAndWait(ctx, path);
  const mode = async (id) => {
    await input.click({ selector: `[data-mode="${id}"]` });
    await sleep(500);
  };
  const tool = async (id) => {
    await input.click({ selector: `[data-toolbar-item="${id}"]` });
    await sleep(400);
  };
  const tipOf = (id) => `!!document.querySelector('[data-surface="tip"]${id ? `[data-tip-id="${id}"]` : ''}')`;
  const anyTip = () => ev(tipOf(null));
  const tipIds = () =>
    ev(`[...document.querySelectorAll('[data-surface="tip"]')].map((e) => e.getAttribute('data-tip-id'))`);

  async function waitTip(id, timeoutMs = 10000) {
    await input.waitFor(tipOf(id), { timeoutMs, what: `tip ${id}` });
    await sleep(700); // enter motion + image decode
  }
  /** True when nothing shows for NEGATIVE_MS. */
  async function stayQuiet(ms = NEGATIVE_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await anyTip()) return false;
      await sleep(200);
    }
    return true;
  }
  /** Card facts and the overlap with everything the tip must not cover (DESIGN 3.13 C2), all in page (client) coordinates. */
  const measure = () =>
    ev(`(() => {
    const card = document.querySelector('[data-surface="tip"]');
    if (!card) return null;
    const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const c = box(card);
    const bodyId = card.querySelector('p')?.id;
    const anchor = bodyId ? document.querySelector('[aria-describedby~="' + bodyId + '"]') : null;
    const protectedRects = [];
    for (const e of document.querySelectorAll('input, textarea, select, [data-selection], [data-selection-handle]'))
      if (!card.contains(e) && vis(e)) protectedRects.push(['input/selection', box(e)]);
    if (anchor) protectedRects.push(['anchor', box(anchor)]);
    for (const e of document.querySelectorAll('[data-region="banner"] > *, [data-banner], [data-organize] [role="option"]'))
      if (!card.contains(e) && vis(e)) protectedRects.push([e.closest('[data-organize]') ? 'page card' : 'banner', box(e)]);
    const over = protectedRects.filter(([, r]) => hit(c, r)).map(([k]) => k);
    const canvas = document.querySelector(${q(SCROLLER + ', [data-organize]')});
    const cv = canvas ? box(canvas) : null;
    const img = card.querySelector('img');
    const buttons = [...card.querySelectorAll('button')];
    return {
      id: card.getAttribute('data-tip-id'),
      rect: c, canvasRect: cv,
      over,
      hasAnchor: !!anchor,
      inside: cv ? c.l >= cv.l - 1 && c.r <= cv.r + 1 && c.t >= cv.t - 1 && c.b <= cv.b + 1 : null,
      overflow: card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1,
      src: img?.getAttribute('src') ?? null,
      alt: img?.getAttribute('alt') ?? '',
      buttons: buttons.length,
      region: card.getAttribute('role'),
    };
  })()`);
  /** Clicks the Hide button (the last button of the card, after Replay when there is one). */
  async function dismiss() {
    const n = await ev(`document.querySelector('[data-surface="tip"]')?.querySelectorAll('button').length ?? 0`);
    if (n === 0) throw new Error('no button on the tip');
    await input.click({ selector: '[data-surface="tip"] button', nth: n - 1 });
    await input.waitFor(`!document.querySelector('[data-surface="tip"]')`, { timeoutMs: 4000, what: 'tip dismissed' });
  }
  async function menu(top, item) {
    await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: top });
    await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: `menu ${top}` });
    await sleep(250);
    await input.click({ selector: '[role="menu"] [role="menuitem"]', text: item });
    await sleep(600);
  }
  async function openSettings() {
    await menu(T.file, T.settings);
    await input.waitFor(`!!document.querySelector('[role="switch"]')`, { timeoutMs: 5000, what: 'settings panel' });
    await sleep(300);
  }
  async function closeSettings() {
    await input.press('Escape');
    await input
      .waitFor(`![...document.querySelectorAll('[role="switch"]')].some((e) => e.getBoundingClientRect().width > 0)`, {
        timeoutMs: 4000,
        what: 'settings closed',
      })
      .catch(() => {});
    await sleep(300);
  }
  /** Index of the tips switch among the visible switches (matched by its accessible label). */
  const tipsSwitch = () =>
    ev(`(() => {
    const all = [...document.querySelectorAll('[role="switch"]')].filter((e) => e.getBoundingClientRect().width > 0);
    const at = all.findIndex((e) => (document.getElementById(e.getAttribute('aria-labelledby') ?? '')?.textContent ?? '').trim() === ${q(T.enabled)});
    return { at, checked: at >= 0 ? all[at].getAttribute('aria-checked') : null };
  })()`);
  async function setTipsSwitch(on) {
    await openSettings();
    const sw = await tipsSwitch();
    if (sw.at < 0) throw new Error('tips switch not found');
    if ((sw.checked === 'true') !== on) {
      await input.click({ selector: '[role="switch"]', nth: sw.at });
      await sleep(500);
    }
    const after = await tipsSwitch();
    return after.checked === String(on);
  }
  /** Arms the signature tool. A signature sheet (first use) is answered with a typed signature; returns whether a sheet showed. */
  async function armSign({ answer = true } = {}) {
    await mode('fill');
    await tool('signature');
    const sheet = await input
      .waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 2500, what: 'signature sheet' })
      .then(
        () => true,
        () => false,
      );
    if (!sheet) return false;
    if (!answer) {
      await input.press('Escape');
      await sleep(500);
      return true;
    }
    await sleep(400);
    await input.click({ selector: '[role="dialog"] input', nth: 0 });
    await input.insertText('A. Example');
    await sleep(2500);
    await input.waitFor(
      `[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === ${q(T.create)} && !b.disabled && b.getAttribute('aria-disabled') !== 'true')`,
      { what: 'Create enabled' },
    );
    return {
      sheetCard: await anyTip(),
      click: () => input.click({ text: T.create, selector: '[role="dialog"] button' }),
    };
  }
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      C(`${name}: ran to the end`, false, e.message);
    }
  };
  const clipSrc = (m, id, poster) =>
    !!m?.src &&
    new RegExp(`${id}${poster ? '-poster' : ''}[^/]*\\.png`).test(m.src) &&
    (poster || !m.src.includes('-poster'));

  // ---- cases ------------------------------------------------------------------------------------------------------------------
  async function caseHighlight(tag, { shot = false } = {}) {
    await fresh();
    await open(TEXT);
    await mode('comment');
    await tool('highlight');
    await waitTip('highlightClip');
    const m = await measure();
    C(
      `${tag} 1 highlight: clip tip shows (img src ends with the clip, alt set)`,
      clipSrc(m, 'highlightClip', false) && m.alt.length > 0,
      `${m?.src}; alt "${m?.alt}"`,
    );
    C(
      `${tag} 1 highlight: card avoids inputs, selection and the anchor`,
      m.hasAnchor && m.over.length === 0,
      `anchor ${m.hasAnchor}; over: ${m.over.join(',') || '-'}`,
    );
    if (shot) await input.screenshot(`${SHOTS}/tip-highlightClip`);
    C(`${tag} 1 highlight: tipsSeen holds the id`, (await seen()).includes('highlightClip'), (await seen()).join(','));
    await dismiss();
    C(`${tag} 1 highlight: dismiss removes the tip`, !(await anyTip()), '');
    // same session: release and select again, then a neighbour tool and back
    await tool('highlight');
    await tool('highlight');
    await input.click({ selector: '[data-toolbar-item="underline"]' }).catch(() => {});
    await sleep(300);
    await tool('highlight');
    C(
      `${tag} 1 highlight: selecting Highlight again in the session shows no tip`,
      await stayQuiet(),
      (await tipIds()).join(','),
    );
  }

  async function caseForm(tag, { shot = false } = {}) {
    await fresh();
    await open(FORM);
    await waitTip('formClip', 12000);
    const m = await measure();
    C(`${tag} 2 form: tip shows with its clip`, clipSrc(m, 'formClip', false) && m.alt.length > 0, `${m?.src}`);
    C(
      `${tag} 2 form: card never covers a field (nor the anchor)`,
      m.over.length === 0,
      `anchor ${m.hasAnchor}; over: ${m.over.join(',') || '-'}`,
    );
    if (shot) await input.screenshot(`${SHOTS}/tip-formClip`);
    // commit a field value: click into the first field, type, Tab (blur commits)
    await input.click({ selector: `${SCROLLER} input`, nth: 0 });
    await input.insertText('Alex Example');
    await input.press('Tab');
    await input
      .waitFor(`!document.querySelector('[data-surface="tip"][data-tip-id="formClip"]')`, {
        timeoutMs: 6000,
        what: 'form tip gone after the commit',
      })
      .then(
        () => C(`${tag} 2 form: committing a field value removes the tip`, true),
        (e) => C(`${tag} 2 form: committing a field value removes the tip`, false, e.message),
      );
    // a document without fields never triggers it
    await fresh();
    await open(TEXT);
    C(
      `${tag} 2 form: a document without fields (text.pdf) shows no form tip`,
      await stayQuiet(),
      (await tipIds()).join(','),
    );
  }

  async function caseSign(tag, { shot = false } = {}) {
    await fresh();
    await open(TEXT);
    const sheet = await armSign();
    if (sheet && typeof sheet === 'object') {
      C(`${tag} 3 sign: no tip while the signature sheet is open`, !(await anyTip()), '');
      await sheet.click();
      await input.waitFor(
        `![...document.querySelectorAll('[role="dialog"] input')].some((e) => e.getBoundingClientRect().width > 0)`,
        {
          what: 'sheet closed',
        },
      );
      await sleep(1500);
    }
    await waitTip('signClip', 12000);
    const m = await measure();
    C(`${tag} 3 sign: sign tip shows with its clip`, clipSrc(m, 'signClip', false) && m.alt.length > 0, `${m?.src}`);
    C(`${tag} 3 sign: card avoids inputs and the anchor`, m.over.length === 0, `over: ${m.over.join(',') || '-'}`);
    if (shot) await input.screenshot(`${SHOTS}/tip-signClip`);
  }

  async function casePages(tag, { shot = false } = {}) {
    await fresh();
    await open(TEXT);
    await mode('pages');
    await waitTip('pagesClip');
    const m = await measure();
    C(`${tag} 4 pages: pages tip shows with its clip`, clipSrc(m, 'pagesClip', false) && m.alt.length > 0, `${m?.src}`);
    C(`${tag} 4 pages: card avoids inputs and the anchor`, m.over.length === 0, `over: ${m.over.join(',') || '-'}`);
    if (shot) await input.screenshot(`${SHOTS}/tip-pagesClip`);
    await mode('read');
    await input
      .waitFor(`!document.querySelector('[data-surface="tip"]')`, { timeoutMs: 4000, what: 'pages tip gone' })
      .then(
        () => C(`${tag} 4 pages: leaving Seiten removes the tip`, true),
        (e) => C(`${tag} 4 pages: leaving Seiten removes the tip`, false, e.message),
      );
  }

  // ---- German (main) ----------------------------------------------------------------------------------------------------------
  await section('de 1', () => caseHighlight('de', { shot: true }));
  await section('de 2', () => caseForm('de', { shot: true }));
  await section('de 3', () => caseSign('de', { shot: true }));
  await section('de 4', () => casePages('de', { shot: true }));

  // 5. once per session
  await section('de 5', async () => {
    await fresh();
    await open(TEXT);
    await mode('pages');
    await waitTip('pagesClip');
    await dismiss();
    C(
      'de 5 once: tipsSeen contains pages after the dismiss',
      (await seen()).includes('pagesClip'),
      (await seen()).join(','),
    );
    await mode('read');
    await mode('pages');
    C('de 5 once: re-entering Seiten in the session shows nothing', await stayQuiet(), (await tipIds()).join(','));
    await mode('read');
    // reload (new session): the id is in tipsSeen, so it stays quiet as well
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === 'de'`, { timeoutMs: 20000, what: 'UI language' });
    await open(TEXT);
    await mode('pages');
    C('de 5 once: a new session does not show it again (seen ever)', await stayQuiet(), (await tipIds()).join(','));
  });

  // 6. switch off
  await section('de 6', async () => {
    await fresh();
    await open(TEXT);
    C('de 6 off: the toggle turns tips off in Settings', await setTipsSwitch(false), '');
    await closeSettings();
    await mode('comment');
    await tool('highlight');
    const a = await stayQuiet(2500);
    await armSign({ answer: false });
    const b = await stayQuiet(2500);
    await mode('pages');
    const c = await stayQuiet(2500);
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === 'de'`, { timeoutMs: 20000, what: 'UI language' });
    await open(FORM);
    const d = await stayQuiet(5000);
    C(
      'de 6 off: highlight, sign, pages and form show no tip',
      a && b && c && d,
      `highlight ${a}, sign ${b}, pages ${c}, form ${d}`,
    );
    C('de 6 off: tipsSeen stays empty', (await seen()).length === 0, (await seen()).join(','));
    // Settings: reset disabled while off
    await openSettings();
    const disabled = await ev(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${q(T.reset)} && (b.disabled || b.getAttribute('aria-disabled') === 'true'))`,
    );
    C('de 6 off: "Show tips again" is disabled while tips are off', disabled, '');
    await closeSettings();
    // on again: the pages tip resumes
    await ev('location.reload()').catch(() => {});
    await sleep(2000);
    await input.waitFor(`document.documentElement.lang === 'de'`, { timeoutMs: 20000, what: 'UI language' });
    await open(TEXT);
    C('de 6 on: the toggle turns tips on again', await setTipsSwitch(true), '');
    await closeSettings();
    await mode('pages');
    await waitTip('pagesClip').then(
      () => C('de 6 on: unseen tips resume (pages tip shows)', true),
      (e) => C('de 6 on: unseen tips resume (pages tip shows)', false, e.message),
    );
    await dismiss();
    C('de 6 on: tipsSeen now holds pages', (await seen()).includes('pagesClip'), (await seen()).join(','));
    await openSettings();
    await input.click({ text: T.reset, selector: 'button' });
    await sleep(800);
    C('de 6 on: "Show tips again" re-arms (tipsSeen empty)', (await seen()).length === 0, (await seen()).join(','));
    await closeSettings();
  });

  // 7. reduced motion: poster, no Replay
  await section('de 7', async () => {
    await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      await fresh();
      await open(TEXT);
      await mode('comment');
      await tool('highlight');
      await waitTip('highlightClip');
      const m = await measure();
      C('de 7 reduced motion: the tip shows the poster', clipSrc(m, 'highlightClip', true), `${m?.src}`);
      C('de 7 reduced motion: no Replay button (only Hide)', m.buttons === 1, `${m.buttons} buttons`);
    } finally {
      await s.send('Emulation.setEmulatedMedia', { features: [] });
    }
  });

  // 8. 960 x 640
  await section('de 8', async () => {
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 960,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      const check = async (id, m) =>
        C(
          `de 8 960x640 ${id}: card fits (no overflow, inside the canvas, avoids fields)`,
          m && !m.overflow && m.inside === true && m.over.length === 0 && m.rect.r - m.rect.l <= 960,
          m
            ? `w ${Math.round(m.rect.r - m.rect.l)} h ${Math.round(m.rect.b - m.rect.t)}; overflow ${m.overflow}; inside ${m.inside} card ${JSON.stringify(m.rect)} canvas ${JSON.stringify(m.canvasRect)}; over ${m.over.join(',') || '-'}`
            : 'no card',
        );
      await fresh();
      await open(TEXT);
      await mode('comment');
      await tool('highlight');
      await waitTip('highlightClip');
      await check('highlight', await measure());
      await mode('pages');
      await waitTip('pagesClip', 15000).catch(() => {});
      await check('pages', await measure());
      await fresh();
      await open(TEXT);
      const sheet = await armSign();
      if (sheet && typeof sheet === 'object') {
        await sheet.click();
        await sleep(2000);
      }
      await waitTip('signClip', 15000).catch(() => {});
      await check('sign', await measure());
      await fresh();
      await open(FORM);
      await waitTip('formClip', 15000).catch(() => {});
      await check('form', await measure());
    } finally {
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: s.vp?.w ?? 1280,
        height: s.vp?.h ?? 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  });

  // ---- English once ------------------------------------------------------------------------------------------------------------
  lang = 'en';
  T = STRINGS.en;
  await section('en 1', () => caseHighlight('en'));
  await section('en 2', () => caseForm('en'));
  await section('en 3', () => caseSign('en'));
  await section('en 4', () => casePages('en'));

  const err = await ctx.dialogs.lastError();
  if (err) C('no automation error', false, JSON.stringify(err));
};

const code = await runSession(session, results);
results.table();
process.exit(code || results.failed() ? 1 : 0);
