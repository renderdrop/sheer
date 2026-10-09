// Pure helpers of the acceptance toolkit (ADR-131). No I/O, unit-tested in ../accept.test.ts.

/** Centre of a client-space rect {left, top, width, height}. */
export function rectCenter(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** True if the rect has a visible area and its centre lies in the viewport {w, h}. */
export function isClickable(r, vp) {
  if (!r || r.width <= 0 || r.height <= 0) return false;
  const c = rectCenter(r);
  return c.x >= 0 && c.y >= 0 && c.x < vp.w && c.y < vp.h;
}

/** Fractions (fx, fy in 0..1) or px offsets (x, y) inside a rect -> client coords. */
export function pointInRect(r, p) {
  const x = p.fx !== undefined ? r.left + r.width * p.fx : r.left + (p.x ?? 0);
  const y = p.fy !== undefined ? r.top + r.height * p.fy : r.top + (p.y ?? 0);
  return { x, y };
}

/** Intermediate points of a drag, endpoints included. */
export function dragPath(from, to, steps = 8) {
  const n = Math.max(1, Math.floor(steps));
  const out = [];
  for (let i = 0; i <= n; i++)
    out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  return out;
}

/** CDP modifier bitmask: alt 1, ctrl 2, meta 4, shift 8. */
export function modifiers(m = {}) {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

const NAMED = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
};

/** Key descriptor for Input.dispatchKeyEvent. Text is sent only without ctrl/alt/meta. */
export function keyEvent(key, m = {}) {
  const mod = modifiers(m);
  const named = NAMED[key];
  let code, vk, text;
  if (named) ({ code, vk, text } = named);
  else if (/^[a-z]$/i.test(key)) {
    code = `Key${key.toUpperCase()}`;
    vk = key.toUpperCase().charCodeAt(0);
    text = m.shift ? key.toUpperCase() : key.toLowerCase();
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`;
    vk = key.charCodeAt(0);
    text = key;
  } else if (/^F([1-9]|1[0-2])$/.test(key)) {
    code = key;
    vk = 111 + Number(key.slice(1));
  } else {
    code = key;
    vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    text = key.length === 1 ? key : undefined;
  }
  const typed = text !== undefined && !(mod & 7);
  return { key, code, windowsVirtualKeyCode: vk, modifiers: mod, text: typed ? text : undefined };
}

const OWNER_INSTALL = [/\\program files( \(x86\))?\\/i, /\\appdata\\local\\(programs\\)?sheer\\/i];

/** True if an exe path looks like the owner's installed Sheer (never to be launched or killed). */
export function isOwnerInstallPath(p) {
  return OWNER_INSTALL.some((re) => re.test(p.replace(/\//g, '\\')));
}

/** The only exe the launcher accepts: sheer-acceptance.exe under a target-acceptance folder. */
export function isAcceptanceExe(p) {
  const n = p.replace(/\//g, '\\').toLowerCase();
  return n.endsWith('\\sheer-acceptance.exe') && n.includes('\\target-acceptance\\') && !isOwnerInstallPath(n);
}

const MAIN_CLASS = /^(Tauri|TAURI|WRY|Chrome_WidgetWin)/;
const NOISE_CLASS = /^(IME|MSCTFIME UI|GDI\+ Hook Window Class|CiceroUIWndFrame|tooltips_class32)/;

function pick(w) {
  return { hwnd: w.hwnd, title: w.title, class: w.class, pid: w.pid };
}

/**
 * Decide one guard snapshot.
 * snap: { foreground: {hwnd,title,class,pid}|null, windows: [{hwnd,title,class,pid,visible}] } (windows of the acceptance pids)
 * ownPids: iterable of pids belonging to the acceptance process tree.
 * Returns null (fine) or { reason: 'foreign-foreground'|'unexpected-window', hwnd, title, class, pid }.
 */
export function guardDecision(snap, ownPids) {
  const own = new Set(ownPids);
  const fg = snap.foreground;
  for (const w of snap.windows ?? []) {
    if (!w.visible || NOISE_CLASS.test(w.class)) continue;
    if (w.class === '#32770' || !MAIN_CLASS.test(w.class)) return { reason: 'unexpected-window', ...pick(w) };
  }
  if (fg && fg.hwnd && !own.has(fg.pid) && !NOISE_CLASS.test(fg.class))
    return { reason: 'foreign-foreground', ...pick(fg) };
  return null;
}

/** The settings patch that sets the UI language and nothing else. */
export const languagePatch = (lang) => {
  if (lang !== 'en' && lang !== 'de') throw new Error(`unsupported UI language: ${lang}`);
  return { language: lang };
};
