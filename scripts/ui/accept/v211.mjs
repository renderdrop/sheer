// Acceptance v2.1.1 (docs/FEEDBACK.md F22; ADR-146): evidence for the owner polish in the acceptance build.
//   glow    F22.1 home glow, window captures at native 1280x800 and 1920x1080
//   strip   F22.2/F22.3 tool strip at 1280x800, at a width with 32 px squares and at one that wraps to two lines (no overlap)
//   restore F22.4 File -> Restore... through the in-app menu (the list, or the "nothing" toast)
//   hover   F22.6 icon-hover APNG clips (strip tool, home tile/button, menu item/dialog button), CDP mouse moves
// Generated PDFs only (rule 13); window captures / web view clips only; CDP input + dialog queue (rule 15). English UI.
// Run: npm run accept:v211 (V211_PHASES=glow,strip,restore,hover). Output (untracked): review/v211/. Then npm run accept:clean.
import { enterMode } from './modes.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDialogs } from './dialogs.mjs';
import { createInput } from './cdp-input.mjs';
import { startGuard } from './guard.mjs';
import { createResults, sleep } from './harness.mjs';
import { ACCEPTANCE_EXE, launch } from './launch.mjs';
import { parseIndex } from './corpus.mjs';
import { readPng } from './png.mjs';
import { isAcceptanceExe } from './pure.mjs';
import { clientOrigin, plainPdf, rectsEqual } from './v21-pure.mjs';
import { recordClip } from './clip.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/v211/out');
const TMP = resolve(ROOT, 'review/v211/tmp');
const SHOTS = 'v211/shots';
const WINDOW_PS = resolve(import.meta.dirname, 'window.ps1');
const q = (s) => JSON.stringify(s);
const ALL = 'glow,strip,restore,hover';
const PHASES = (process.env.V211_PHASES ?? ALL).split(',');
const RUN = Date.now().toString(36);
const SC = '[data-action-scope="canvas"] > [role="region"]';

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true });
const write = (name, buf) => {
  const p = join(OUT, name.replace(/(\.pdf)$/, `-${RUN}$1`));
  writeFileSync(p, buf);
  return p;
};

const results = createResults();
const { check: C } = results;

// ------------------------------------------------------------------------------------------------------------------ native window
const GRAB_PS = `param([int]$ProcId, [string]$Out)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class V211Grab {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static void Save(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    using (var bmp = new Bitmap(r.R - r.L, r.B - r.T, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      bmp.Save(path, ImageFormat.Png);
    }
  }
}
"@
[void][V211Grab]::SetProcessDPIAware()
$p = Get-Process -Id $ProcId -ErrorAction Stop
if ($p.ProcessName -ne 'sheer-acceptance') { throw "refusing: pid $ProcId is '$($p.ProcessName)', not sheer-acceptance" }
[V211Grab]::Save($p.MainWindowHandle, $Out)
`;
const KILL_PS = `param([string]$ExePath)
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $ExePath } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# The crash orphans the WebView2 browser of the acceptance app (its own data dir only); it would block the relaunch.
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*app.sheer.acceptance*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 40; $i++) { if (-not (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*app.sheer.acceptance*' })) { break }; Start-Sleep -Seconds 2 }
`;
const KILL_FILE = join(TMP, 'kill.ps1');
writeFileSync(KILL_FILE, KILL_PS);
const GRAB_FILE = join(TMP, 'grab.ps1');
writeFileSync(GRAB_FILE, GRAB_PS);

const ps = (file, args) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    encoding: 'utf8',
    timeout: 100000,
  });

/** window.ps1 as JSON: the rect of the acceptance window after the action. */
function win(pid, action, a = {}) {
  const args = ['-ProcId', String(pid), '-Action', action];
  for (const [k, v] of Object.entries(a)) args.push(`-${k}`, String(v));
  return JSON.parse(ps(WINDOW_PS, args).trim().split(/\r?\n/).pop());
}

