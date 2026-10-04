// Window smoke test for annotation input (docs/UI_REVIEW.md, milestone DoD). Node 22, built-ins only.
// Needs the dev window: `node scripts/ui/dev.mjs` (WebView2 CDP on 127.0.0.1:9222). It opens tests/fixtures/text.pdf (second launch of
// the debug exe forwards the file) and the welcome document, and for each tool makes one annotation with REAL CDP mouse and keyboard
// input, then checks the annotations store. jsdom cannot see hit-testing (F9: pointer-events), so this is the only guard for it.
// Usage: node scripts/ui/annot-smoke.mjs        exit code 0 = every row passed, 1 = a row failed.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const BASE = 'http://127.0.0.1:9222';
const root = resolve(import.meta.dirname, '..', '..');
const exe = resolve(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'sheer.exe' : 'sheer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${BASE}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
if (!page) throw new Error('no page target; run `node scripts/ui/dev.mjs` first');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket failed'));
});
let n = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails)
    throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return m.result?.result?.value;
};

// The store instances the app is bound to (a fresh dev start has one; plain URLs are those).
const mod = (path) => `import('/src/${path}')`;
const S = {
  ui: mod('stores/ui.ts'),
  tools: mod('stores/tools.ts'),
  ann: mod('stores/annotations.ts'),
  docs: mod('stores/documents.ts'),
  place: mod('features/signatures/place/store.ts'),
  tour: mod('features/tour/runtime.ts'),
  sigs: mod('api/signatures.ts'),
};

const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const drag = async (a, b, steps = 8) => {
  await mouse('mouseMoved', a.x, a.y, { button: 'none' });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { buttons: 1 });
    await sleep(25);
  }
  await mouse('mouseReleased', b.x, b.y);
};
const click = async (p) => {
  await mouse('mouseMoved', p.x, p.y, { button: 'none' });
  await mouse('mousePressed', p.x, p.y);
  await sleep(40);
  await mouse('mouseReleased', p.x, p.y);
};

/** Annotations of the active document as `kind:n` counts, from the store. */
const kinds = () =>
  ev(`(async()=>{const d=(await ${S.docs}).useDocuments.getState();const a=(await ${S.ann}).useAnnotations.getState().byDoc[d.activeId]?.byId??{};
    const c={};for(const x of Object.values(a)){c[x.kind]=(c[x.kind]??0)+1}return c})()`);
const activeDoc = () =>
  ev(
    `(async()=>{const d=(await ${S.docs}).useDocuments.getState();return {id:d.activeId,name:d.byId[d.activeId]?.displayName,kind:d.byId[d.activeId]?.kind}})()`,
  );
const selectTool = (tool) =>
  ev(
    `(async()=>{const u=(await ${S.ui}).useUi.getState();u.lockTool('select');u.selectTool(${JSON.stringify(tool)})})()`,
  );
const setVariant = (fn, v) => ev(`(async()=>{(await ${S.tools}).useTools.getState().${fn}(${JSON.stringify(v)})})()`);

async function pageBox() {
  await ev(`document.querySelector('[data-page="1"]')?.scrollIntoView({block:'start'})`);
  await sleep(300);
  return JSON.parse(await ev(`JSON.stringify(document.querySelector('[data-page="1"]').getBoundingClientRect())`));
}
/** The centre of the first word-ish text on the page (a text-layer span), as viewport coordinates, or null. */
const textSpot = () =>
  ev(`(()=>{const el=document.querySelector('[data-page="1"] [data-text-layer] span, [data-page="1"] .textLayer span, [data-page="1"] [data-testid=text-layer] span');
    if(!el)return null;const r=el.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom}})()`);

const rows = [];
async function row(doc, tool, run) {
  let result;
  try {
    const before = await kinds();
    const expected = await run();
    await sleep(900); // the ink group commits 1000 ms after its last stroke: callers wait for it themselves
    const after = await kinds();
    const got = after[expected] ?? 0;
    const was = before[expected] ?? 0;
    result = got > was ? 'PASS' : `FAIL (${expected}: ${was} -> ${got})`;
  } catch (e) {
    result = `FAIL (${e.message.split('\n')[0]})`;
  }
  await selectTool('select');
  await key('Escape', 'Escape', 27);
  rows.push({ doc, tool, result });
}

