// The ONLY acceptance script that uses the real OS mouse and keyboard (ADR-131). Hard cap 5 minutes.
// Announce it in the chat before and after. Run: node scripts/ui/accept/smoke-real.mjs
// Flow: launch acceptance build, queue an Open answer, real Ctrl+O, real click on the page area, screenshot.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from './launch.mjs';
import { createInput } from './cdp-input.mjs';
import { createDialogs } from './dialogs.mjs';
import { startGuard } from './guard.mjs';

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
  const run = async () => {
    guard.step('queue open');
    await dialogs.answerOpen('review/owner/corpus/2025_Rechnung_202500100.pdf');
    guard.step('real Ctrl+O');
    os('-ProcId', String(session.pid), '-Action', 'key', '-Keys', '^o');
    await input.waitForTarget({ selector: 'canvas' }, { timeoutMs: 20000 });
    guard.step('real click on page area');
    os('-ProcId', String(session.pid), '-Action', 'click', '-Fx', '0.5', '-Fy', '0.5');
    await input.sleep(500);
    console.log('screenshot:', await input.screenshot('accept-smoke-real.png'));
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