// ------------------------------------------------------------------------------------------------------------------ app handle
/** One launch of the acceptance build with guard, CDP input, dialog queue and the helpers the phases share. */
async function startApp() {
  const session = await launch();
  await session.send('Emulation.clearDeviceMetricsOverride'); // native sizes: the window decides, no emulation
  const guard = startGuard(session.pid);
  const input = createInput(session, { guard });
  const dialogs = createDialogs(session, input);
  const ev = session.evaluate;
  const app = { session, guard, input, dialogs, ev, pid: session.pid, closed: false };

  const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);
  const count = (sel) => ev(`document.querySelectorAll(${q(sel)}).length`);
  const rectOf = (sel) =>
    ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`);

  /** Reads the viewport after a native change so the input layer clicks inside the real window. */
  async function syncViewport() {
    const v = await ev('({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })');
    session.vp.w = v.w;
    session.vp.h = v.h;
    return v;
  }
  async function setSize(w, h) {
    win(app.pid, 'bounds', { X: 40, Y: 20, W: w, H: h });
    await sleep(700);
    return syncViewport();
  }
  /** Runs fn(w, h) at each native size with a 6-step move between sizes. */
  async function atSizes(fn, sizes = SIZES) {
    for (const [i, [w, h]] of sizes.entries()) {
      if (i > 0) win(app.pid, 'move', { Dx: 8, Dy: 4, Steps: 6 });
      await setSize(w, h);
      await fn(w, h);
    }
    await setSize(1280, 800);
  }
  /** Window capture (PrintWindow of the acceptance window only) saved under review/v21/shots; returns the decoded PNG. */
  function grab(name) {
    const file = resolve(ROOT, 'review', SHOTS, name.endsWith('.png') ? name : `${name}.png`);
    mkdirSync(resolve(file, '..'), { recursive: true });
    ps(GRAB_FILE, ['-ProcId', String(app.pid), '-Out', file]);
    return readPng(file);
  }
  const shot = async (name) => readPng(await input.screenshot(`${SHOTS}/${name}`));

  async function setSettings(extra = {}) {
    const patch = {
      language: 'en',
      welcomeTour: 'shown',
      authorPrompt: 'done',
      pageSidebarCollapsed: false,
      tipsEnabled: false,
      leftPanelWidth: 200,
      showToolLabels: false,
      ...extra,
    };
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('update_settings', { patch: ${q(patch)} }).then(() => 'ok', (e) => 'ERR ' + JSON.stringify(e))`,
    );
    if (r !== 'ok') throw new Error(`update_settings failed: ${r}`);
  }
  async function reload() {
    await ev('location.reload()').catch(() => {});
    await sleep(2500);
    await input.waitFor(`document.documentElement.lang === 'en'`, { timeoutMs: 20000, what: 'UI language' });
    await sleep(1800);
    await syncViewport();
  }
  /** Settings + (unless keepRecoveries) no records from earlier kills + reload; banners dismissed. */
  async function fresh(extra = {}, { keepRecoveries = false } = {}) {
    await setSettings(extra);
    if (!keepRecoveries)
      await ev(`window.__TAURI_INTERNALS__.invoke('discard_all_recoveries').then(() => 'ok', () => 'ERR')`);
    await reload();
    for (const sel of ['[data-region="banner"] button[aria-label="Dismiss"]', 'button[aria-label="Decide later"]']) {
      if (!keepRecoveries && (await exists(sel))) {
        await input.click({ selector: sel });
        await sleep(600);
      }
    }
  }
  async function open(path) {
    await sleep(800);
    await dialogs.openFile(path);
    await input.waitFor(`document.querySelectorAll('[data-page] img').length > 0`, {
      timeoutMs: 40000,
      what: 'page image',
    });
    await sleep(900);
  }
  const mode = async (id) => {
    await enterMode(input, id, sleep);
    await sleep(500);
  };
  const blurField = () =>
    ev(`document.activeElement?.closest?.('input,textarea,[contenteditable="true"]') && document.activeElement.blur()`);
  async function closeAll() {
    for (let i = 0; i < 12 && (await exists('[data-page]')); i++) {
      await blurField();
      await input.press('w', { ctrl: true });
      await sleep(900);
      if (await count('[role="alertdialog"], [role="dialog"]')) {
        await input
          .click({ selector: '[role="alertdialog"] button, [role="dialog"] button', text: "Don't Save" })
          .catch(() => input.press('Escape').catch(() => {}));
        await sleep(500);
      }
    }
    await sleep(600);
  }
  /** Selects a comment/edit tool from the card: its toolbar item, or the main button of its split. */
  async function selectTool(id) {
    for (const sel of [
      `[data-toolbar-item="${id}"]`,
      `[data-split="${id}"] [data-roving="${id}"]`,
      `[data-split="${id}"] button`,
    ]) {
      if (await exists(sel)) {
        await input.click({ selector: sel });
        await sleep(400);
        return;
      }
    }
    throw new Error(`tool ${id} not found in the card`);
  }
  async function pageRect(n) {
    for (let i = 0; i < 40 && !(await exists(`[data-page="${n}"]`)); i++) {
      await ev(`document.querySelector(${q(SC)}).scrollTop += 500`);
      await sleep(250);
    }
    await ev(`(() => { const e = document.querySelector('[data-page="${n}"]'); if (!e) return;
      const sc = document.querySelector(${q(SC)}); const r = e.getBoundingClientRect(); const sr = sc.getBoundingClientRect();
      sc.scrollTop += r.top - sr.top - 8; })()`);
    await sleep(600);
    return curRect(n);
  }
  const curRect = (n) =>
    ev(
      `(() => { const r = document.querySelector('[data-page="${n}"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`,
    );
  async function stroke(pts) {
    const send = (type, p, extra = {}) =>
      session.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers: 0, ...extra });
    await send('mouseMoved', pts[0]);
    await send('mousePressed', pts[0], { button: 'left', buttons: 1, clickCount: 1 });
    for (const p of pts.slice(1)) {
      await send('mouseMoved', p, { button: 'left', buttons: 1 });
      await sleep(8);
    }
    await send('mouseReleased', pts[pts.length - 1], { button: 'left', buttons: 0, clickCount: 1 });
  }
  /** Quits by the title bar's close button; answers a save prompt with Don't Save. Resolves when the process is gone. */
  async function quitClean() {
    await blurField();
    // The window may close mid-click: the CDP reply never comes, so do not await it for long.
    await Promise.race([input.click({ selector: 'button[aria-label="Close"]' }).catch(() => {}), sleep(4000)]);
    await sleep(900);
    if (await Promise.race([count('[role="alertdialog"]').catch(() => 0), sleep(2000).then(() => 0)]))
      await input.click({ selector: '[role="alertdialog"] button', text: "Don't Save" }).catch(() => {});
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(app.pid, 0);
      } catch {
        return true;
      }
      await sleep(250);
    }
    return false;
  }
  /** The crash: kills the process whose executable is the acceptance exe (by path only, never by name). */
  function crash() {
    if (!isAcceptanceExe(ACCEPTANCE_EXE)) throw new Error('refusing to kill: not the acceptance exe');
    app.guard.stop();
    ps(KILL_FILE, ['-ExePath', resolve(ACCEPTANCE_EXE)]);
    app.closed = true;
    try {
      session.close();
    } catch {
      /* already gone */
    }
  }
  function stop() {
    if (app.closed) return;
    app.closed = true;
    app.guard.stop();
    session.close();
  }
  async function annotations() {
    return ev(`(async () => {
      let out = [];
      for (let id = 0; id < 60; id++) {
        const r = await window.__TAURI_INTERNALS__.invoke('list_annotations', { docId: id, pageId: 0 }).then((x) => x, () => null);
        if (r && r.length) out = r;
      }
      return out;
    })()`);
  }
  return Object.assign(app, {
    exists,
    count,
    rectOf,
    syncViewport,
    setSize,
    atSizes,
    grab,
    shot,
    setSettings,
    reload,
    fresh,
    open,
    mode,
    blurField,
    closeAll,
    selectTool,
    pageRect,
    curRect,
    stroke,
    quitClean,
    crash,
    stop,
    annotations,
  });
}

