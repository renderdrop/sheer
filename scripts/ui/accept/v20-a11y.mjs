// Acceptance v2.0 accessibility pass (ADR-140 section 4) in the acceptance build, on tests/fixtures/text.pdf (a copy) only.
// "What Narrator reads" = the Chromium accessibility tree WebView2 exposes through UI Automation, fetched over CDP.
//   (a) Accessibility.getFullAXTree on every screen: focusable/interactive nodes have a role and a non-empty name; checkable roles
//       expose checked, popup triggers expanded, tabs selected; dialogs are named and modal; the toast region is a live region.
//   (b) axe-core (node_modules/axe-core/axe.min.js, full default rule set incl. color-contrast) per screen, in light AND dark
//       (prefers-color-scheme emulation; the app ships light only, so dark is expected to equal light).
//   (c) keyboard only, per mode: Tab reaches every toolbar control (roving composites count when a member is reached), a focus
//       indicator is visible on every Tab stop, Esc closes every popover/dialog and focus returns to its opener.
// Screens: the five modes (src/stores/ui.ts MODES) with every popover trigger (aria-haspopup, as the surface gate sweeps them)
// and every menu-bar item that opens a dialog or popover. Items that leave the document, save, print or open native dialogs are skipped.
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/v20-a11y.mjs   (German UI)
// Env: V20_A11Y_THEMES=light,dark  V20_A11Y_ONLY=<substring of a screen name>  V20_A11Y_NO_MENUS=1
// Output: table + review/a11y-v20.json. Exit 1 on any violation.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createResults, runSession, openAndWait, sleep } from './harness.mjs';
import { auditAxNodes, hasFocusIndicator, rollUp, SKIP_ITEM, summariseAxe, unreachable } from './v20-pure.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/generated/a11y');
const JSON_OUT = resolve(ROOT, 'review/a11y-v20.json');
const AXE_SRC = resolve(ROOT, 'node_modules/axe-core/axe.min.js');
const MODES = ['read', 'comment', 'fill', 'pages', 'edit']; // src/stores/ui.ts MODES
const THEMES = (process.env.V20_A11Y_THEMES ?? 'light,dark').split(',');
const ONLY = process.env.V20_A11Y_ONLY ?? '';
const q = (s) => JSON.stringify(s);

mkdirSync(OUT, { recursive: true });
const DOC = join(OUT, `a11y-${Date.now().toString(36)}.pdf`);
copyFileSync(resolve(ROOT, 'tests/fixtures/text.pdf'), DOC);
const AXE = readFileSync(AXE_SRC, 'utf8');

const results = createResults();
const { check: C } = results;
const report = { run: new Date().toISOString(), themes: {}, keyboard: {}, note: '' };

