// Acceptance v1.6 "Smart links" (ADR-131, DESIGN 3.11 L-AC 1-14 as far as the acceptance build can drive them).
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v16-smartlinks.mjs   (UI language German)
// Per file: open, scan pages for links, hover/click/Back/forward on one footnote and one contents link, keyboard, toggles, modes.
import {
  SCROLLER,
  createResults,
  runSession,
  installInvokeCounter,
  callCount,
  openAndWait,
  sleep,
} from './harness.mjs';
import { lumRange, readPng } from './png.mjs';
import { corpusFile } from './corpus.mjs';

const FILES = [
  ['ausf', corpusFile('corpus-12')],
  ['einzel', corpusFile('corpus-21')],
  ['bim', corpusFile('corpus-08')],
];
const LINK = '[data-links-list] [data-smartlink]';
const q = (s) => JSON.stringify(s);
const sel = (l) => `[data-links-page="${l.page - 1}"] [data-link-key=${q(l.key.replace(/"/g, '\\"'))}]`;

const results = createResults();
const { check } = results;

for (const [tag, file] of FILES) {
  await runSession(async ({ input, dialogs, ev, shot }) => {
    const C = (name, ok, detail) => check(`${tag}: ${name}`, ok, detail);
    const state = (pageNo) =>
      ev(`(() => {
        const s = document.querySelector(${q(SCROLLER)});
        const p = document.querySelector('[data-page="${pageNo}"]');
        return { top: s.scrollTop, left: s.scrollLeft,
          w: p ? p.getBoundingClientRect().width : null,
          zoom: document.querySelector('[data-toolbar-item="zoom-in"]')?.getAttribute('aria-label') ?? null,
          save: document.querySelector('[data-save-status]')?.getAttribute('data-save-status') ?? null };
      })()`);
    const same = (a, b) =>
      a.top === b.top && a.left === b.left && a.zoom === b.zoom && (a.w === null || b.w === null || a.w === b.w);
    const fmt = (s) => `top=${s.top} left=${s.left} zoom=${s.zoom} w=${s.w}`;
    const links = () =>
      ev(`(() => { const sc = document.querySelector(${q(SCROLLER)}); return [...document.querySelectorAll(${q(LINK)})].map((e) => ({
        key: e.dataset.linkKey, kind: e.dataset.linkKind, label: e.getAttribute('aria-label'),
        page: Number(e.closest('[data-links-list]').dataset.linksPage) + 1,
        // absolute offset in the scroller, to scroll back to it (pages far away are not in the DOM)
        y: e.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop })); })()`);
    const reveal = async (l) => {
      await ev(`document.querySelector(${q(SCROLLER)}).scrollTop = ${Math.max(0, Math.round(l.y - 300))}`);
      await input
        .waitFor(`!!document.querySelector(${q(sel(l))})`, { timeoutMs: 15000, what: `link ${l.page}` })
        .catch(() => {});
      return ev(`!!document.querySelector(${q(sel(l))})`);
    };
    const bandPage = `document.querySelector('[data-history-mark]')?.closest('[data-page]')?.dataset.page ?? ''`;

    await openAndWait({ input, dialogs }, file);
    await installInvokeCounter(ev);
    await input.sleep(500);
    await shot(`v160/${tag}-00-opened`);

    // Scan: scroll down page by page; links appear only on rendered pages (L-AC 12).
    const seen = new Map();
    const kinds = {};
    const pagesWith = {};
    for (let i = 0; i < 140; i++) {
      for (const l of await links()) {
        const id = `${l.page}:${l.key}`;
        if (seen.has(id)) continue;
        seen.set(id, l);
        kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
        (pagesWith[l.kind] ??= new Set()).add(l.page);
      }
      if (i > 6 && pagesWith.contents && pagesWith.footnote) break;
      const more = await ev(`(() => { const s = document.querySelector(${q(SCROLLER)}); const b = s.scrollTop;
        s.scrollTop += s.clientHeight * 0.8; return s.scrollTop > b; })()`);
      if (!more) break;
      await sleep(300);
    }
    C(
      'links detected (count per kind, DOM layer)',
      Object.keys(kinds).length > 0,
      `${JSON.stringify(kinds)}; contents pages ${[...(pagesWith.contents ?? [])].join(',') || '-'}; footnote pages ${[...(pagesWith.footnote ?? [])].join(',') || '-'}`,
    );
    const all = [...seen.values()];
    await ev(`document.querySelector(${q(SCROLLER)}).scrollTop = 0`);
    await sleep(500);

    // Jump experiment on one link of a kind.
    const experiment = async (kind) => {
      const pick = all.find((l) => l.kind === kind);
      if (!pick) return C(`${kind}: link found`, false, 'none detected on the scanned pages');
      const K = `${kind} p${pick.page}`;
      if (!(await reveal(pick))) return C(`${K}: link rendered again`, false, pick.label);
      await ev(`document.querySelector(${q(sel(pick))}).scrollIntoView({ block: 'center' })`);
      await sleep(400);
      const s0 = await state(pick.page);
      const run = `${sel(pick)} [data-smartlink-run]`;
      // hover -> preview
      await input.hover({ selector: run });
      const preview = await input
        .waitFor(`document.querySelector('[data-link-preview]')?.textContent || ''`, {
          timeoutMs: 4000,
          what: 'preview',
        })
        .catch(() => '');
      const kindWord = { footnote: 'Fußnote', contents: 'Inhalt' }[kind];
      C(
        `${K}: hover preview shows Erkannt, kind, page`,
        /Erkannt/.test(preview) && preview.includes(kindWord) && /S\./.test(preview),
        preview.slice(0, 160),
      );
      await sleep(400); // the fill's transition has ended
      const hoverShot = await shot(`v160/${tag}-${kind}-01-hover`);
      // L4: the hover fill multiplies, so glyph pixels under it stay dark (an opaque fill makes the run a flat grey band)
      const box =
        await ev(`(() => { const r = document.querySelector(${q(run)}).getBoundingClientRect(); const d = devicePixelRatio;
        return { left: r.left * d, top: r.top * d, right: r.right * d, bottom: r.bottom * d }; })()`);
      const range = lumRange(readPng(hoverShot), box);
      C(
        `${K}: hovered glyph pixels stay dark under the fill`,
        range.min < 140 && range.max > range.min + 60,
        `luminance min ${range.min.toFixed(0)} max ${range.max.toFixed(0)}`,
      );
      // target page from the preview: the physical page when the label differs
      const head = await ev(`document.querySelector('[data-link-preview] .t-caption')?.textContent ?? ''`);
      if (kind === 'contents') {
        // the printed page first, the file's page in parentheses when they differ (DESIGN 3.11 "Page numbers")
        C(
          `${K}: preview names the printed page`,
          /S\. \S+/.test(head) && !/S\. (\d+) \(Seite \1 der Datei\)/.test(head),
          head,
        );
        if (tag === 'einzel')
          C(
            `${K}: preview reads "S. 1" and "Seite 13 der Datei"`,
            /S\. 1 /.test(head) && /Seite 13 der Datei/.test(head),
            head,
          );
      }
      const m = head.match(/\(Seite (\d+) der Datei\)/) ?? head.match(/S\.\s*(\d+)/);
      const target = m ? Number(m[1]) : null;
      // click -> target reached, band
      await input.click({ selector: run });
      const band = await input.waitFor(bandPage, { timeoutMs: 6000, what: 'band' }).catch(() => '');
      await sleep(300);
      const s1 = await state(Number(band) || pick.page);
      const inView = await ev(`(() => { const p = document.querySelector('[data-page="${band}"]'); if (!p) return false;
        const r = p.getBoundingClientRect(), s = document.querySelector(${q(SCROLLER)}).getBoundingClientRect();
        return r.bottom > s.top && r.top < s.bottom; })()`);
      C(
        `${K}: click reaches target page${target ? ' ' + target : ''}`,
        band !== '' && inView && (target === null || Number(band) === target),
        `band on page ${band || 'none'}, expected ${target ?? '?'}, scroll ${s0.top} -> ${s1.top}`,
      );
      C(`${K}: band visible`, !!(await ev(`!!document.querySelector('[data-history-mark]')`)), '');
      await shot(`v160/${tag}-${kind}-02-clicked`);
      // Back via Alt+Left
      await input.press('ArrowLeft', { alt: true });
      await sleep(900);
      const sb = await state(pick.page);
      C(`${K}: Alt+Left restores scroll and zoom exactly`, same(s0, sb), `before ${fmt(s0)} | after ${fmt(sb)}`);
      await shot(`v160/${tag}-${kind}-03-back`);
      // forward Alt+Right
      await input.press('ArrowRight', { alt: true });
      await sleep(900);
      const sf = await state(Number(band) || pick.page);
      C(
        `${K}: Alt+Right goes forward again`,
        Math.abs(sf.top - s1.top) <= 1 && sf.zoom === s1.zoom,
        `jumped ${fmt(s1)} | forward ${fmt(sf)}`,
      );
      await shot(`v160/${tag}-${kind}-04-forward`);
      // Back via the control
      const label = await ev(
        `document.querySelector('[data-toolbar-item="history-back"]')?.getAttribute('aria-label')`,
      );
      await input.click({ selector: '[data-toolbar-item="history-back"]' });
      await sleep(900);
      const sc = await state(pick.page);
      C(
        `${K}: Back control restores scroll and zoom exactly`,
        same(s0, sc),
        `control "${label}" | before ${fmt(s0)} | after ${fmt(sc)}`,
      );
      await shot(`v160/${tag}-${kind}-05-back-control`);
      return pick;
    };
    const fn = await experiment('footnote');
    const toc = await experiment('contents');

    // Keyboard: Tab to a page's link list, ArrowDown, Enter (L-AC 11)
    const kpick = toc ?? fn;
    if (kpick) {
      await reveal(kpick);
      await ev(`document.querySelector(${q(sel(kpick))})?.scrollIntoView({ block: 'center' })`);
      await sleep(400);
      const s0 = await state(kpick.page);
      await ev(`document.querySelector(${q(SCROLLER)}).focus({ preventScroll: true })`);
      let got = false;
      for (let i = 0; i < 80 && !got; i++) {
        await input.press('Tab');
        got = await ev(`document.activeElement?.matches?.('[data-links-list] [role="link"]') ?? false`);
      }
      const first = await ev(`document.activeElement?.getAttribute('aria-label') ?? null`);
      C('keyboard: Tab reaches a link list', got, first ?? 'no link focused');
      if (got) {
        await sleep(600);
        await shot(`v160/${tag}-06-keyboard-tab`);
        await input.press('ArrowDown');
        const second = await ev(`document.activeElement?.getAttribute('aria-label') ?? null`);
        const count = await ev(
          `document.activeElement.closest('[data-links-list]')?.querySelectorAll('[role="link"]').length ?? 0`,
        );
        C(
          'keyboard: ArrowDown moves to the next link',
          count < 2 || second !== first,
          `${first} -> ${second} (${count} in list)`,
        );
        await shot(`v160/${tag}-07-keyboard-arrow`);
        await ev(`document.querySelector('[data-history-mark]')?.remove()`);
        const topBefore = (await state(kpick.page)).top;
        await input.press('Enter');
        const band = await input.waitFor(bandPage, { timeoutMs: 6000, what: 'band after Enter' }).catch(() => '');
        await sleep(500);
        const topAfter = (await state(kpick.page)).top;
        C(
          'keyboard: Enter follows the link',
          band !== '',
          `band page ${band || 'none'}, scroll ${topBefore} -> ${topAfter}`,
        );
        await shot(`v160/${tag}-08-keyboard-enter`);
        await input.press('ArrowLeft', { alt: true });
        await sleep(800);
        const sb = await state(kpick.page);
        C(
          'keyboard: Alt+Left after Enter returns to the list position',
          Math.abs(sb.top - topBefore) <= 1,
          `before Enter top=${topBefore} (start ${s0.top}) | after Back ${fmt(sb)}`,
        );
      }
    }

    // Toggle off / on (L-AC 9)
    if (kpick) await reveal(kpick);
    await ev(`document.querySelector(${q(SCROLLER)}).focus({ preventScroll: true })`);
    const before = await ev(`document.querySelectorAll(${q(LINK)}).length`);
    const toggleInfo = await ev(
      `(() => { const b = [...document.querySelectorAll('button,[role="button"],[role="switch"]')].find((e) => ((e.getAttribute('aria-label') ?? '') + e.textContent).includes('Smarte Links')); return b ? { pressed: b.getAttribute('aria-pressed'), tag: b.tagName, role: b.getAttribute('role') } : null; })()`,
    );
    C('Lesen toggle "Smarte Links" present', !!toggleInfo, JSON.stringify(toggleInfo));
    if (toggleInfo) {
      const tsel = { selector: toggleInfo.role ? `[role="${toggleInfo.role}"]` : 'button', text: 'Smarte Links' };
      await input.click(tsel);
      await sleep(900);
      const n0 = await callCount(ev, 'smart_links');
      const off = await ev(`document.querySelectorAll(${q(LINK)}).length`);
      await ev(`document.querySelector(${q(SCROLLER)}).scrollTop += 600`);
      await sleep(1500);
      const n1 = await callCount(ev, 'smart_links');
      C('toggle off: layer gone', off === 0 && before > 0, `smart links ${before} -> ${off}`);
      C('toggle off: no smart_links fetches while scrolling', n1 === n0, `calls ${n0} -> ${n1}`);
      await shot(`v160/${tag}-09-toggle-off`);
      await input.click(tsel);
      await input
        .waitFor(`document.querySelectorAll(${q(LINK)}).length > 0`, { timeoutMs: 15000, what: 'links back' })
        .catch(() => {});
      const on = await ev(`document.querySelectorAll(${q(LINK)}).length`);
      C('toggle on: links back', on > 0, `${on} smart links in the DOM`);
      await shot(`v160/${tag}-10-toggle-on`);
    }

    // Kommentieren -> Hervorheben: no links (L-AC 10)
    await input.click({ role: 'tab', text: 'Kommentieren' });
    await sleep(500);
    await input.click({ text: 'Hervorheben' });
    await sleep(900);
    const live = await ev(`document.querySelectorAll('[data-link-key]').length`);
    C('Hervorheben: no links drawn', live === 0, `${live} link elements`);
    await shot(`v160/${tag}-11-highlight`);
    await input.press('Escape');
    await input.click({ role: 'tab', text: 'Lesen' });
    await sleep(500);

    // Nothing was written (L-AC 8)
    const save = (await state(1)).save;
    C('save status stays "Gespeichert" after following links', save === 'saved', `data-save-status=${save}`);
    await shot(`v160/${tag}-12-final`);
    const err = await dialogs.lastError();
    if (err) C('no automation error', false, JSON.stringify(err));
  }, results);
}

results.table();
process.exit(results.failed() ? 1 : 0);