let main = null;
/** The shared app of the phases; started on first use and reset after the recovery phase killed it. */
async function getMain() {
  if (main && !main.closed) return main;
  await sleep(1500);
  main = await startApp();
  await sleep(1500);
  await main.fresh();
  return main;
}

const section = async (name, fn) => {
  let app = null;
  try {
    app = await getMain().catch((e) => {
      throw e;
    });
    await Promise.race([fn(app), app.guard.aborted]);
  } catch (e) {
    C(`${name}: ran to the end`, false, e.message);
    await app?.input.press('Escape').catch(() => {});
  }
};

// ================================================================================================================ glow (F22.1)
async function glowPhase(a) {
  const { ev, input } = a;
  await a.closeAll();
  await input.waitFor(`!!document.querySelector('[data-home-main]')`, { timeoutMs: 8000, what: 'home' });
  for (const [w, h] of [
    [1280, 800],
    [1920, 1080],
  ]) {
    await a.setSize(w, h);
    await sleep(1200);
    const m = await ev(`(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      return { main: r('[data-home-main]'), glow: r('[data-home-glow]'), dpr: window.devicePixelRatio, iw: innerWidth, ih: innerHeight,
        winW: getComputedStyle(document.documentElement).getPropertyValue('--glow-win-w').trim() };
    })()`);
    const png = a.grab(`f22-1-glow-${w}x${h}`);
    const o = clientOrigin(win(a.pid, 'rect'), m.iw, m.ih, m.dpr);
    const px = (x, y) => png.rgb(Math.round(o.x + x * m.dpr), Math.round(o.y + y * m.dpr));
    const tr = px(m.main.r - 24, m.main.t + 24);
    const bl = px(m.main.l + 24, m.main.b - 24);
    C(
      `F22.1 (${w}x${h}): glow layer covers the home surface`,
      rectsEqual(m.glow, m.main, 1),
      JSON.stringify({ g: m.glow, m: m.main }),
    );
    C(
      `F22.1 (${w}x${h}): top-right is warmer than bottom-left (glow centred at the top-right)`,
      tr[0] - tr[2] > bl[0] - bl[2] + 10,
      JSON.stringify({ tr, bl, winW: m.winW }),
    );
  }
  await a.setSize(1280, 800);
}