/** Runs inside the page: surface tracking, DOM-level checks. Installed after every reload. */
const PAGE = `(() => {
  if (window.__a11y) return true;
  const SURF = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-minibar],[data-tour-card],[data-surface]:not([role="tooltip"]):not([data-surface="ocr-banner"])';
  const visible = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const shown = () => [...document.querySelectorAll(SURF)].filter(visible);
  const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  window.__a11y = {
    visible, label,
    mark() { window.__a11yBefore = new Set(shown()); },
    fresh() { const all = shown().filter((e) => !window.__a11yBefore.has(e)); return all.filter((e) => !all.some((o) => o !== e && o.contains(e))); },
    popupCount() { return this.fresh().filter((e) => e.matches('[role="dialog"],[role="alertdialog"],[role="menu"],[data-minibar],[data-tour-card]')).length; },
    freshDesc() { return this.fresh().map((e) => (e.getAttribute('role') || '') + '/' + (e.getAttribute('data-surface') || e.tagName.toLowerCase())).join(','); },
    freshCount() { return this.fresh().length; },
    dialogs() { return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).map((d) => ({ label: label(d), modal: d.getAttribute('aria-modal') === 'true' })); },
    // Toggles, state and live region on the DOM level (what the AX tree cannot say about an attribute that is simply missing).
    dom() {
      const out = [];
      const STATE = ['aria-pressed', 'aria-checked', 'aria-selected', 'aria-current', 'aria-expanded'];
      for (const e of document.querySelectorAll('[data-mode],button[data-active],button[data-state="on"],button[data-pressed],[data-toggle]')) {
        if (!visible(e) || e.closest('[inert],[aria-hidden="true"]')) continue;
        if (!STATE.some((a) => e.hasAttribute(a))) out.push({ rule: 'toggle-state', role: e.getAttribute('role') || e.tagName.toLowerCase(), name: label(e) });
      }
      for (const e of document.querySelectorAll('[aria-haspopup]:not([aria-haspopup="false"])')) {
        if (!visible(e) || e.closest('[inert],[aria-hidden="true"]') || e.disabled) continue;
        if (!e.hasAttribute('aria-expanded')) out.push({ rule: 'expanded', role: e.getAttribute('role') || 'button', name: label(e) });
      }
      const live = document.querySelector('[role="status"],[aria-live="polite"],[aria-live="assertive"],[role="alert"]');
      if (!live) out.push({ rule: 'toast-live', role: 'status', name: 'no live region in the document' });
      return out;
    },
    triggers() {
      document.querySelectorAll('[data-a11y-trig]').forEach((e) => e.removeAttribute('data-a11y-trig'));
      const inSurf = (t) => !!t.closest(SURF);
      return [...document.querySelectorAll('[aria-haspopup]:not([aria-haspopup="false"])')].filter((t) => visible(t) && !inSurf(t) && !t.closest('[inert],[aria-hidden="true"]')).map((t, i) => {
        t.setAttribute('data-a11y-trig', String(i));
        return { i, name: label(t), off: !!t.disabled || t.getAttribute('aria-disabled') === 'true', menubar: !!t.closest('[role="menubar"]') };
      });
    },
    menuItems() {
      document.querySelectorAll('[data-a11y-item]').forEach((e) => e.removeAttribute('data-a11y-item'));
      return [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].filter(visible).map((e, i) => {
        e.setAttribute('data-a11y-item', String(i));
        return { i, name: label(e), off: e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('disabled'), sub: e.hasAttribute('aria-haspopup') && e.getAttribute('aria-haspopup') !== 'false' };
      });
    },
    focusInfo(opener) {
      const a = document.activeElement, o = opener ? document.querySelector(opener) : null;
      return { isBody: a === document.body || !a, inOpener: !!o && (a === o || o.contains(a)), inMenubar: !!a?.closest('[role="menubar"]'), active: a ? a.tagName.toLowerCase() + ' ' + label(a) : 'none' };
    },
  };
  return true;
})()`;

