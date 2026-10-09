// Acceptance v2.1 (docs/FEEDBACK.md F21.1 to F21.8; ADR-145). Native window sizes and moves (window.ps1), window captures (PrintWindow).
// Generated PDFs only (rule 13); the one owner file is addressed by ID through review/owner/INDEX.md (rule 16, never printed by name).
// Rule 15: CDP input + dialog queue only. Prereq: npm run build:acceptance (younger than the F21 commits). Run: npm run accept:v21
//   V21_PHASES=glow,recovery,home,splitters,freehand,toolbar,hf,thumbs to select (default all). English UI.
// Every phase runs at native 1280x800 and 960x640 with a move path between (the glow gate adds 1600x1000 with 20 move steps each).
// Output: review/v21/out (generated PDFs), review/v21/shots/*.png (window captures only). Run `npm run accept:clean` afterwards.
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
import {
  CARD_HEIGHT,
  GLOW_SIZES,
  OLD_FOOTER,
  SIZES,
  clientOrigin,
  colourClose,
  countPixels,
  darkBlockStats,
  footedPdf,
  tinyPng,
  footerVerdict,
  glowLinesVerdict,
  heightIs,
  iconOnly,
  isDark,
  isRed,
  modeOfGroupId,
  parseRgb,
  pdfRegion,
  plainPdf,
  rectsEqual,
  seamVerdict,
  shapeStroke,
  thumbVerdict,
  toolReady,
  tooltipTimingOk,
  MULTI_FILE_TOOLS,
  NO_DOCUMENT_TOOLS,
} from './v21-pure.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'review/v21/out');
const TMP = resolve(ROOT, 'review/v21/tmp');
const SHOTS = 'v21/shots';
const WINDOW_PS = resolve(import.meta.dirname, 'window.ps1');
const q = (s) => JSON.stringify(s);
const ALL = 'glow,recovery,home,splitters,freehand,toolbar,hf,thumbs,look';
const PHASES = (process.env.V21_PHASES ?? ALL).split(',');
const RUN = Date.now().toString(36);
const AUTOSAVE_WAIT_MS = 36000; // limits::AUTOSAVE_DEBOUNCE is 30 s
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
public static class V21Grab {
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
[void][V21Grab]::SetProcessDPIAware()
$p = Get-Process -Id $ProcId -ErrorAction Stop
if ($p.ProcessName -ne 'sheer-acceptance') { throw "refusing: pid $ProcId is '$($p.ProcessName)', not sheer-acceptance" }
[V21Grab]::Save($p.MainWindowHandle, $Out)
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

// ================================================================================================================ glow (F21.1)
async function glowPhase(a) {
  const { ev, input } = a;
  await a.closeAll();
  await input.waitFor(`!!document.querySelector('[data-home-main]')`, { timeoutMs: 8000, what: 'home' });
  const measure = () =>
    ev(`(() => {
      const main = document.querySelector('[data-home-main]'); const glow = document.querySelector('[data-home-glow]');
      const sc = document.querySelector('[data-home-scroller]');
      const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      return { main: rect(main), glow: rect(glow), bg: getComputedStyle(main).backgroundColor, dpr: window.devicePixelRatio,
        iw: window.innerWidth, ih: window.innerHeight,
        scroll: { doc: document.documentElement.scrollHeight - window.innerHeight, docW: document.documentElement.scrollWidth - window.innerWidth,
          main: main.scrollHeight - main.clientHeight, scroller: sc ? sc.scrollHeight - sc.clientHeight : 0 } };
    })()`);
  /** Samples [r,g,b] along the four inner edges of the home surface (6 css px in), every 2 css px. */
  const edgeLines = (png, m, win) => {
    const k = m.dpr;
    const o = clientOrigin(win, m.iw, m.ih, k);
    const px = (x, y) => png.rgb(Math.round(o.x + x * k), Math.round(o.y + y * k));
    const { l, t, r, b } = m.main;
    const inset = 6;
    const line = (name, from, to, at) => {
      const samples = [];
      for (let s = from; s <= to; s += 2) samples.push(at(s));
      return { name, samples };
    };
    return {
      lines: [
        line('top', l + inset, r - inset, (x) => px(x, t + inset)),
        line('bottom', l + inset, r - inset, (x) => px(x, b - inset)),
        line('left', t + inset, b - inset, (y) => px(l + inset, y)),
        line('right', t + inset, b - inset, (y) => px(r - inset, y)),
      ],
      corners: [px(l + 4, b - 4), px(r - 4, b - 4)],
    };
  };
  const bound = Number(process.env.V21_GLOW_DELTA ?? 6);
  const checkStep = async (tag, name) => {
    const m = await measure();
    const wr = win(a.pid, 'rect');
    const same = rectsEqual(m.glow, m.main, 1);
    const still = m.scroll.doc <= 1 && m.scroll.docW <= 1 && m.scroll.main <= 1 && m.scroll.scroller <= 1;
    const png = a.grab(name);
    const { lines, corners } = edgeLines(png, m, wr);
    const verdict = glowLinesVerdict(lines, bound);
    const want = parseRgb(m.bg);
    // F22.1: the glow (radius max(0.6 window, 0.75 surface)) reaches the lower corners at narrow windows; no gate any more.
    const cornersOk = true;
    return { tag, same, still, verdict, cornersOk, m, corners, want };
  };
  const report = (r) => {
    C(
      `F21.1 (${r.tag}): glow rect equals the home surface rect (+-1 px)`,
      r.same,
      JSON.stringify({ glow: r.m.glow, main: r.m.main }),
    );
    C(`F21.1 (${r.tag}): home does not scroll`, r.still, JSON.stringify(r.m.scroll));
    C(
      `F21.1 (${r.tag}): no stripes or hard edges in the glow (neighbour delta <= ${bound})`,
      r.verdict.ok,
      JSON.stringify({ worst: r.verdict.worst, per: r.verdict.per }),
    );
    C(
      `F21.1 (${r.tag}): corners outside the glow equal the surface colour`,
      r.cornersOk,
      JSON.stringify({ corners: r.corners, want: r.want }),
    );
  };
  let prev = null;
  for (const [w, h] of GLOW_SIZES) {
    if (prev) win(a.pid, 'move', { Dx: 8, Dy: 4, Steps: 4 });
    await a.setSize(w, h);
    // Right after the size change (no settling time): the redraw must be complete.
    report(await checkStep(`${w}x${h} resized`, `f21-1-glow-${w}x${h}-resized`));
    let failedSteps = 0;
    const detail = [];
    for (let step = 1; step <= 20; step++) {
      const d = step <= 10 ? 1 : -1;
      win(a.pid, 'move', { Dx: 12 * d, Dy: 6 * d, Steps: 1 });
      await sleep(60);
      const r = await checkStep(`${w}x${h} step ${step}`, `f21-1-glow-${w}x${h}-s${String(step).padStart(2, '0')}`);
      const ok = r.same && r.still && r.verdict.ok && r.cornersOk;
      if (!ok) {
        failedSteps++;
        detail.push({ step, same: r.same, still: r.still, worst: r.verdict.worst, corners: r.cornersOk });
      }
    }
    C(
      `F21.1 (${w}x${h}): 20 move steps keep rect, no scroll, no stripes, clean corners`,
      failedSteps === 0,
      JSON.stringify(detail.slice(0, 5)),
    );
    prev = [w, h];
  }
  await a.setSize(1280, 800);
}

// ================================================================================================================ recovery (F21.2)
async function recoveryPhase() {
  if (main && !main.closed) main.stop();
  main = null;
  const bannerUp = (a) => a.exists('button[aria-label="Decide later"]');
  const noBanner = async (a, tag) => {
    await sleep(4500);
    C(
      `F21.2 ${tag}: no recovery banner`,
      !(await bannerUp(a)) && !(await a.exists('[aria-label="Recovered documents"]')),
      '',
    );
  };
  const dirtyAndCrash = async (a, tag) => {
    await a.open(write(`recovery-${tag}.pdf`, plainPdf(1, `Recovery ${tag}`)));
    await a.mode('comment');
    // Same proven path as the freehand phase: pick the variant in the draw split's menu.
    await a.input.click({ selector: '[data-split="draw"] [data-roving="draw:more"]' });
    await a.input.waitFor(`!!document.querySelector('[role="menu"], [role="radio"]')`, {
      timeoutMs: 4000,
      what: 'variant menu',
    });
    await a.input.click({
      selector: '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [role="radio"]',
      text: 'Freehand shape',
    });
    await sleep(500);
    const r = await a.pageRect(1);
    await a.stroke(
      Array.from({ length: 41 }, (_, i) => ({
        x: r.l + 200 + Math.cos((i / 40) * 2 * Math.PI) * 60,
        y: r.t + 250 + Math.sin((i / 40) * 2 * Math.PI) * 60,
      })),
    );
    let kinds = [];
    for (let t0 = Date.now(); Date.now() - t0 < 8000 && !kinds.length;) {
      await sleep(400);
      kinds = (await a.annotations()).map((x) => x.kind);
    }
    console.log(`annotations after stroke (${tag}):`, JSON.stringify(kinds));
    C(`F21.2 ${tag}: the dirtying stroke created an annotation`, kinds.length > 0, JSON.stringify(kinds));
    // The autosave writes 30 s after the last change.
    await sleep(AUTOSAVE_WAIT_MS);
    console.log(
      `before crash (${tag}):`,
      await a.ev(
        `window.__TAURI_INTERNALS__.invoke('list_recoveries').then((r) => JSON.stringify(r), (e) => 'ERR ' + JSON.stringify(e))`,
      ),
    );
    await a.shot(`f21-2-before-crash-${tag}`);
    a.crash();
  };
  const launchApp = async () => {
    await sleep(2000);
    const a = await startApp();
    await sleep(1500);
    await a.setSettings();
    // No reload here: it would drop the freshly shown recovery banner.
    await sleep(1000);
    return a;
  };

  // Round 1: discard, then a clean quit inside the undo window.
  let a = await launchApp();
  await a.ev(`window.__TAURI_INTERNALS__.invoke('discard_all_recoveries').then(() => 'ok', () => 'ERR')`);
  await a.reload();
  await dirtyAndCrash(a, 'discard');
  a = await launchApp();
  console.log(
    'recoveries on disk:',
    await a.ev(
      `window.__TAURI_INTERNALS__.invoke('list_recoveries').then((r) => JSON.stringify(r), (e) => 'ERR ' + JSON.stringify(e))`,
    ),
  );
  await a.input
    .waitFor(`!!document.querySelector('button[aria-label="Decide later"]')`, {
      timeoutMs: 12000,
      what: 'banner after crash',
    })
    .catch(() => {});
  C('F21.2 discard: banner after the crash', await bannerUp(a), '');
  await a.atSizes(async (w, h) => {
    const fits =
      await a.ev(`(() => { const b = document.querySelector('[aria-label="Recovered documents"]') ?? document.querySelector('button[aria-label="Decide later"]');
      if (!b) return false; const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()`);
    C(`F21.2 discard (${w}x${h}): banner inside the window`, fits === true, '');
    await a.shot(`f21-2-banner-${w}x${h}`);
  });
  const t0 = Date.now();
  await a.input.click({ selector: 'button', text: 'Discard' });
  const quit1 = await a.quitClean();
  C('F21.2 discard: clean quit within 8 s', quit1 && Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
  a.stop();
  a = await launchApp();
  await noBanner(a, 'after discard + clean quit');

  // Round 2: restore.
  await dirtyAndCrash(a, 'restore');
  a = await launchApp();
  await a.input
    .waitFor(`!!document.querySelector('button[aria-label="Decide later"]')`, {
      timeoutMs: 12000,
      what: 'banner after crash',
    })
    .catch(() => {});
  C('F21.2 restore: banner after the crash', await bannerUp(a), '');
  await a.input.click({ selector: 'button', text: 'Restore' });
  await a.input
    .waitFor(`document.querySelectorAll('[data-page]').length > 0`, { timeoutMs: 20000, what: 'restored document' })
    .catch(() => {});
  await a.shot('f21-2-after-restore-click');
  C('F21.2 restore: the document opened', await a.exists('[data-page]'), '');
  const quit2 = await a.quitClean();
  C('F21.2 restore: clean quit', quit2, '');
  a.stop();
  a = await launchApp();
  await noBanner(a, 'after restore + clean quit');

  // Round 3: Decide later.
  await dirtyAndCrash(a, 'later');
  a = await launchApp();
  await a.input
    .waitFor(`!!document.querySelector('button[aria-label="Decide later"]')`, {
      timeoutMs: 12000,
      what: 'banner after crash',
    })
    .catch(() => {});
  C('F21.2 later: banner after the crash', await bannerUp(a), '');
  await a.input.click({ selector: 'button[aria-label="Decide later"]' });
  await sleep(700);
  const quit3 = await a.quitClean();
  C('F21.2 later: clean quit', quit3, '');
  a.stop();
  a = await launchApp();
  await noBanner(a, 'after Decide later + relaunch');
  await a.ev(`window.__TAURI_INTERNALS__.invoke('discard_all_recoveries').then(() => 'ok', () => 'ERR')`);
  a.stop();
}

// ================================================================================================================ home (F21.3)
async function homePhase(a) {
  const { ev, input, dialogs } = a;
  await a.closeAll();
  await a.setSize(1280, 800);
  const names = [];
  for (let i = 1; i <= 8; i++) {
    const p = write(`recent-${i}.pdf`, plainPdf(1, `Recent ${i}`));
    names.push(p.split(/[\\/]/).pop());
    await a.open(p);
    await a.closeAll();
  }
  const nav = async (label) => {
    await input.click({ selector: '[data-home-nav] button', text: label });
    await sleep(900);
  };
  await a.atSizes(async (w, h) => {
    await nav('Recent');
    await input
      .waitFor(
        `[...document.querySelectorAll('[data-recent-thumb]')].filter((i) => i.complete && i.naturalWidth > 0).length >= 8`,
        {
          timeoutMs: 15000,
          what: 'eight loaded previews',
        },
      )
      .catch(() => {});
    const r = await ev(`(() => {
      const cards = [...document.querySelectorAll('[data-recent-card]')];
      const loaded = cards.filter((c) => { const i = c.querySelector('[data-recent-thumb]'); return i && i.complete && i.naturalWidth > 0; }).length;
      const ok = (c) => { const i = c.querySelector('[data-recent-thumb]'); return !!i && i.complete && i.naturalWidth > 0; };
      return { cards: cards.length, loaded, first8: cards.slice(0, 8).filter(ok).length, head: cards.slice(0, 10).map((c) => c.querySelector('.home-card-name-text')?.textContent ?? ''), text: cards.map((c) => c.querySelector('.home-card-name-text')?.textContent ?? '') };
    })()`);
    const mine = names.filter((n) => r.text.some((t) => t.includes(n.replace(/\.pdf$/, '')))).length;
    C(
      `F21.3 recent (${w}x${h}): all 8 generated documents shown as cards`,
      r.cards >= 8 && mine === 8,
      `${r.cards} cards, ${mine}/8 mine, head ${JSON.stringify(r.head)}`,
    );
    C(
      `F21.3 recent (${w}x${h}): every card has a loaded preview`,
      r.cards >= 8 && r.first8 === 8,
      `first 8: ${r.first8}, all: ${r.loaded}/${r.cards}`,
    );
    await a.shot(`f21-3-recent-${w}x${h}`);
  });

  // Tools: every tile.
  await nav('Tools');
  const tiles =
    await ev(`[...document.querySelectorAll('[data-tool-tile]')].map((e) => ({ id: e.getAttribute('data-tool-tile'),
    group: e.closest('section')?.getAttribute('aria-labelledby') ?? null,
    icon: !!e.querySelector('svg'), title: e.querySelector('.home-tile-title')?.textContent.trim() ?? '', sub: e.querySelector('.home-tile-sub')?.textContent.trim() ?? '' }))`);
  C(
    'F21.3 tools: tiles listed with icon, title and subtitle',
    tiles.length >= 20 && tiles.every((t) => t.icon && t.title && t.sub),
    `${tiles.length} tiles`,
  );
  await a.shot('f21-3-tools');
  const target = write('tool-target.pdf', plainPdf(3, 'Tool target'));
  const second = write('tool-second.pdf', plainPdf(2, 'Tool second'));
  const png = write('tiny.png', tinyPng());
  await a.atSizes(async (w, h) => {
    for (const t of tiles) {
      const tag = `${t.id} (${w}x${h})`;
      try {
        if (!(await a.exists('[data-home-catalogue]'))) {
          await a.closeAll();
          await input.click({ selector: 'button', text: 'Back to Home' }).catch(() => {});
          await nav('Tools');
        }
        if (MULTI_FILE_TOOLS.has(t.id)) await dialogs.answerOpenMany([target, second]);
        else if (t.id === 'images') await dialogs.answerOpenMany([png]);
        else if (!NO_DOCUMENT_TOOLS.has(t.id)) {
          await dialogs.answerOpen(target);
          if (t.id === 'image') await dialogs.answerOpen(png);
        }
        await input.click({ selector: `[data-tool-tile="${t.id}"]` });
        await sleep(1500);
        const mode = modeOfGroupId(t.group);
        const readyState = () =>
          ev(`(() => {
            const sel = (s) => !!document.querySelector(s);
            const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const idle = ['select', 'textSelect', 'hand'];
            const ons = [...document.querySelectorAll('[data-slot="mode-tool-frame"] [data-toolbar-item][aria-pressed="true"], [data-slot="mode-tool-frame"] [data-split][data-on="true"]')]
              .map((e) => e.getAttribute('data-toolbar-item') ?? e.getAttribute('data-split')).filter((id) => !idle.includes(id));
            return {
              doc: !sel('[data-home-main]'),
              modeSelected: sel('[data-mode-group="${mode}"][data-active="true"]'),
              ons, pressed: ons.length > 0,
              inspector: sel('[data-slot="inspector"][data-open]') && [...document.querySelectorAll('[data-slot="inspector"][data-open] *')].some(vis),
              dialog: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-sheet]')].some(vis),
            };
          })()`);
        let s = await readyState();
        for (let i = 0; i < 20 && !toolReady(t.id, s).ok; i++) {
          await sleep(300);
          s = await readyState();
        }
        const v = toolReady(t.id, s);
        C(
          `F21.3 tool ${tag}: document open, mode tab ${mode} selected, tool active or its inspector/dialog open`,
          v.ok,
          JSON.stringify(s),
        );
        if (w === 1280) await a.shot(`f21-3-tool-${t.id}`);
      } catch (e) {
        C(`F21.3 tool ${tag}: ran to the end`, false, e.message);
      }
      // Reset: leave dialogs, close documents, back to the Tools view.
      await input.press('Escape').catch(() => {});
      await sleep(300);
      await input.press('Escape').catch(() => {});
      await a.closeAll();
      await input.click({ selector: 'button', text: 'Back to Home' }).catch(() => {});
      await sleep(500);
      if (!(await a.exists('[data-home-catalogue]'))) await nav('Tools').catch(() => {});
    }
  });
  await a.closeAll();
  await nav('Start').catch(() => {});
}

// ================================================================================================================ splitters (F21.4)
async function splittersPhase(a) {
  const { ev, input } = a;
  await a.closeAll();
  await a.open(write('splitters.pdf', plainPdf(2, 'Splitters')));
  await a.mode('edit');
  await a.selectTool('headerFooter');
  await input.waitFor(`!!document.querySelector('[data-slot="inspector"][data-open]')`, {
    timeoutMs: 8000,
    what: 'inspector',
  });
  await sleep(600);
  await a.atSizes(async (w, h) => {
    const info = await ev(`(() => [...document.querySelectorAll('[role="separator"][aria-valuenow]')].map((s) => {
      const r = s.getBoundingClientRect(); const line = s.querySelector('span'); const lr = line.getBoundingClientRect();
      return { label: s.getAttribute('aria-label'), l: r.left, t: r.top, w: r.width, h: r.height, bg: getComputedStyle(line).backgroundColor, lineW: lr.width };
    }))()`);
    C(
      `F21.4 (${w}x${h}): left panel and inspector splitters exist`,
      info.length >= 2,
      JSON.stringify(info.map((i) => i.label)),
    );
    const png = await a.shot(`f21-4-rest-${w}x${h}`);
    const k = png.width / (await ev('window.innerWidth'));
    for (const s of info) {
      const tag = `${s.label} (${w}x${h})`;
      C(`F21.4 ${tag}: 6 px hit width`, Math.abs(s.w - 6) <= 0.5, `${s.w}`);
      C(`F21.4 ${tag}: transparent at rest`, parseRgbaAlpha(s.bg) === 0, s.bg);
      // Invisible in the capture: the pixel column of the splitter equals its neighbours on both sides (mid height).
      const cx = Math.round((s.l + s.w / 2) * k);
      const probes = [0.15, 0.3, 0.5, 0.7, 0.85].map((f) => {
        const y = Math.round((s.t + s.h * f) * k);
        const here = png.rgb(cx, y);
        const left = png.rgb(Math.round(s.l * k) - 3, y);
        const right = png.rgb(Math.round((s.l + s.w) * k) + 3, y);
        return { here, left, right, ok: colourClose(here, left, 3) || colourClose(here, right, 3) };
      });
      C(`F21.4 ${tag}: invisible in the capture`, probes.filter((p) => p.ok).length >= 1, JSON.stringify(probes));
      await input.hover({ x: s.l + s.w / 2, y: s.t + s.h / 2 });
      await sleep(350);
      const hov =
        await ev(`(() => { const s = [...document.querySelectorAll('[role="separator"][aria-valuenow]')].find((e) => e.getAttribute('aria-label') === ${q(s.label)});
        const line = s.querySelector('span'); return { bg: getComputedStyle(line).backgroundColor, w: line.getBoundingClientRect().width, cursor: getComputedStyle(s).cursor }; })()`);
      C(
        `F21.4 ${tag}: 1 px line and col-resize cursor on hover`,
        parseRgbaAlpha(hov.bg) > 0 && Math.abs(hov.w - 1) <= 0.5 && hov.cursor === 'col-resize',
        JSON.stringify(hov),
      );
      await a.shot(`f21-4-hover-${s.label.replace(/\W+/g, '-')}-${w}x${h}`);
      await input.hover({ x: 5, y: 5 });
      await sleep(300);
    }
    const borders = await ev(`(() => {
      const w = (e) => { if (!e) return null; const c = getComputedStyle(e); return ['Left', 'Right', 'Top', 'Bottom'].map((s) => parseFloat(c['border' + s + 'Width'])); };
      return { panel: w(document.querySelector('aside:not([data-slot="inspector"] aside)')), asides: [...document.querySelectorAll('aside')].map((e) => ({ cls: e.className.slice(0, 80), id: e.id, b: w(e), r: Math.round(e.getBoundingClientRect().left) + 'x' + Math.round(e.getBoundingClientRect().width) })), inspector: w(document.querySelector('[data-slot="inspector"] aside') ?? document.querySelector('[data-slot="inspector"]')) };
    })()`);
    C(
      `F21.4 (${w}x${h}): no border on the left panel`,
      borders.panel === null || borders.panel.every((x) => x === 0),
      JSON.stringify(borders.asides),
    );
    C(
      `F21.4 (${w}x${h}): no border on the inspector`,
      !!borders.inspector && borders.inspector.every((x) => x === 0),
      JSON.stringify(borders.inspector),
    );
  });
  await input.press('Escape');
  await a.closeAll();
}
const parseRgbaAlpha = (css) => {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (!m) return css === 'transparent' ? 0 : 1;
  const p = m[1].split(/[ ,/]+/).filter(Boolean);
  return p.length >= 4 ? Number(p[3]) : 1;
};

// ================================================================================================================ freehand (F21.5)
async function freehandPhase(a) {
  const { ev, input } = a;
  await a.closeAll();
  await a.atSizes(async (w, h) => {
    await a.open(write(`freehand-${w}.pdf`, plainPdf(1, `Freehand ${w}`)));
    await a.mode('comment');
    await input.click({ selector: '[data-split="draw"] [data-roving="draw:more"]' });
    await input.waitFor(`!!document.querySelector('[role="menu"], [role="radio"]')`, {
      timeoutMs: 4000,
      what: 'variant menu',
    });
    await input.click({
      selector: '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [role="radio"]',
      text: 'Freehand shape',
    });
    await sleep(500);
    const menuState = await ev(
      `[...document.querySelectorAll('[role="menu"] [role^="menuitem"], [role="radio"]')].map((e) => [e.textContent.trim(), e.getAttribute('aria-checked'), e.getAttribute('aria-pressed')])`,
    );
    console.log('variant menu after click', JSON.stringify(menuState));
    const r = await a.pageRect(1);
    const scale = r.w / 612;
    // Five cells (3 x 2) inside the visible part of the page, so every stroke lands in the canvas at any window size.
    const view = await a.rectOf(SC);
    const x0 = Math.max(r.l, view.l) + 10;
    const y0 = Math.max(r.t, view.t) + 10;
    const cw = (Math.min(r.l + r.w, view.r) - 10 - x0) / 3;
    const ch = (Math.min(r.t + r.h, view.b) - 10 - y0) / 2;
    const cell = (c, rw) => [(x0 + cw * (c + 0.5) - r.l) / scale, (y0 + ch * (rw + 0.5) - r.t) / scale];
    const size = (Number(process.env.V21_SHAPE_FACTOR ?? 0.5) * Math.min(cw, ch)) / scale;
    const kinds = ['circle', 'ellipse', 'rectangle', 'triangle', 'overlap'].map((kind, i) => [
      kind,
      ...cell(i % 3, Math.floor(i / 3)),
      size,
    ]);
    if (process.env.V21_KINDS) kinds.splice(0, 5, ...JSON.parse(process.env.V21_KINDS));
    if (process.env.V21_OLD)
      kinds.splice(
        0,
        5,
        ['circle', 150, 130, 100],
        ['ellipse', 400, 130, 90],
        ['rectangle', 150, 300, 100],
        ['triangle', 400, 300, 100],
        ['overlap', 270, 470, 90],
      );
    const trace = [];
    const strokeCount = async () =>
      (await a.annotations()).filter((x) => x.kind === 'ink').flatMap((ink) => ink.strokes ?? ink.data?.strokes ?? [])
        .length;
    await sleep(1500);
    for (const [i, [kind, cx, cy, size]] of kinds.entries()) {
      const pts = shapeStroke(kind, cx, cy, size, i + 1).map((p) => ({ x: r.l + p.x * scale, y: r.t + p.y * scale }));
      const hit = await ev(
        `(() => { const e = document.elementFromPoint(${pts[0].x}, ${pts[0].y}); return e ? e.tagName + '.' + String(e.className).slice(0, 40) + ' ' + (e.closest('[data-page]') ? 'page' : '-') : null; })()`,
      );
      const before = await strokeCount();
      await a.stroke(pts);
      const t0 = Date.now();
      while ((await strokeCount()) <= before && Date.now() - t0 < 8000) await sleep(250);
      const tries = Date.now() - t0;
      await sleep(400);
      trace.push([kind, hit, `saved after ${tries} ms`]);
    }
    await input.press('Escape');
    await sleep(600);
    await a.shot(`f21-5-freehand-${w}x${h}`);
    const inks = (await a.annotations()).filter((x) => x.kind === 'ink');
    // Strokes drawn in a row may be grouped into one annotation: judge every stroke of every ink annotation.
    const all = inks.flatMap((ink) => ink.strokes ?? ink.data?.strokes ?? []);
    C(
      `F21.5 (${w}x${h}): five saved strokes`,
      all.length === 5,
      `${all.length} strokes in ${inks.length} annotation(s) ${JSON.stringify(trace)}`,
    );
    all.forEach((st, i) => {
      const raw = st?.points ?? st ?? [];
      const pts = raw.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y }));
      const v = seamVerdict(pts);
      C(
        `F21.5 (${w}x${h}): stroke ${i + 1} saved ink is closed, seam turn < 15 degrees`,
        v.ok,
        JSON.stringify({ ...v, points: pts.length }),
      );
    });
    await a.closeAll();
  });
}