// ================================================================================================================ strip (F22.2, F22.3)
async function stripPhase(a) {
  const { ev } = a;
  await a.closeAll();
  await a.open(write('strip.pdf', plainPdf(2, 'Strip')));
  await a.mode('comment');
  const read = () =>
    ev(`(() => {
      const row = document.querySelector('[data-slot="tool-row"]'); const card = document.querySelector('[data-slot="mode-card"]');
      const canvas = document.querySelector('[data-action-scope="canvas"]');
      const rect = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const items = [...row.querySelectorAll('[data-toolbar-item]')].filter((e) => e.getBoundingClientRect().width > 0);
      const rr = rect(row);
      const seps = [...row.querySelectorAll('[data-separator-box]:not([data-line-end])')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => rect(e));
      const lefts = [...row.querySelectorAll('[data-unit]')].map((e) => rect(e).l);
      return { fit: row.dataset.fit, lines: document.documentElement.dataset.toolLines ?? '1', row: rr, card: rect(card), canvas: canvas ? rect(canvas) : null,
        item: items.length ? rect(items[0]) : null, sizes: [...new Set(items.map((e) => Math.round(e.getBoundingClientRect().width)))],
        outside: items.filter((e) => { const b = e.getBoundingClientRect(); return b.left < rr.l - 1 || b.right > rr.r + 1 || b.bottom > card.getBoundingClientRect().bottom + 1; }).length,
        sepAtStart: seps.filter((s) => lefts.some((l) => Math.abs(s.l - l) < 2)).length,
        captions: document.querySelectorAll('[data-mode-caption]').length, tabs: document.querySelectorAll('[data-slot="mode-row"], button[data-mode]').length };
    })()`);
  const layoutOf = () =>
    ev(`(() => {
      const row = document.querySelector('[data-slot="tool-row"]'); const cs = getComputedStyle(row); const rr = row.getBoundingClientRect();
      const rect = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const groups = [...row.querySelectorAll('[data-mode-group]')].map(rect);
      const seps = [...row.querySelectorAll('[data-separator]')].map(rect).filter((r) => r.w > 0);
      const lines = [];
      for (const g of groups) { const l = lines.find((x) => Math.abs(x.t - g.t) < 30); if (l) l.groups.push(g); else lines.push({ t: g.t, groups: [g] }); }
      return { lines, seps, left: rr.left + parseFloat(cs.paddingLeft), right: rr.right - parseFloat(cs.paddingRight), dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight };
    })()`);
  /** F22.2: separators visible between every two neighbouring groups (DOM + window capture), strip centred per line. */
  const lineChecks = async (tag, png, minGap = 0) => {
    const L = await layoutOf();
    const o = clientOrigin(win(a.pid, 'rect'), L.iw, L.ih, L.dpr);
    const px = (x, y) => png.rgb(Math.round(o.x + x * L.dpr), Math.round(o.y + y * L.dpr));
    const near = (p) => p && Math.abs(p[0] - 229) <= 3 && Math.abs(p[1] - 229) <= 3 && Math.abs(p[2] - 225) <= 3;
    const out = { dom: [], pix: [], centre: [], gaps: [] };
    for (const [i, line] of L.lines.entries()) {
      const gs = line.groups.sort((p, q) => p.l - q.l);
      const top = Math.min(...gs.map((g) => g.t));
      const bot = Math.max(...gs.map((g) => g.b));
      for (let k = 0; k + 1 < gs.length; k++) {
        const a0 = gs[k].r;
        const b0 = gs[k + 1].l;
        out.gaps.push(Math.round(b0 - a0));
        const sep = L.seps.find((p) => (p.l + p.r) / 2 > a0 && (p.l + p.r) / 2 < b0 && p.t < bot && p.b > top);
        out.dom.push(!!sep && sep.w >= 1 && sep.h >= 16);
        let hit = false;
        for (let x = Math.floor(a0); x <= Math.ceil(b0) && !hit; x++) {
          let run = 0;
          for (let y = Math.floor(top); y <= Math.ceil(bot); y++) {
            run = near(px(x, y)) ? run + 1 : 0;
            if (run >= 20) {
              hit = true;
              break;
            }
          }
        }
        out.pix.push(hit);
      }
      out.centre.push(Math.round(gs[0].l - L.left) - Math.round(L.right - gs[gs.length - 1].r));
    }
    C(
      `F22.2 ${tag}: one visible separator (w>=1, h>=16) between every two groups on every line`,
      out.dom.length > 0 && out.dom.every(Boolean),
      JSON.stringify(out.dom),
    );
    C(
      `F22.2 ${tag}: window capture has a #E5E5E1 column >= 20 px tall in every gap`,
      out.pix.length > 0 && out.pix.every(Boolean),
      JSON.stringify(out.pix),
    );
    C(
      `F22.2 ${tag}: strip centred (left spare equals right spare within 2 px on each line)`,
      out.centre.every((d) => Math.abs(d) <= 2),
      JSON.stringify(out.centre),
    );
    if (minGap)
      C(
        `F22.2 ${tag}: gaps between groups > ${minGap} px`,
        out.gaps.every((g) => g > minGap),
        JSON.stringify(out.gaps),
      );
  };
  const verdict = (tag, s, want) => {
    C(
      `F22.2/3 ${tag}: card does not overlap the content below, every tool inside the card`,
      s.canvas !== null && s.card.b <= s.canvas.t + 1 && s.outside === 0,
      JSON.stringify({ cardB: s.card.b, canvasT: s.canvas?.t, outside: s.outside }),
    );
    C(
      `F22.2/3 ${tag}: ${want.label}`,
      want.ok(s),
      JSON.stringify({ fit: s.fit, lines: s.lines, sizes: s.sizes, item: s.item }),
    );
    C(`F22.3 ${tag}: no separator starts a line`, s.sepAtStart === 0, `${s.sepAtStart}`);
  };
  await a.setSize(1280, 800);
  await sleep(500);
  let s = await read();
  await lineChecks('1280x800', a.grab('f22-2-strip-1280x800'));
  C(
    'F22.2 1280x800: static captions, no mode tabs (fit ' + s.fit + ', lines ' + s.lines + ')',
    s.captions === 5 && s.tabs === 0,
    JSON.stringify({ fit: s.fit, lines: s.lines, captions: s.captions, tabs: s.tabs }),
  );
  C(
    'F22.2/3 1280x800: no overlap (info: ' + s.fit + '/' + s.lines + ')',
    s.canvas !== null && s.card.b <= s.canvas.t + 1 && s.outside === 0,
    JSON.stringify({ cardB: s.card.b, canvasT: s.canvas?.t }),
  );
  // Sweep the window width down to find the first widths that give 32 px squares and two lines.
  let w32 = null;
  let wWrap = null;
  const seen = [];
  for (let w = 1900; w >= 560; w -= 20) {
    await a.setSize(w, 800);
    await sleep(450);
    s = await read();
    seen.push(`${w}:${s.fit}/${s.lines}`);
    if (w === 1900) await lineChecks('1900x800', a.grab('f22-2-strip-step1-1900x800'), 20);
    if (s.fit === '2' && s.lines === '1') w32 = w; // the narrowest width that still fits on one line at 32 px
    if (s.lines === '2') {
      wWrap = w;
      break;
    }
  }
  C('F22.3: a width with 32 px squares and a width that wraps exist', w32 !== null && wWrap !== null, seen.join(' '));
  if (w32 !== null) {
    await a.setSize(w32, 800);
    await sleep(600);
    s = await read();
    await lineChecks(`${w32}x800`, a.grab(`f22-3-strip-32px-${w32}x800`));
    verdict(`${w32}x800`, s, {
      label: 'step 2, every square 32 px, one line',
      ok: (x) => x.fit === '2' && x.lines === '1' && x.item !== null && Math.round(x.item.h) === 32,
    });
  }
  if (wWrap !== null) {
    await a.setSize(wWrap, 800);
    await sleep(600);
    s = await read();
    await lineChecks(`${wWrap}x800`, a.grab(`f22-3-strip-wrapped-${wWrap}x800`));
    verdict(`${wWrap}x800`, s, { label: 'step 3, two lines', ok: (x) => x.fit === '3' && x.lines === '2' });
    for (const m of ['read', 'fill', 'pages', 'edit']) {
      await a.mode(m);
      await sleep(400);
      const t = await read();
      C(
        `F22.3 (${wWrap}x800) ${m}: strip does not overlap the content`,
        t.canvas !== null && t.card.b <= t.canvas.t + 1 && t.outside === 0,
        JSON.stringify({ lines: t.lines, cardB: t.card.b, canvasT: t.canvas?.t }),
      );
    }
  }
  await a.setSize(1280, 800);
  await a.closeAll();
}

