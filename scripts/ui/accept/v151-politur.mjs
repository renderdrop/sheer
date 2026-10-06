// Acceptance Politur v1.5.1 (ADR-132 (1) to (4)): Umbrechen default, paragraph edge, refusal tooltip, focus ring growth.
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v151-politur.mjs   (UI language German)
// Every edit is escaped; nothing is saved (the save status is checked at the end).
import { createResults, runSession, openAndWait, sleep } from './harness.mjs';
import { corpusFile, corpusProbe } from './corpus.mjs';

const E4 = corpusFile('owner-pdf-E4');
const INVOICE = corpusFile('corpus-05');
const ADDRESS = corpusProbe('corpus-05/address-line');
const q = (s) => JSON.stringify(s);

const results = createResults();
const { check } = results;

async function enterEditMode({ input, ev }) {
  await input.click({ role: 'tab', text: 'Bearbeiten' });
  await sleep(400);
  await input.click({ text: 'Text bearbeiten' });
  await sleep(600);
}

const rect = (ev, selector) =>
  ev(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);

/** Escape until the box is gone (the first Escape in the bar only returns focus to the box); then nothing is committed. */
async function cancelEdit({ input, ev }) {
  for (let i = 0; i < 4; i++) {
    if (!(await ev(`!!document.querySelector('[data-textedit-box]')`))) return true;
    await input.press('Escape');
    await sleep(500);
  }
  return !(await ev(`!!document.querySelector('[data-textedit-box]')`));
}

/** The text-layer span whose text contains `text`: scrolled into view, rect returned. */
const lineRect = (input, ev, text) =>
  input.waitForTarget({ text }, { timeoutMs: 30000 }).then(() => input.rectOf({ text }));

// --- E4 -------------------------------------------------------------------------------------------------------------------
await runSession(async ({ input, dialogs, ev, shot }) => {
  const C = (n, ok, d) => check(`E4: ${n}`, ok, d);
  await openAndWait({ input, dialogs }, E4);
  await shot('v151/e4-00-opened');
  await enterEditMode({ input, ev });
  const LINE = 'Kommunalordnung - ThürKO) i.d.F. der Neubekanntmachung vom 14. April 1998';
  // find a distinctive part of the line in the text layer (wrapped lines may split into several spans)
  const probe = 'Neubekanntmachung vom 14. April 1998';
  await input.waitForTarget({ text: probe }, { timeoutMs: 30000 });
  await input.click({ text: probe });
  await input
    .waitFor(`!!document.querySelector('[data-textedit-box]')`, { timeoutMs: 8000, what: 'edit box' })
    .catch(() => {});
  const opened = await ev(`!!document.querySelector('[data-textedit-box]')`);
  C(`line "${LINE.slice(0, 30)}..." opens the edit box`, opened, '');
  await shot('v151/e4-01-box-open');
  if (!opened) return;

  const sw = () =>
    ev(`(() => { const s = document.querySelector('[data-surface="textedit-bar"] [role="switch"]');
      return s ? { checked: s.getAttribute('aria-checked') } : null; })()`);
  const s0 = await sw();
  C('Umbrechen toggle present and pressed by default', s0?.checked === 'true', JSON.stringify(s0));

  await input.press('End');
  await input.insertText(' im Freistaat');
  await sleep(900);
  await shot('v151/e4-02-typed-reflow-on');
  const noOverflowOn = await ev(
    `!/pt zu breit/.test(document.querySelector('[data-surface="textedit-bar"]')?.textContent ?? '')`,
  );
  C('typed " im Freistaat" with Umbrechen on: no overflow caption', noOverflowOn, '');

  await input.click({ selector: '[data-surface="textedit-bar"] [role="switch"]' });
  await sleep(1200);
  const s1 = await sw();
  C('Umbrechen switched off', s1?.checked === 'false', JSON.stringify(s1));
  const caption = await ev(
    `(document.querySelector('[data-surface="textedit-bar"]')?.textContent ?? '').match(/([\\d.,]+)\\s*pt zu breit/)?.[1] ?? null`,
  );
  const pt = caption === null ? null : Number(String(caption).replace(',', '.'));
  C(
    'overflow caption shows tens of pt (not 1 pt)',
    pt !== null && pt >= 10,
    `caption: ${caption === null ? 'none' : caption + ' pt zu breit'}`,
  );
  await shot('v151/e4-03-reflow-off');

  // the box stops at the paragraph edge: the hatch starts where the paragraph ends; the ring never passes it
  const geo = await ev(`(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
    const ring = r('[data-textedit-ring]'), hatch = r('[data-textedit-hatch]'), box = r('[data-textedit-box]');
    const page = document.querySelector('[data-textedit-box]')?.closest('[data-page]')?.getBoundingClientRect();
    // the paragraph's inner lines: text-layer spans in the same page, right edges, within 120 px above/below the box
    const spans = [...(document.querySelector('[data-textedit-box]')?.closest('[data-page]')?.querySelectorAll('span,div') ?? [])]
      .filter((e) => e.children.length === 0 && (e.textContent ?? '').trim().length > 20)
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width > 0 && Math.abs(b.top - (box?.top ?? 0)) < 130 && Math.abs(b.top - (box?.top ?? 0)) > 3);
    const edges = spans.map((b) => b.right).sort((a, b) => a - b);
    return { ring, hatch, box, pageRight: page?.right ?? null, paraRight: edges.length ? edges[Math.floor(edges.length * 0.75)] : null, n: edges.length };
  })()`);
  C('hatch present (overflow past the paragraph edge)', !!geo.hatch, JSON.stringify(geo.hatch));
  if (geo.hatch && geo.ring) {
    C(
      'ring stops at the paragraph edge (ring right <= hatch left)',
      geo.ring.right <= geo.hatch.left + 1.5,
      `ring right ${geo.ring.right.toFixed(1)}, hatch left ${geo.hatch.left.toFixed(1)}`,
    );
    if (geo.paraRight !== null)
      C(
        'hatch starts at the paragraph edge (inner-line right edge)',
        Math.abs(geo.hatch.left - geo.paraRight) <= 8,
        `hatch left ${geo.hatch.left.toFixed(1)} vs inner lines right ${geo.paraRight.toFixed(1)} (${geo.n} lines)`,
      );
    C(
      'hatch stays inside the page',
      geo.pageRight === null || geo.hatch.right <= geo.pageRight + 1,
      `hatch right ${geo.hatch.right.toFixed(1)}, page right ${geo.pageRight}`,
    );
  }
  C('Escape closes the box without committing', await cancelEdit({ input, ev }), '');

  // Präambel: a refusal tooltip instead of a box
  const PRE = 'Der derzeit dringendste Handlungsbedarf';
  await ev(`document.querySelector('[data-action-scope="canvas"] > [role="region"]').scrollTop = 0`);
  await sleep(600);
  await input.waitForTarget({ text: PRE }, { timeoutMs: 15000 }).catch(() => {});
  const found = await ev(
    `[...document.querySelectorAll('[data-page] *')].some((e) => e.children.length === 0 && (e.textContent ?? '').includes(${q(PRE)}))`,
  );
  C('Präambel line found in the text layer', found, '');
  if (found) {
    await input.hover({ text: PRE });
    await sleep(500);
    await input.click({ text: PRE });
    await input
      .waitFor(`!!document.querySelector('[data-textedit-box]')`, { timeoutMs: 8000, what: 'edit box' })
      .catch(() => {});
    const box = await ev(`!!document.querySelector('[data-textedit-box]')`);
    const bar = await ev(`!!document.querySelector('[data-surface="textedit-bar"]')`);
    const sw = await ev(`(() => { const s = document.querySelector('[data-surface="textedit-bar"] [role="switch"]');
      return s ? { checked: s.getAttribute('aria-checked'), disabled: s.disabled || s.getAttribute('aria-disabled') === 'true', title: s.title || s.getAttribute('title') } : null; })()`);
    C('Präambel: edit box and mini bar open', box && bar, `box=${box} bar=${bar}`);
    await input.press('End');
    await input.insertText(' x');
    await sleep(1500);
    const pic = await ev(`!!document.querySelector('[data-textedit-preview]')`);
    const err = await ev(
      `document.querySelector('[data-surface="textedit-bar"] [role="status"], [data-surface="textedit-bar"] [role="alert"]')?.textContent ?? null`,
    );
    await shot('v151/e4-04-preamble');
    C(
      'Präambel: real-font preview arrives after typing (or a refusal state is shown)',
      pic || !!err,
      `preview=${pic} caption=${err} switch=${JSON.stringify(sw)}`,
    );
  }
  await cancelEdit({ input, ev });
  const save = await ev(`document.querySelector('[data-save-status]')?.getAttribute('data-save-status')`);
  C('nothing saved ("Gespeichert")', save === 'saved', `data-save-status=${save}`);
}, results);