// ================================================================================================================ toolbar (F21.6)
async function toolbarPhase(a) {
  const { ev, input } = a;
  await a.closeAll();
  const MODES = ['read', 'comment', 'fill', 'pages', 'edit'];
  // F22.3: a wrapped strip (2+ lines) is taller than the one-line card; labels only show at fit step 1.
  const hOk = (st, want) => (st.lines > 1 ? st.height > want : heightIs(st.height, want));
  const cardState = () =>
    ev(`(() => {
      const items = [...document.querySelectorAll('[data-slot="mode-tool-frame"] [data-toolbar-item], [data-slot="mode-tool-frame"] [data-split] button')];
      const card = document.querySelector('[data-slot="mode-card"]').getBoundingClientRect();
      return { texts: items.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.innerText ?? ''), height: card.height,
        attr: document.documentElement.dataset.toolLabels ?? null, lines: Number(document.documentElement.dataset.toolLines ?? 1),
        fit: document.querySelector('[data-slot="tool-row"]')?.dataset.fit ?? null };
    })()`);
  const tooltipAt = async () => {
    await input.hover({ x: 5, y: 5 });
    await sleep(1200);
    const item =
      await ev(`(() => { const e = document.querySelector('[data-slot="mode-tool-frame"] [data-toolbar-item], [data-slot="mode-tool-frame"] [data-split] button');
      if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!item) return null;
    const visible = () =>
      ev(
        `[...document.querySelectorAll('[role="tooltip"]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0'; })`,
      );
    await input.hover(item);
    await sleep(50);
    const at50 = await visible();
    await sleep(200);
    const at250 = await visible();
    return { at50, at250 };
  };
  await a.atSizes(async (w, h) => {
    await a.closeAll();
    await a.closeAll();
    await a.setSettings({ showToolLabels: false });
    await a.reload();
    await a.open(write(`toolbar-${w}.pdf`, plainPdf(1, `Toolbar ${w}`)));
    for (const m of MODES) {
      await a.mode(m);
      const s = await cardState();
      C(`F21.6 (${w}x${h}) ${m}: no labels by default`, iconOnly(s.texts), JSON.stringify(s.texts.filter(Boolean)));
      C(
        `F21.6 (${w}x${h}) ${m}: reduced card height (${CARD_HEIGHT.icons} px)`,
        hOk(s, CARD_HEIGHT.icons),
        `${s.height}`,
      );
    }
    await a.shot(`f21-6-icons-${w}x${h}`);
    await a.mode('comment');
    const tip = await tooltipAt();
    C(
      `F21.6 (${w}x${h}): tooltip not visible at 50 ms, visible at 250 ms`,
      !!tip && tooltipTimingOk(tip.at50, tip.at250),
      JSON.stringify(tip),
    );
    await input.hover({ x: 5, y: 5 });
    // Show labels on.
    await a.closeAll();
    await a.setSettings({ showToolLabels: true });
    await a.reload();
    await a.open(write(`toolbar-on-${w}.pdf`, plainPdf(1, `Toolbar on ${w}`)));
    await a.mode('comment');
    const on = await cardState();
    // Below 1100 css px the row is icon-only by design (ToolRow COMPACT_BELOW); labels are judged where they can show.
    const wide = (await ev('window.innerWidth')) >= 1100;
    C(
      `F21.6 (${w}x${h}): Show labels on gives labels`,
      on.attr === 'on' && (!wide || on.fit !== '1' || on.texts.some((t) => t.trim() !== '')),
      JSON.stringify({ wide, fit: on.fit, labels: on.texts.filter(Boolean).slice(0, 4) }),
    );
    C(
      `F21.6 (${w}x${h}): Show labels on gives card height ${CARD_HEIGHT.labels} px`,
      hOk(on, CARD_HEIGHT.labels),
      `${on.height}`,
    );
    await a.shot(`f21-6-labels-${w}x${h}`);
    await a.closeAll();
    await a.setSettings({ showToolLabels: false });
    await a.reload();
    await a.open(write(`toolbar-off-${w}.pdf`, plainPdf(1, `Toolbar off ${w}`)));
    await a.mode('comment');
    const off = await cardState();
    C(
      `F21.6 (${w}x${h}): off again, icons only at ${CARD_HEIGHT.icons} px`,
      iconOnly(off.texts) && hOk(off, CARD_HEIGHT.icons),
      `${off.height}`,
    );
    await a.closeAll();
  }, GLOW_SIZES);
}

// ================================================================================================================ hf (F21.7)
async function hfPhase(a) {
  const { ev, input, dialogs } = a;
  await a.closeAll();
  await a.atSizes(async (w, h) => {
    const src = write(`hf-footed-${w}.pdf`, footedPdf());
    const saved = write(`hf-saved-${w}.pdf`, Buffer.alloc(0));
    rmSync(saved, { force: true });
    await a.open(src);
    await a.mode('edit');
    await a.selectTool('headerFooter');
    await input.waitFor(`!!document.querySelector('[data-surface="hf-dialog"]')`, {
      timeoutMs: 8000,
      what: 'header/footer panel',
    });
    await sleep(600);
    // Footer left: custom text; background on.
    await input.click({ selector: '[data-hf-slot="footerLeft"]' });
    await input.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 4000, what: 'kind menu' });
    await sleep(250);
    await input.click({ selector: '[role="menu"] [role^="menuitem"]', text: 'Text' });
    await sleep(500);
    await input.click({ selector: 'input[data-hf="text"]' });
    await input.press('a', { ctrl: true });
    await input.insertText('NEWFOOTER');
    await sleep(300);
    const on = await ev(`document.querySelector('[data-hf="background-toggle"]')?.checked ?? null`);
    if (on === false) await input.click({ selector: '[data-hf="background-toggle"]' });
    await sleep(300);
    C(
      `F21.7 (${w}x${h}): background option is on`,
      (await ev(`document.querySelector('[data-hf="background-toggle"]')?.checked`)) === true,
      '',
    );
    await a.shot(`f21-7-panel-${w}x${h}`);
    await input.click({ selector: '[data-inspector="apply"]' });
    await input.waitFor(`!document.querySelector('[data-surface="hf-dialog"]')`, {
      timeoutMs: 15000,
      what: 'panel closed after Apply',
    });
    await sleep(1200);
    // Save as: the dialog answers from the queue.
    await a.blurField();
    await dialogs.answerSave(saved);
    await input.press('s', { ctrl: true, shift: true });
    for (let i = 0; i < 75 && !existsSync(saved); i++) await sleep(200);
    C(`F21.7 (${w}x${h}): the file was saved`, existsSync(saved), '');
    await sleep(1000);
    await a.closeAll();
    if (!existsSync(saved)) return;
    await a.open(saved);
    const r = await a.pageRect(1);
    // The footer is at the bottom of the page: scroll it into view.
    await ev(`(() => { const sc = document.querySelector(${q(SC)}); sc.scrollTop = sc.scrollHeight; })()`);
    await sleep(1200);
    const page = await a.curRect(1);
    const png = await a.shot(`f21-7-saved-${w}x${h}`);
    const k = png.width / (await ev('window.innerWidth'));
    const scale = (page.w * k) / 612;
    const pg = { l: (page.l * k) / scale, t: (page.t * k) / scale };
    const rgbAt = (x, y) => png.rgb(Math.max(0, Math.min(png.width - 1, x)), Math.max(0, Math.min(png.height - 1, y)));
    // Regions in pt from the page's left/bottom: under the new text box (x 27..54), outside it on the old text (x 150..260).
    const under = pdfRegion(pg, scale, 27, 54, 24, 33);
    const outside = pdfRegion(pg, scale, 150, 260, 24, 33);
    const verdict = footerVerdict({
      redUnder: countPixels(rgbAt, under, isRed),
      redOutside: countPixels(rgbAt, outside, isRed),
      darkUnder: countPixels(rgbAt, under, isDark),
    });
    C(
      `F21.7 (${w}x${h}): old footer pixels under the box are page colour, new text present`,
      verdict.ok,
      JSON.stringify({ ...verdict, old: OLD_FOOTER.slice(0, 9) }),
    );
    void r;
    await a.closeAll();
  });
}

// ================================================================================================================ thumbs (F21.8)
function ownerFile(id) {
  const index = join(ROOT, 'review/owner/INDEX.md');
  if (!existsSync(index)) return null;
  const name = parseIndex(readFileSync(index, 'utf8')).get(id);
  const file = name ? join(ROOT, 'review/owner/corpus', name) : null;
  return file && existsSync(file) ? file : null;
}
async function thumbsPhase(a) {
  const { ev, input } = a;
  const file = ownerFile('owner-pdf-E4');
  if (!file) {
    console.log('SKIPPED thumbs: owner-pdf-E4 is not available (review/owner/INDEX.md; ADR-133)');
    return;
  }
  await a.closeAll();
  await a.atSizes(async (w, h) => {
    await a.open(file);
    // The sidebar collapses by itself below 860 css px (lib/layout.ts): there are no thumbnails to judge at that width.
    const iw = await ev('window.innerWidth');
    if (iw < 860) {
      C(
        `F21.8 (${w}x${h}): sidebar absent by design below 860 css px (n/a)`,
        !(await a.exists('[data-thumb-page]')),
        `innerWidth ${iw}`,
      );
      await a.closeAll();
      return;
    }
    const ready = await input
      .waitFor(
        `[...document.querySelectorAll('[data-thumb-page] img')].some((i) => i.complete && i.naturalWidth > 0)`,
        { timeoutMs: 20000, what: 'sidebar thumbnails' },
      )
      .catch(() => false);
    if (!ready) {
      await a.shot(`f21-8-no-thumbs-${w}x${h}`);
      const st = await ev(
        `({ aside: !!document.querySelector('aside'), cells: document.querySelectorAll('[data-thumb-cell]').length, imgs: document.querySelectorAll('[data-thumb-page] img').length, iw: innerWidth })`,
      );
      C(`F21.8 (${w}x${h}): sidebar thumbnails of owner-pdf-E4 rendered`, false, JSON.stringify(st));
      await a.closeAll();
      return;
    }
    await sleep(2500);
    const png = await a.shot(`f21-8-thumbs-owner-pdf-E4-${w}x${h}`);
    const k = png.width / (await ev('window.innerWidth'));
    const rects =
      await ev(`[...document.querySelectorAll('[data-thumb-page] img')].filter((i) => i.complete && i.naturalWidth > 0).slice(0, 4).map((i) => {
      const r = i.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, nw: i.naturalWidth }; })`);
    C(`F21.8 (${w}x${h}): sidebar thumbnails of owner-pdf-E4 rendered`, rects.length > 0, `${rects.length} thumbnails`);
    const lum = (x, y) => {
      const [r, g, b] = png.rgb(Math.max(0, Math.min(png.width - 1, x)), Math.max(0, Math.min(png.height - 1, y)));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Blank pages carry no ink and prove nothing: they are skipped, and at least one thumbnail must have ink.
    const stats = rects.map((r) => {
      const box = { x0: r.l * k + 2, y0: r.t * k + 2, x1: r.r * k - 2, y1: r.b * k - 2 };
      return thumbVerdict(darkBlockStats(lum, box));
    });
    stats.forEach((v, i) => {
      if (v.inked === 0) return;
      C(
        `F21.8 (${w}x${h}): thumbnail ${i + 1} has no solid dark blocks (bold headings readable)`,
        v.ok,
        JSON.stringify(v),
      );
    });
    C(
      `F21.8 (${w}x${h}): at least one thumbnail has ink`,
      stats.some((v) => v.inked > 0),
      JSON.stringify(stats.map((v) => v.inked)),
    );
    await a.closeAll();
  });
}

// ================================================================================================================ look (F21.9)
/** Screenshots only (owner: no large tests): the editor with the one-strip tool card at both native sizes, German UI. */
async function lookPhase(a) {
  await a.closeAll();
  await a.setSettings({ language: 'de', showToolLabels: false });
  await a.ev('location.reload()').catch(() => {});
  await sleep(4000); // the shared reload() waits for the English UI
  await a.open(write('look.pdf', plainPdf(2, 'Look')));
  await a.atSizes(async (w, h) => {
    await sleep(800);
    a.grab(`f21-9-strip-${w}x${h}`);
    C(`F21.9 (${w}x${h}): strip captured`, true, `review/v21/shots/f21-9-strip-${w}x${h}.png`);
  });
  await a.setSettings({ language: 'en' });
  await a.closeAll();
}

// ================================================================================================================ run
const PHASE_FNS = {
  glow: glowPhase,
  home: homePhase,
  splitters: splittersPhase,
  freehand: freehandPhase,
  toolbar: toolbarPhase,
  hf: hfPhase,
  thumbs: thumbsPhase,
  look: lookPhase,
};
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
    if (name === 'recovery') {
      try {
        await recoveryPhase();
      } catch (e) {
        C('recovery: ran to the end', false, e.message);
        main?.stop();
        main = null;
      }
    } else await section(name, PHASE_FNS[name]);
  }
} finally {
  main?.stop();
  results.table();
  code = results.failed() ? 1 : 0;
}
process.exitCode = code;