// ================================================================================================================ restore (F22.4)
async function restorePhase(a) {
  const { ev, input } = a;
  await a.closeAll();
  // The in-app menu bar lives in the editor chrome (the home surface has none): open a document first.
  await a.open(write('restore.pdf', plainPdf(1, 'Restore')));
  await ev(`window.__TAURI_INTERNALS__.invoke('discard_all_recoveries').then(() => 'ok', () => 'ERR')`);
  await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: 'File' });
  await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'File menu' });
  await sleep(300);
  const labels = await ev(
    `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.trim().replace(/\\s+/g, ' ')).filter((t) => /restore/i.test(t))`,
  );
  C('F22.4: the File menu has "Restore…"', labels.length === 1 && /^Restore…/.test(labels[0]), JSON.stringify(labels));
  await a.shot('f22-4-file-menu');
  await input.click({ selector: '[role="menu"] [role="menuitem"]', text: 'Restore' });
  await input
    .waitFor(
      `/No documents to restore/.test(document.body.innerText) || !!document.querySelector('[aria-label="Documents to restore"]')`,
      { timeoutMs: 5000, what: 'list or toast' },
    )
    .catch(() => false);
  const kind = await ev(
    `/No documents to restore/.test(document.body.innerText) ? 'toast' : document.querySelector('[aria-label="Documents to restore"]') ? 'list' : 'none'`,
  );
  C('F22.4: Restore… with no record on disk shows the "nothing" toast', kind === 'toast', kind);
  await a.shot('f22-4-restore-nothing');
}

