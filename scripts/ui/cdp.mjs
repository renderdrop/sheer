// Dev only. Drives the running dev app over CDP (127.0.0.1:9222). Node 22 built-ins only.
// Usage: node scripts/ui/cdp.mjs eval <js> | theme light|dark|system | fps <ms> [--during <js>]
const BASE = 'http://127.0.0.1:9222';

async function connect() {
  const targets = await (await fetch(`${BASE}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
  if (!page) throw new Error('no page target; is scripts/ui/dev.sh running?');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('websocket failed'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
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
  return { evaluate, close: () => ws.close() };
}

const [cmd, ...rest] = process.argv.slice(2);
const cdp = await connect();
try {
  if (cmd === 'eval') {
    const v = await cdp.evaluate(rest.join(' '));
    if (v !== undefined) console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  } else if (cmd === 'theme') {
    const mode = rest[0];
    if (!['light', 'dark', 'system'].includes(mode)) throw new Error('theme light|dark|system');
    // Vite may serve several instances of the store (HMR adds ?t=... URLs); set the theme on every one,
    // so the instance the app is bound to is always included.
    await cdp.evaluate(
      `Promise.all([...new Set(['/src/stores/settings.ts', ...performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/stores/settings.ts'))])].map((u) => import(u).then((m) => m.useSettings.getState().setTheme(${JSON.stringify(mode)}))))`,
    );
    await new Promise((r) => setTimeout(r, 400));
    console.log(`theme=${mode}`);
  } else if (cmd === 'fps') {
    const ms = Number(rest[0] ?? 2000);
    const di = rest.indexOf('--during');
    const during = di >= 0 ? rest.slice(di + 1).join(' ') : '';
    const collect = `new Promise((resolve) => {
      const t = []; let last = performance.now(); const end = last + ${ms};
      const tick = (now) => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else resolve(t.slice(1)); };
      requestAnimationFrame(tick);
    })`;
    const run = during ? cdp.evaluate(`(async()=>{ ${during} })()`).catch(() => {}) : null;
    const t = await cdp.evaluate(collect);
    if (run) await run;
    const s = [...t].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const sum = t.reduce((a, b) => a + b, 0);
    console.log(
      `frames=${t.length} p50=${q(0.5).toFixed(1)}ms p95=${q(0.95).toFixed(1)}ms min_fps=${(1000 / s[s.length - 1]).toFixed(1)} avg_fps=${((t.length * 1000) / sum).toFixed(1)}`,
    );
  } else {
    throw new Error('commands: eval <js> | theme light|dark|system | fps <ms> [--during <js>]');
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exitCode = 1;
} finally {
  cdp.close();
}