async function openFile(label, open, match) {
  await open();
  for (let i = 0; i < 40; i++) {
    const d = await activeDoc();
    if (d.id !== null && match(d)) break;
    await sleep(250);
  }
  const d = await activeDoc();
  if (!match(d)) throw new Error(`${label} did not open`);
  await ev(`document.querySelector('[data-page="1"]')`);
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('[data-page="1"] canvas, [data-page="1"] img')`)); i++)
    await sleep(250);
  await sleep(500);
  return d;
}

async function suite(doc) {
  const box = await pageBox();
  // Fractions of the part of the page that is on screen: CDP mouse events outside the viewport hit nothing.
  const visible = Math.min(box.height, (await ev('window.innerHeight')) - box.top - 24);
  const at = (fx, fy) => ({ x: box.left + box.width * fx, y: box.top + visible * fy });

  await row(doc, 'Highlight (text)', async () => {
    await selectTool('highlight');
    await setVariant('setMarkup', 'highlight');
    await sleep(500);
    const s = await textSpot();
    const a = s ? { x: s.l + 2, y: (s.t + s.b) / 2 } : at(0.2, 0.15);
    const b = s ? { x: s.r - 2, y: (s.t + s.b) / 2 } : at(0.7, 0.15);
    await drag(a, b);
    return 'highlight';
  });
  await row(doc, 'Note (click)', async () => {
    await selectTool('note');
    await click(at(0.75, 0.3));
    // The popover takes focus; an empty new note is taken back on close, so it gets a body.
    let body = false;
    for (let i = 0; i < 10 && !body; i++) {
      body = await ev(`document.activeElement?.tagName==='TEXTAREA'`);
      if (!body) await sleep(100);
    }
    if (!body) throw new Error('note popover did not take focus');
    await send('Input.insertText', { text: 'Note smoke' });
    await key('Escape', 'Escape', 27);
    await sleep(500);
    return 'note';
  });
  await row(doc, 'Text (click+type)', async () => {
    await selectTool('text');
    await click(at(0.2, 0.45));
    let editor = false;
    for (let i = 0; i < 10 && !editor; i++) {
      editor = await ev(`document.activeElement?.tagName==='TEXTAREA'`);
      if (!editor) await sleep(100);
    }
    if (!editor) throw new Error('no text editor took focus');
    await send('Input.insertText', { text: 'Smoke' });
    await key('Escape', 'Escape', 27);
    await sleep(500);
    const lines = await ev(
      `(async()=>{const d=(await ${S.docs}).useDocuments.getState();return Object.values((await ${S.ann}).useAnnotations.getState().byDoc[d.activeId]?.byId??{}).filter(a=>a.kind==='freeText'&&a.lines.join('').includes('Smoke')).length})()`,
    );
    if (lines === 0) throw new Error('typed text not committed');
    return 'freeText';
  });
  await row(doc, 'Draw (stroke)', async () => {
    await selectTool('draw');
    await drag(at(0.25, 0.6), at(0.55, 0.68), 14);
    await sleep(1300); // INK_JOIN_MS
    return 'ink';
  });
  await row(doc, 'Rectangle (drag)', async () => {
    await selectTool('shapes');
    await setVariant('setShapes', 'rect');
    await sleep(300);
    await drag(at(0.3, 0.75), at(0.6, 0.85));
    return 'rect';
  });
  // M4: Fill and Sign marks and a signature through the placing layer.
  await row(doc, 'Fill&Sign check mark', async () => {
    await selectTool('signature');
    await ev(`(async()=>{(await ${S.place}).usePlacement.getState().arm({type:'mark',glyph:'check'})})()`);
    await sleep(300);
    await click(at(0.8, 0.5));
    return 'mark';
  });
  await row(doc, 'Fill&Sign date', async () => {
    await selectTool('signature');
    await ev(`(async()=>{(await ${S.place}).usePlacement.getState().arm({type:'date'})})()`);
    await sleep(300);
    await click(at(0.8, 0.6));
    return 'freeText';
  });
  await row(doc, 'Signature (typed)', async () => {
    await selectTool('signature');
    await ev(`(async()=>{const s=await ${S.sigs};const d=await s.createTypedSignature('signature','Sheer');
      (await ${S.place}).usePlacement.getState().arm({type:'signature',role:'signature',ref:{type:'draft',id:d.id},aspect:d.art.w/d.art.h})})()`);
    await sleep(300);
    await click(at(0.5, 0.9));
    return 'signature';
  });
}

try {
  await ev(`window.focus()`);
  const text = await openFile(
    'text.pdf',
    () => spawn(exe, [resolve(root, 'tests', 'fixtures', 'text.pdf')], { stdio: 'ignore' }).unref(),
    (d) => d.name === 'text.pdf' || /text/i.test(d.name ?? ''),
  );
  console.log('opened', JSON.stringify(text));
  await suite('text.pdf');
  const welcome = await openFile(
    'welcome',
    () => ev(`(async()=>{await (await ${S.tour}).openWelcome()})()`),
    (d) => d.kind === 'welcome',
  );
  console.log('opened', JSON.stringify(welcome));
  await ev(
    `(async()=>{const t=(await import('/src/features/tour/store.ts')).useTour.getState();t.end('closed')})()`,
  ).catch(() => undefined);
  await suite('welcome');
} catch (e) {
  rows.push({ doc: '-', tool: 'setup', result: `FAIL (${e.message})` });
}
ws.close();
console.table(rows);
process.exit(rows.some((r) => r.result !== 'PASS') ? 1 : 0);