// ================================================================================================================ hover (F22.6)
async function hoverPhase(a) {
  const { input, session, ev } = a;
  const CLIPS = resolve(ROOT, 'review/v211/clips');
  mkdirSync(CLIPS, { recursive: true });
  await a.setSize(1280, 800);
  /** Highest fps the capture loop manages for this clip rect (calibrated, capped at 30). */
  async function fpsFor(rect, scale) {
    const t0 = Date.now();
    const n = 8;
    for (let i = 0; i < n; i++)
      await session.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
        captureBeyondViewport: false,
      });
    return Math.max(5, Math.min(30, Math.floor(1000 / ((Date.now() - t0) / n))));
  }
  const find = (selector, text) =>
    ev(`(() => { const e = [...document.querySelectorAll(${q(selector)})].find((x) => x.getBoundingClientRect().width > 0 && (!${q(text ?? '')} || x.textContent.includes(${q(text ?? '')})));
      if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  async function saveStill(rect, scale, out) {
    const r = await session.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
      captureBeyondViewport: false,
    });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
  }
  async function clipHover(name, selector, { text, pad = 14, before } = {}) {
    await before?.();
    const r = await find(selector, text);
    if (!r) throw new Error(`no target ${selector} ${text ?? ''}`);
    const rect = {
      x: Math.max(0, Math.floor(r.l - pad)),
      y: Math.max(0, Math.floor(r.t - pad)),
      width: Math.ceil(r.w + 2 * pad),
      height: Math.ceil(r.h + 2 * pad),
    };
    const c = { x: r.l + r.w / 2, y: r.t + r.h / 2 };
    const away = { x: Math.max(2, r.l - 50), y: Math.max(2, r.t - 30) };
    const scale = 2;
    const fps = await fpsFor(rect, scale);
    await input.hover(away);
    await sleep(300);
    const out = join(CLIPS, `f22-6-hover-${name}.png`);
    const res = await recordClip(session, {
      rect,
      seconds: 1.6,
      fps,
      scale,
      out,
      plays: 0,
      script: async () => {
        await sleep(80);
        for (let i = 1; i <= 4; i++) {
          await input.hover({ x: away.x + ((c.x - away.x) * i) / 4, y: away.y + ((c.y - away.y) * i) / 4 });
          await sleep(15);
        }
        await sleep(400); // about 40 % into the 0.8-1.1 s motion
        await saveStill(rect, scale, join(CLIPS, `f22-6-hover-${name}-still.png`));
        await sleep(1000);
      },
    });
    await input.hover(away);
    C(
      `F22.6 hover clip ${name}: written (1.6 s)`,
      res.frames > 0,
      `${fps} fps, ${res.frames} frames, ${(res.bytes / 1024).toFixed(0)} KB -> review/v211/clips/f22-6-hover-${name}.png (+ -still)`,
    );
  }
  // 1. strip tools of different families
  await a.closeAll();
  await a.open(write('hover.pdf', plainPdf(1, 'Hover')));
  await a.mode('comment');
  await clipHover('strip-highlight', '[data-slot="tool-row"] [data-toolbar-item="highlight"]');
  await clipHover('strip-note', '[data-slot="tool-row"] [data-toolbar-item="note"]');
  // 2. a menu item
  await clipHover('menu-item', '[role="menu"] [role="menuitem"]', {
    text: 'Open',
    pad: 18,
    before: async () => {
      await input.click({ selector: '[role="menubar"] [role="menuitem"]', text: 'File' });
      await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'File menu' });
      await sleep(300);
    },
  });
  await input.press('Escape').catch(() => {});
  await sleep(300);
  // 3. the whole strip swept left to right
  const row = await find('[data-slot="tool-row"]');
  const srect = { x: Math.floor(row.l), y: Math.floor(row.t), width: Math.ceil(row.w), height: Math.ceil(row.h) };
  const sfps = await fpsFor(srect, 1);
  await input.hover({ x: row.l + 2, y: row.t + row.h / 2 });
  await sleep(300);
  const sres = await recordClip(session, {
    rect: srect,
    seconds: 3,
    fps: sfps,
    scale: 1,
    out: join(CLIPS, 'f22-6-hover-strip-sweep.png'),
    plays: 0,
    script: async () => {
      await sleep(150);
      const steps = 60;
      for (let i = 0; i <= steps; i++) {
        await input.hover({ x: row.l + 4 + ((row.w - 8) * i) / steps, y: row.t + row.h / 2 });
        await sleep(35);
      }
    },
  });
  C(
    'F22.6 hover clip strip-sweep: written (3 s)',
    sres.frames > 0,
    `${sfps} fps, ${sres.frames} frames, ${(sres.bytes / 1024).toFixed(0)} KB`,
  );
  // 4. home: the Split tile (scissors) and the Open button
  await a.closeAll();
  await input.waitFor(`!!document.querySelector('[data-home-main]')`, { timeoutMs: 8000, what: 'home' });
  await clipHover('home-split-tile', '[data-tool-tile]', { text: 'Split' });
  await clipHover('home-open', '[data-home-open]');
}

const PHASE_FNS = { glow: glowPhase, strip: stripPhase, restore: restorePhase, hover: hoverPhase };
let code = 0;
// Orphaned WebView2 browsers of an earlier run (acceptance data dir only) block the next start.
try {
  ps(KILL_FILE, ['-ExePath', resolve(ACCEPTANCE_EXE)]);
} catch {
  /* nothing to clear */
}
try {
  for (const name of ALL.split(',')) {
    if (!PHASES.includes(name)) continue;
    console.log(`\n== ${name}`);
    await section(name, PHASE_FNS[name]);
  }
} finally {
  main?.stop();
  results.table();
  code = results.failed() ? 1 : 0;
}
process.exitCode = code;
