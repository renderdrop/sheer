// Dev only. Drives the running dev app over CDP (127.0.0.1:9222). Node 22 built-ins only.
// Usage: node scripts/ui/cdp.mjs eval <js> | theme light|dark|system | fps <ms> [--during <js>]
//   | record <ms> --out review/x.png [--during <js>] [--delay <ms>] [--scale 0.5]
import { writeFileSync, mkdirSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { dirname } from 'node:path';

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
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method) {
      listeners.get(msg.method)?.(msg.params);
      return;
    }
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
  return { evaluate, send, on: (m, f) => listeners.set(m, f), close: () => ws.close() };
}

function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

function parsePng(buf) {
  const out = { ihdr: null, idat: [] };
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') out.ihdr = data;
    else if (type === 'IDAT') out.idat.push(data);
    o += 12 + len;
  }
  return out;
}

// frames: [{ png: Buffer, delayMs }]. Frames whose IHDR differs from the first are dropped.
function buildApng(frames) {
  const parsed = frames.map((f) => ({ ...parsePng(f.png), delayMs: f.delayMs, png: f.png }));
  const ihdr = parsed[0].ihdr;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const ok = parsed.filter((p) => p.ihdr.equals(ihdr));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(ok.length);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('acTL', actl)];
  let seq = 0;
  ok.forEach((p, i) => {
    const f = Buffer.alloc(26);
    f.writeUInt32BE(seq++, 0);
    f.writeUInt32BE(w, 4);
    f.writeUInt32BE(h, 8);
    f.writeUInt16BE(Math.min(65535, Math.max(1, Math.round(p.delayMs))), 20);
    f.writeUInt16BE(1000, 22);
    parts.push(chunk('fcTL', f));
    for (const d of p.idat) {
      if (i === 0) parts.push(chunk('IDAT', d));
      else {
        const s = Buffer.alloc(4);
        s.writeUInt32BE(seq++);
        parts.push(chunk('fdAT', Buffer.concat([s, d])));
      }
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return { apng: Buffer.concat(parts), ok };
}

async function record(cdp, rest) {
  const ms = Number(rest[0] ?? 1500);
  const arg = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const out = arg('--out');
  if (!out) throw new Error('record <ms> --out review/<name>.png');
  const delay = Number(arg('--delay') ?? 0);
  const scale = Number(arg('--scale') ?? 0.5);
  const di = rest.indexOf('--during');
  const during = di >= 0 ? rest[di + 1] : '';
  const dims = await cdp.evaluate('({w: innerWidth * devicePixelRatio, h: innerHeight * devicePixelRatio})');
  const frames = [];
  const acks = [];
  cdp.on('Page.screencastFrame', (p) => {
    frames.push({ png: Buffer.from(p.data, 'base64'), t: p.metadata.timestamp * 1000 });
    acks.push(cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {}));
  });
  const t0 = performance.now();
  await cdp.send('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
    maxWidth: Math.round(dims.w * scale),
    maxHeight: Math.round(dims.h * scale),
  });
  const run = during
    ? new Promise((r) => setTimeout(r, delay)).then(() => cdp.evaluate(`(async()=>{ ${during} })()`)).catch((e) => console.error(String(e.message ?? e)))
    : null;
  await new Promise((r) => setTimeout(r, ms));
  await cdp.send('Page.stopScreencast');
  const elapsed = performance.now() - t0;
  if (run) await run;
  await Promise.all(acks);
  if (frames.length === 0) throw new Error('no frames captured');
  const withDelay = frames.map((f, i) => ({
    png: f.png,
    delayMs: i + 1 < frames.length ? frames[i + 1].t - f.t : 100,
  }));
  const { apng, ok } = buildApng(withDelay);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, apng);
  const base = out.replace(/\.png$/i, '');
  const n = Math.min(6, ok.length);
  for (let k = 0; k < n; k++) {
    const idx = n === 1 ? 0 : Math.round((k * (ok.length - 1)) / (n - 1));
    writeFileSync(`${base}-f${String(k + 1).padStart(2, '0')}.png`, ok[idx].png);
  }
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : elapsed;
  console.log(
    `frames=${ok.length} capture_fps=${((frames.length - 1) / (span / 1000)).toFixed(1)} span=${span.toFixed(0)}ms wall=${elapsed.toFixed(0)}ms -> ${out}`,
  );
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
  } else if (cmd === 'record') {
    await record(cdp, rest);
  } else {
    throw new Error('commands: eval <js> | theme light|dark|system | fps <ms> [--during <js>] | record <ms> --out <png> [--during <js>] [--delay <ms>] [--scale 0.5]');
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exitCode = 1;
} finally {
  cdp.close();
}