// --- invoice -------------------------------------------------------------------------------------------------------------
await runSession(async ({ input, dialogs, ev, shot }) => {
  const C = (n, ok, d) => check(`invoice: ${n}`, ok, d);
  await openAndWait({ input, dialogs }, INVOICE);
  await enterEditMode({ input, ev });
  await input.waitForTarget({ text: ADDRESS }, { timeoutMs: 30000 });
  await input.click({ text: ADDRESS });
  await input
    .waitFor(`!!document.querySelector('[data-textedit-box]')`, { timeoutMs: 8000, what: 'edit box' })
    .catch(() => {});
  C('the address line opens the edit box', await ev(`!!document.querySelector('[data-textedit-box]')`), '');
  await input.press('End');
  await input.insertText('-Mitte');
  await sleep(1200);
  await shot('v151/invoice-01-typed');
  const g = await ev(`(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right }; };
    const img = document.querySelector('[data-textedit-preview]');
    let ink = null;
    if (img && img.naturalWidth > 0) {
      try {
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const dark = (i) => d[i + 3] > 40 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 200;
        let min = c.width;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < min; x++) if (dark((y * c.width + x) * 4)) { min = x; break; }
        const b = img.getBoundingClientRect();
        if (min < c.width) ink = b.left + (min / c.width) * b.width;
      } catch (e) { ink = null; }
    }
    return { ring: r('[data-textedit-ring]'), preview: r('[data-textedit-preview]'), ink, align: document.querySelector('[data-textedit-box]')?.dataset.align ?? null };
  })()`);
  C('focus ring and preview present', !!g.ring && !!g.preview, JSON.stringify(g));
  if (g.ring && g.preview) {
    const inkLeft = g.ink ?? g.preview.left;
    C(
      'focus ring left <= preview ink left (grows left)',
      g.ring.left <= inkLeft + 1,
      `ring left ${g.ring.left.toFixed(1)}, preview ink left ${inkLeft.toFixed(1)}${g.ink === null ? ' (frame edge; ink unreadable)' : ''}, align ${g.align}`,
    );
  }
  await cancelEdit({ input, ev });
  const save = await ev(`document.querySelector('[data-save-status]')?.getAttribute('data-save-status')`);
  C('nothing saved ("Gespeichert")', save === 'saved', `data-save-status=${save}`);
  await shot('v151/invoice-02-escaped');
}, results);

results.table();
process.exit(results.failed() ? 1 : 0);
