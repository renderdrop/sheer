// The ONLY acceptance script that uses the real OS mouse and keyboard (ADR-131). Hard cap 5 minutes.
// Announce it in the chat before and after. Run: node scripts/ui/accept/smoke-real.mjs
// Flow: launch acceptance build, queue an Open answer, real Ctrl+O, real click on the page area, screenshot.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from './launch.mjs';
import { createInput } from './cdp-input.mjs';
import { createDialogs } from './dialogs.mjs';
import { startGuard } from './guard.mjs';
import { corpusFile } from './corpus.mjs';

const CAP_MS = 5 * 60 * 1000;
const OS = fileURLToPath(new URL('./os-input.ps1', import.meta.url));
const os = (...a) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OS, ...a], {
    stdio: 'inherit',
    timeout: 15000,
  });

const t0 = Date.now();
console.log(`=== REAL OS INPUT SMOKE START ${new Date(t0).toISOString()} (cap 5 min) ===`);
const session = await launch();
const guard = startGuard(session.pid);
const cap = setTimeout(() => {
  console.error('=== HARD CAP REACHED, killing ===');
  guard.stop();
  session.close();
  process.exit(2);
}, CAP_MS);
let code = 0;
try {
  const input = createInput(session, { guard });
  const dialogs = createDialogs(session, input);
  const ev = (js) => session.evaluate(js);
  const SC = `document.querySelector('[data-action-scope="canvas"] > [role="region"]')`;
  const RUN = '[data-links-list] [data-smartlink][data-link-kind="footnote"] [data-smartlink-run]';
  const run = async () => {
    guard.step('queue open');
    await dialogs.answerOpenMany([corpusFile('corpus-12')]);
    guard.step('real Ctrl+O');
    os('-ProcId', String(session.pid), '-Action', 'key', '-Keys', '^o');
    await input.waitFor(`document.querySelectorAll('[data-page] img').length > 0`, { timeoutMs: 40000, what: 'page' });
    guard.step('find a footnote link');
    for (let i = 0; i < 60 && !(await ev(`!!document.querySelector('${RUN}')`)); i++) {
      await ev(`${SC}.scrollTop += ${SC}.clientHeight * 0.8`);
      await input.sleep(400);
    }
    await ev(`document.querySelector('${RUN}').scrollIntoView({ block: 'center' })`);
    await input.sleep(600);
    const before = await ev(`${SC}.scrollTop`);
    const at = await ev(`(() => { const r = document.querySelector('${RUN}').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, s: window.devicePixelRatio }; })()`);
    // Diagnostics: what the page receives from the real click (target, shift state, movement).
    await ev(`(() => { window.__smokeLog = [];
      for (const t of ['pointerdown', 'pointerup', 'click']) document.addEventListener(t, (e) => window.__smokeLog.push(
        [t, e.target?.getAttribute?.('data-smartlink-run') !== null ? 'run' : (e.target?.tagName ?? '?'), e.shiftKey, Math.round(e.clientX), Math.round(e.clientY), e.defaultPrevented]), true);
      return true; })()`);
    console.log('target centre (CSS px):', Math.round(at.x), Math.round(at.y));
    guard.step('real click on the footnote marker');
    os(
      '-ProcId',
      String(session.pid),
      '-Action',
      'clickclient',
      '-Cx',
      String(at.x),
      '-Cy',
      String(at.y),
      '-Scale',
      String(at.s),
    );
    await input.sleep(1500);
    console.log('events:', JSON.stringify(await ev('window.__smokeLog')));
    const after = await ev(`${SC}.scrollTop`);
    console.log(`jump: scrollTop ${before} -> ${after} ${after !== before ? 'PASS' : 'FAIL'}`);
    if (after === before) code = 1;
    console.log('screenshot:', await input.screenshot('v160/smoke-real-jumped.png'));
    guard.step('real Alt+Left');
    os('-ProcId', String(session.pid), '-Action', 'key', '-Keys', '%{LEFT}');
    await input.sleep(1000);
    const back = await ev(`${SC}.scrollTop`);
    console.log(`back: scrollTop ${back} (expected ${before}) ${Math.abs(back - before) <= 1 ? 'PASS' : 'FAIL'}`);
    if (Math.abs(back - before) > 1) code = 1;
    console.log('screenshot:', await input.screenshot('v160/smoke-real-back.png'));
  };
  await Promise.race([run(), guard.aborted]);
} catch (e) {
  console.error('FAILED:', e.message);
  code = 1;
} finally {
  clearTimeout(cap);
  guard.stop();
  session.close();
  console.log(
    `=== REAL OS INPUT SMOKE END ${new Date().toISOString()} (${Math.round((Date.now() - t0) / 1000)} s, exit ${code}) ===`,
  );
}
process.exit(code);