const session = async (ctx) => {
  const { input, ev, session: s } = ctx;
  const send = s.send;
  const tree = async () => (await send('Accessibility.getFullAXTree')).nodes;

  async function prepare() {
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
    await openAndWait(ctx, DOC);
    await ev(PAGE);
  }
  const ensure = async () => {
    await ev(PAGE);
    if (!(await ev('typeof window.axe === "object"'))) await send('Runtime.evaluate', { expression: AXE });
  };
  const setTheme = (theme) =>
    send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  const gone = async () => {
    for (let i = 0; i < 12; i++) {
      if ((await ev('window.__a11y.popupCount()')) === 0) return true;
      await sleep(100);
    }
    return false;
  };
  const mode = async (id) => {
    await input.press('Escape').catch(() => {});
    await input.click({ selector: `[data-mode="${id}"]` });
    await sleep(500);
  };

  /** Describes backend DOM nodes for the report (tag, id, aria-label, data-*). Best effort. */
  async function where(list) {
    for (const v of list.slice(0, 8)) {
      if (!v.backendDOMNodeId) continue;
      try {
        const { node } = await send('DOM.describeNode', { backendNodeId: v.backendDOMNodeId });
        const a = node.attributes ?? [];
        const keep = [];
        for (let i = 0; i < a.length; i += 2)
          if (/^(id|aria-label|role|data-[a-z-]+)$/.test(a[i])) keep.push(`${a[i]}=${String(a[i + 1]).slice(0, 40)}`);
        v.el = `${node.nodeName.toLowerCase()}[${keep.slice(0, 4).join(' ')}]`;
      } catch {
        /* node gone */
      }
    }
  }

  /** (a) + (b) of one screen in the current theme. */
  async function audit(name, theme, bag) {
    if (ONLY && !name.includes(ONLY)) return;
    await ensure();
    const violations = [];
    try {
      const dlg = await ev('window.__a11y.dialogs()');
      const nodes = await tree();
      const ax = auditAxNodes(nodes, { skipModal: dlg.length > 0 && dlg.every((d) => d.modal) });
      await where(ax);
      violations.push(...ax);
      // DOM-level duplicates of AX rules (expanded) are the same finding: keep one per name.
      for (const d of await ev('window.__a11y.dom()'))
        if (!violations.some((v) => v.rule === d.rule && v.name === d.name)) violations.push(d);
      const res = await ev(
        `axe.run(document, { resultTypes: ['violations', 'incomplete'] }).then((r) => JSON.parse(JSON.stringify({ violations: r.violations, incomplete: r.incomplete })))`,
      );
      const axe = summariseAxe(res);
      for (const v of axe.violations)
        violations.push({
          rule: `axe:${v.id}`,
          role: v.impact ?? '',
          name: v.help,
          nodes: v.nodes,
          el: v.targets.join(' | '),
        });
      bag.push({
        screen: name,
        theme,
        ok: violations.length === 0,
        violations,
        axeIncomplete: axe.incomplete,
        nodes: nodes.length,
      });
      C(
        `a11y ${theme} ${name}`,
        violations.length === 0,
        violations.length ? summary(violations) : `${nodes.length} AX nodes`,
      );
    } catch (e) {
      bag.push({ screen: name, theme, ok: false, violations: [{ rule: 'audit-error', role: '', name: e.message }] });
      C(`a11y ${theme} ${name}`, false, e.message);
    }
  }
  const summary = (vs) => {
    const by = {};
    for (const v of vs) by[v.rule] = (by[v.rule] ?? 0) + 1;
    return Object.entries(by)
      .map(([k, n]) => `${k} x${n}`)
      .join(', ');
  };

  /** Esc closes the open surface and focus returns to the opener: the (c) part for dialogs and popovers. */
  async function escapeCheck(name, theme, bag, opener, { menubarOk = false } = {}) {
    // The tour's finished step advances by itself 600 ms after it was done and shows the next card (by design): let it settle first.
    const touring = (await ev("!!document.querySelector('[data-tour-card]')")) === true;
    if (touring) await sleep(1500);
    await input.press('Escape');
    const closed = await gone();
    // A surface Esc does not close would pollute every later screen: reload to a clean window (the finding is recorded below).
    const stuck = !closed;
    await sleep(250);
    const f = await ev(`window.__a11y.focusInfo(${q(opener)})`);
    const back = f.inOpener || (menubarOk && (f.inMenubar || !f.isBody));
    const bad = [];
    if (!closed)
      bad.push({
        rule: 'esc-closes',
        role: '',
        name: `surface still open after Esc (${await ev('window.__a11y.freshDesc()')})`,
      });
    else if (!back) bad.push({ rule: 'focus-return', role: '', name: `focus is on ${f.active} instead of the opener` });
    // A tour that is still running (hidden by Esc, the pill stays) would change every later screen: start from a clean window.
    if (stuck || touring) await prepare().catch(() => {});
    else if (bad.length) await input.press('Escape').catch(() => {});
    bag.push({ screen: `${name} (Esc)`, theme, ok: bad.length === 0, violations: bad });
    C(`a11y ${theme} ${name}: Esc closes, focus returns`, bad.length === 0, bad[0]?.name ?? '');
  }

  /** Every popover trigger of the current mode. */
  async function sweepTriggers(modeId, theme, bag) {
    const trigs = (await ev('window.__a11y.triggers()')).filter((t) => !t.menubar);
    for (const t of trigs) {
      const name = `mode:${modeId}/${t.name || 'trigger ' + t.i}`;
      if (t.off || (ONLY && !name.includes(ONLY))) continue;
      const sel = `[data-a11y-trig="${t.i}"]`;
      try {
        await ev(`window.__a11y.mark()`);
        await input.click({ selector: sel });
        await sleep(500);
        if ((await ev('window.__a11y.freshCount()')) === 0) continue; // nothing opened (e.g. a toggle): nothing to audit
        const expanded = await ev(`document.querySelector(${q(sel)})?.getAttribute('aria-expanded')`);
        if (expanded === 'false') {
          bag.push({
            screen: name,
            theme,
            ok: false,
            violations: [{ rule: 'expanded', role: 'button', name: `${t.name}: aria-expanded is false while open` }],
          });
          C(`a11y ${theme} ${name}: aria-expanded while open`, false, 'false');
        }
        await audit(name, theme, bag);
        await escapeCheck(name, theme, bag, sel);
      } catch (e) {
        C(`a11y ${theme} ${name}`, false, e.message);
        await input.press('Escape').catch(() => {});
      }
    }
  }

  /** Every menu-bar menu, and the items that open a dialog or popover. */
  async function sweepMenus(theme, bag) {
    const tagTops = `[...document.querySelectorAll('[role="menubar"] [role="menuitem"]')].filter((e) => window.__a11y.visible(e)).map((e, i) => { e.setAttribute('data-a11y-top', String(i)); return window.__a11y.label(e); })`;
    const tops = await ev(tagTops);
    const openTop = async (i) => {
      // prepare() (after the welcome tour) reloads the page and drops the tags: set them again before every click.
      await ev(tagTops);
      await input.click({ selector: `[data-a11y-top="${i}"]` });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: `menu ${tops[i]}` });
      await sleep(250);
    };
    for (let i = 0; i < tops.length; i++) {
      const topName = `menu:${tops[i]}`;
      if (ONLY && !topName.includes(ONLY)) continue;
      try {
        await mode('read');
        await openTop(i);
        await audit(topName, theme, bag);
        const items = await ev('window.__a11y.menuItems()');
        await input.press('Escape');
        await sleep(250);
        for (const it of items) {
          const name = `${topName}/${it.name}`;
          if (it.off || it.sub || SKIP_ITEM.test(it.name) || (ONLY && !name.includes(ONLY))) continue;
          try {
            await mode('read');
            await openTop(i);
            await ev('window.__a11y.menuItems()');
            await ev(`window.__a11y.mark()`);
            // the menu itself is open now: it is "before", so only the surface the item opens counts as fresh
            await input.click({ selector: `[data-a11y-item="${it.i}"]` });
            await sleep(700);
            const n = await ev('window.__a11y.freshCount()');
            if (n > 0) {
              await audit(name, theme, bag);
              if ((await ev('window.__a11y.popupCount()')) === 0) await input.press('Escape').catch(() => {});
              else await escapeCheck(name, theme, bag, `[data-a11y-top="${i}"]`, { menubarOk: true });
            } else await input.press('Escape').catch(() => {});
          } catch (e) {
            C(`a11y ${theme} ${name}`, false, e.message);
            await input.press('Escape').catch(() => {});
          }
        }
      } catch (e) {
        C(`a11y ${theme} ${topName}`, false, e.message);
        await input.press('Escape').catch(() => {});
      }
    }
  }

  /** (c) keyboard-only pass of one mode: Tab through the whole window. */
  async function keyboardPass(modeId) {
    const name = `keyboard:${modeId}`;
    if (ONLY && !name.includes(ONLY)) return;
    await mode(modeId);
    await ensure();
    const controls = await ev(`(() => {
      document.querySelectorAll('[data-a11y-k],[data-a11y-c]').forEach((e) => { e.removeAttribute('data-a11y-k'); e.removeAttribute('data-a11y-c'); });
      const Q = '[role="toolbar"] :is(button,[role="button"],[role="tab"],[role="radio"],[role="checkbox"],input,select,a[href]),[role="tablist"] [role="tab"]';
      const comps = new Map();
      const list = [...document.querySelectorAll(Q)].filter((e) => window.__a11y.visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.closest('[inert],[aria-hidden="true"]'));
      return list.map((e, i) => {
        e.setAttribute('data-a11y-k', String(i));
        const host = e.closest('[role="toolbar"],[role="menubar"],[role="tablist"],[role="radiogroup"]');
        let c = null;
        if (host) { if (!comps.has(host)) { comps.set(host, comps.size); host.setAttribute('data-a11y-c', String(comps.get(host))); } c = comps.get(host); }
        // The window caption buttons are not Tab stops by design (a native caption has none).
        const grp = e.closest('[role="group"]');
        const caption = !!grp && grp.querySelectorAll('button').length <= 3 && [...grp.querySelectorAll('button')].every((b) => b.tabIndex === -1);
        return { i, name: window.__a11y.label(e) || e.tagName.toLowerCase(), composite: c, caption, tab: e.getAttribute('tabindex'), host: host ? host.getAttribute('role') + ':' + (host.getAttribute('aria-label') || '') : '-' };
      });
    })()`);
    await ev('document.activeElement && document.activeElement.blur()');
    const seen = new Set();
    const visited = new Set();
    const noRing = [];
    let repeats = 0;
    for (let n = 0; n < 160; n++) {
      await input.press('Tab');
      const a = await ev(`(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const cs = getComputedStyle(e);
        return { k: e.getAttribute('data-a11y-k'), id: e.getAttribute('data-a11y-id') || (e.setAttribute('data-a11y-id', String(Math.random())), e.getAttribute('data-a11y-id')),
          name: window.__a11y.label(e) || e.tagName.toLowerCase(), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow };
      })()`);
      if (!a) continue;
      if (visited.has(a.id)) {
        if (++repeats >= 3) break; // the cycle is closed
        continue;
      }
      visited.add(a.id);
      if (a.k !== null) seen.add(Number(a.k));
      if (!hasFocusIndicator(a)) noRing.push(a.name);
    }
    const byName = new Map(controls.map((c) => [c.name, c]));
    const miss = unreachable(
      controls.filter((c) => !c.caption).map((c) => ({ name: c.name, seen: seen.has(c.i), composite: c.composite })),
    ).map((m) => `${m} (tabindex ${byName.get(m)?.tab}, ${byName.get(m)?.host})`);
    const violations = [
      ...miss.map((m) => ({ rule: 'tab-reach', role: '', name: `${m} is not reachable with Tab` })),
      ...noRing.map((m) => ({ rule: 'focus-visible', role: '', name: `${m} shows no focus indicator` })),
    ];
    if (visited.size < 3)
      violations.push({ rule: 'tab-reach', role: '', name: `Tab visited only ${visited.size} elements` });
    report.keyboard[modeId] = {
      ok: violations.length === 0,
      toolbarControls: controls.length,
      tabStops: visited.size,
      violations,
    };
    C(
      `a11y keyboard ${modeId}: Tab reaches toolbar controls, focus visible`,
      violations.length === 0,
      violations.length ? summary(violations) : `${controls.length} controls, ${visited.size} tab stops`,
    );
    await ev('document.activeElement && document.activeElement.blur()');
  }

  await prepare();
  await send('Accessibility.enable');
  await ensure();
  report.note =
    'AX tree = what Narrator reads through UI Automation. The app ships light only (tokens.css); dark is prefers-color-scheme emulation and is expected to equal light.';

  for (const theme of THEMES) {
    await setTheme(theme);
    await sleep(300);
    const bag = [];
    for (const m of MODES) {
      await mode(m);
      await audit(`mode:${m}`, theme, bag);
      await sweepTriggers(m, theme, bag);
    }
    if (!process.env.V20_A11Y_NO_MENUS) await sweepMenus(theme, bag);
    report.themes[theme] = { screens: bag, rollup: rollUp(bag) };
    if (theme === THEMES[0])
      for (const m of MODES) await keyboardPass(m).catch((e) => C(`a11y keyboard ${m}`, false, e.message));
  }
  await setTheme('light');
};

const code = await runSession(session, results);
const all = Object.values(report.themes).flatMap((t) => t.screens);
const kb = Object.values(report.keyboard).flatMap((k) => k.violations);
const roll = rollUp([...all, { violations: kb }]);
report.rollup = roll;
report.ok = code === 0 && roll.violations === 0;
mkdirSync(resolve(ROOT, 'review'), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log('\nper screen violations:');
for (const [theme, t] of Object.entries(report.themes))
  for (const sc of t.screens)
    if (!sc.ok)
      console.log(
        `  [${theme}] ${sc.screen}: ${sc.violations.map((v) => `${v.rule} ${v.role} "${v.name}"${v.el ? ' @' + v.el : ''}`).join('; ')}`,
      );
for (const [m, k] of Object.entries(report.keyboard))
  for (const v of k.violations) console.log(`  [keyboard ${m}] ${v.rule}: ${v.name}`);
console.log(
  `\n${roll.screens} screens, ${roll.violations} violations ${JSON.stringify(roll.byRule)}; written: ${JSON_OUT}`,
);
process.exit(report.ok ? 0 : 1);
