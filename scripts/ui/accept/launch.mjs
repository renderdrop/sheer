// Starts the ACCEPTANCE build only (ADR-131, rule 15) with remote debugging on 127.0.0.1 and returns a CDP session.
// Never the dev exe, the release exe or anything installed. Node 22 built-ins only.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAcceptanceExe } from './pure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const ACCEPTANCE_EXE = resolve(ROOT, 'src-tauri/target-acceptance/release/sheer-acceptance.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUp(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).json();
  } catch {
    return null;
  }
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('websocket failed'));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method) return listeners.get(msg.method)?.(msg.params);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(msg.error.message));
    else p.res(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, on: (m, f) => listeners.set(m, f), closeWs: () => ws.close() };
}

/**
 * launch({ exe, port, viewport: {w, h}, timeoutMs }) -> session
 * session: { pid, port, vp, send, evaluate, on, close() }. close() kills only the spawned process tree (by pid, never by name).
 */
export async function launch({
  exe = ACCEPTANCE_EXE,
  port = 9400 + Math.floor(Math.random() * 400),
  viewport = { w: 1280, h: 800 },
  timeoutMs = 30000,
} = {}) {
  if (!isAcceptanceExe(exe))
    throw new Error(`refusing to launch ${exe}: only target-acceptance/**/sheer-acceptance.exe is allowed (rule 15)`);
  if (!existsSync(exe)) throw new Error(`acceptance build missing: ${exe}; run \`npm run build:acceptance\``);
  if (await cdpUp(port))
    throw new Error(`port ${port} already answers CDP; refusing to attach to a process that is not ours`);

  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
    stdio: 'ignore',
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  const close = () => {
    if (exited || !child.pid) return;
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  };
  try {
    const t0 = Date.now();
    let cdp = null;
    while (!cdp) {
      if (exited) throw new Error('acceptance exe exited before CDP came up');
      if (Date.now() - t0 > timeoutMs) throw new Error(`CDP did not come up within ${timeoutMs} ms`);
      if (await cdpUp(port)) cdp = await connect(port).catch(() => null);
      if (!cdp) await sleep(250);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.w,
      height: viewport.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Wait until the app shell rendered.
    for (
      let i = 0;
      i < 80 &&
      !(await cdp.evaluate('document.readyState === "complete" && !!document.getElementById("root")?.children.length'));
      i++
    )
      await sleep(250);
    return {
      pid: child.pid,
      port,
      vp: viewport,
      send: cdp.send,
      evaluate: cdp.evaluate,
      on: cdp.on,
      close: () => {
        cdp.closeWs();
        close();
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}
