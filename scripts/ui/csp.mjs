// Dev only. `node scripts/ui/cdp.mjs csp [--attach]` is the release-CSP gate (ROADMAP M7 "CSP hardening", ADR-053 section 5).
// Default: serves ./dist (run `npm run build` first) with the release CSP from src-tauri/tauri.conf.json, opens it in a headless
//   Chromium (Edge or Chrome) with a stub backend and collects `securitypolicyviolation` events while clicking through the
//   empty state, the settings popover and every toolbar button. Exit code 1 on any violation.
// --attach: the running dev app (127.0.0.1:9222) keeps its dev CSP, so instead record every write the release `style-src 'self'`
//   would block (setAttribute('style'), <style> elements, inline style in parsed markup). Open a PDF and use tools first, then read
//   `cdp.mjs eval "JSON.stringify(window.__csp)"`.
// CSSOM writes (element.style.x = ..., React style props, CSS variables) are not blocked by style-src and are not reported.
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};
const PORT = 9333;

/** Injected before any page script: records violations and the inline-style writes the CSP would block. */
const PROBE = `(() => {
  const out = (window.__csp = window.__csp || []);
  document.addEventListener('securitypolicyviolation', (e) => out.push({ kind: 'violation', directive: e.violatedDirective, blocked: String(e.blockedURI), sample: e.sample, source: e.sourceFile + ':' + e.lineNumber }), true);
  const stack = () => String(new Error().stack).split('\\n').slice(3, 6).join(' | ');
  const set = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (String(n).toLowerCase() === 'style') out.push({ kind: 'setAttribute(style)', sample: String(v).slice(0, 80), source: stack() });
    return set.call(this, n, v);
  };
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      for (const x of [n, ...n.querySelectorAll('style')].filter((y) => y.localName === 'style')) out.push({ kind: '<style> element', sample: x.outerHTML.slice(0, 80), source: '' });
    }
  }).observe(document, { childList: true, subtree: true });
})();`;

const STUB = `(() => {
  const settings = { glass: 'auto', theme: 'system', language: 'system', leftPanelWidth: 248, welcomeTour: 'shown', authorName: '', authorPrompt: 'done' };
  const boot = { platform: 'windows', reducedTransparency: false, version: '0.0.0', authorSuggestion: '', paper: 'a4' };
  let cb = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: () => ++cb,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd) => {
      if (cmd === 'app_ready') return boot;
      if (cmd === 'get_settings' || cmd === 'update_settings') return settings;
      if (cmd === 'list_recents' || cmd === 'recent_files') return [];
      throw { code: 'unsupported_feature', message: 'stub backend' };
    },
  };
})();`;

function serve(dist, csp) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    let file = join(dist, path || 'index.html');
    if (!file.startsWith(dist) || !existsSync(file) || !extname(file)) file = join(dist, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp,
    });
    res.end(readFileSync(file));
  });
  return new Promise((res) => server.listen(PORT + 1, '127.0.0.1', () => res(server)));
}

async function wsClient(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('websocket failed'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message));
    else p.res(m.result);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exercise(c) {
  const key = (k, mods = 0) =>
    c.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: k,
      code: k === ',' ? 'Comma' : k,
      modifiers: mods,
      windowsVirtualKeyCode: k === 'Escape' ? 27 : k.charCodeAt(0),
    });
  await sleep(800); // empty state
  if (process.env.CSP_SELFTEST)
    await c.evaluate(
      "document.head.insertAdjacentHTML('beforeend', '<style>a{}</style>'); document.body.insertAdjacentHTML('beforeend', '<i style=\"color:red\">x</i>')",
    );
  await key(',', 2); // Ctrl+, opens the settings popover
  await sleep(300);
  await key('Escape');
  const count = await c.evaluate(`document.querySelectorAll('[role="toolbar"] button').length`);
  for (let i = 0; i < count; i++) {
    await c.evaluate(
      `(() => { const b = document.querySelectorAll('[role="toolbar"] button')[${i}]; if (b && !b.disabled) b.click(); })()`,
    );
    await sleep(200);
    await key('Escape');
  }
  await sleep(300);
  return count;
}

export async function runCsp(args) {
  let browser = null;
  let server = null;
  let c;
  try {
    if (args.includes('--attach')) {
      const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
      if (!page) throw new Error('no page target; is scripts/ui/dev.mjs running?');
      c = await wsClient(page.webSocketDebuggerUrl);
      await c.evaluate(PROBE);
    } else {
      const dist = join(process.cwd(), 'dist');
      if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ missing; run `npm run build` first');
      const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
      const csp = conf.app?.security?.csp;
      if (typeof csp !== 'string' || !csp.includes("style-src 'self'") || csp.includes('unsafe-inline')) {
        throw new Error(`release csp missing or not strict: ${csp}`);
      }
      server = await serve(dist, csp);
      const exe = [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ].find(existsSync);
      if (!exe) throw new Error('no Edge or Chrome found');
      browser = spawn(
        exe,
        [
          '--headless=new',
          `--remote-debugging-port=${PORT}`,
          `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sheer-csp-'))}`,
          '--window-size=1280,800',
          'about:blank',
        ],
        { stdio: 'ignore' },
      );
      let page;
      for (let i = 0; i < 50 && !page; i++) {
        await sleep(200);
        page = await fetch(`http://127.0.0.1:${PORT}/json`)
          .then((r) => r.json())
          .then((t) => t.find((x) => x.type === 'page'))
          .catch(() => null);
      }
      if (!page) throw new Error('browser did not start');
      c = await wsClient(page.webSocketDebuggerUrl);
      await c.send('Page.enable');
      await c.send('Page.setBypassCSP', { enabled: false });
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB + PROBE });
      await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT + 1}/` });
    }
    const buttons = await exercise(c);
    const found = JSON.parse(await c.evaluate('JSON.stringify(window.__csp || [])'));
    const seen = new Set();
    const unique = found.filter((f) => !seen.has(JSON.stringify(f)) && seen.add(JSON.stringify(f)));
    console.log(`csp: exercised empty state, settings, ${buttons} toolbar buttons; violations=${unique.length}`);
    for (const f of unique)
      console.log(' -', f.kind, f.directive ?? '', f.blocked ?? '', JSON.stringify(f.sample), f.source);
    process.exitCode = unique.length > 0 ? 1 : 0;
  } finally {
    c?.close();
    browser?.kill();
    server?.close();
  }
}
