// Shared bits for the acceptance scripts (ADR-131): session + guard + results table. Node 22 built-ins only.
import { launch } from './launch.mjs';
import { createInput } from './cdp-input.mjs';
import { createDialogs } from './dialogs.mjs';
import { startGuard } from './guard.mjs';

export const SCROLLER = '[data-action-scope="canvas"] > [role="region"]';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collects checks: check(name, ok, detail). table() prints them, failed() says whether any FAIL. */
export function createResults() {
  const rows = [];
  return {
    rows,
    check(name, ok, detail = '') {
      rows.push({ name, ok: !!ok, detail: String(detail) });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
      return !!ok;
    },
    failed: () => rows.some((r) => !r.ok),
    table() {
      const w = Math.max(5, ...rows.map((r) => r.name.length));
      console.log('\n' + 'check'.padEnd(w) + '  result  detail');
      for (const r of rows) console.log(r.name.padEnd(w) + '  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + '  ' + r.detail);
      console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} PASS`);
    },
  };
}

/** One acceptance session: launch, guard, body(ctx), table, close. Exit code 1 on any FAIL or error. */
export async function runSession(body, results) {
  const session = await launch();
  const guard = startGuard(session.pid);
  let code = 0;
  try {
    const input = createInput(session, { guard });
    const dialogs = createDialogs(session, input);
    const ctx = { session, input, dialogs, results, ev: session.evaluate, shot: (n) => input.screenshot(n) };
    await Promise.race([body(ctx), guard.aborted]);
  } catch (e) {
    results.check('script ran to the end', false, e.message);
  } finally {
    guard.stop();
    session.close();
  }
  return results.failed() ? 1 : code;
}

/**
 * Counts backend calls per command from now on. __TAURI_INTERNALS__.invoke is read-only, so the calls are counted where they leave
 * the page: window.fetch (ipc.localhost/<cmd>) and Resource Timing entries; the larger of both counts wins.
 */
export async function installInvokeCounter(ev) {
  await ev(`(() => {
    if (window.__counted) return;
    window.__counted = true; window.__calls = {};
    performance.setResourceTimingBufferSize(200000);
    const orig = window.fetch.bind(window);
    window.fetch = (input, ...rest) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      const at = url.indexOf('localhost/');
      if (at >= 0 && url.includes('ipc')) {
        const c = url.slice(at + 10).split(/[?#]/)[0];
        window.__calls[c] = (window.__calls[c] ?? 0) + 1;
      }
      return orig(input, ...rest);
    };
  })()`);
}
export const callCount = (ev, cmd) =>
  ev(
    `Math.max(window.__calls?.[${JSON.stringify(cmd)}] ?? 0, performance.getEntriesByType('resource').filter((e) => e.name.includes(${JSON.stringify('/' + cmd)})).length)`,
  );

export async function openAndWait(ctx, path) {
  const { dialogs, input } = ctx;
  await input.sleep(1000);
  await dialogs.openFile(path);
  await input.waitFor(`document.querySelectorAll('[data-page] img').length > 0`, {
    timeoutMs: 40000,
    what: 'page image',
  });
  await input.sleep(800);
}
