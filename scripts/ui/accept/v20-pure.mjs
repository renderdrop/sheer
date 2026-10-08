// Pure helpers of the v2.0 acceptance scripts (v20-perf.mjs, v20-a11y.mjs). No I/O, no CDP: unit-tested in scripts/ui/v20.test.ts.
// Budgets: ADR-140 section 3 (performance) and section 4 (accessibility).

// ---- performance ------------------------------------------------------------------------------------------------------------

/** The budgets of ADR-140 section 3. */
export const BUDGET = {
  openMs: 1000,
  frameP95Ms: 20,
  frameAvgFps: 58,
  ocrSecPerPage: 2,
  keystrokeP95Ms: 150,
  applyMs: 500,
};

/** p-quantile of a list (same rule as `cdp.mjs fps`: index floor(p * n), clamped). NaN for an empty list. */
export function quantile(values, p) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Frame statistics of rAF deltas in ms. */
export function frameStats(deltas) {
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    frames: deltas.length,
    p50: quantile(deltas, 0.5),
    p95: quantile(deltas, 0.95),
    max: deltas.length ? Math.max(...deltas) : NaN,
    avgFps: sum > 0 ? (deltas.length * 1000) / sum : 0,
  };
}

/** Verdict of one frame measurement against the budget. Too few frames (< 10) is a miss: nothing was measured. */
export function judgeFrames(stats, budget = BUDGET) {
  if (stats.frames < 10) return { ok: false, why: `only ${stats.frames} frames measured` };
  const why = [];
  if (!(stats.p95 <= budget.frameP95Ms)) why.push(`p95 ${stats.p95.toFixed(1)} ms > ${budget.frameP95Ms} ms`);
  if (!(stats.avgFps >= budget.frameAvgFps)) why.push(`avg ${stats.avgFps.toFixed(1)} fps < ${budget.frameAvgFps} fps`);
  return { ok: why.length === 0, why: why.join('; ') };
}

/** Pulls the compressed image streams (dictionary text + raw bytes) out of an image-only PDF made by `make_scan_fixtures`. */
export function extractImageStreams(buf) {
  const text = buf.toString('latin1');
  const out = [];
  const re = /\d+ 0 obj\s*<<((?:(?!endobj)[^])*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const dict = m[1];
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const len = /\/Length\s+(\d+)/.exec(dict);
    if (!len) continue;
    const start = m.index + m[0].length;
    out.push({ dict: dict.replace(/\/Length\s+\d+/, '').trim(), data: buf.subarray(start, start + Number(len[1])) });
    re.lastIndex = start + Number(len[1]);
  }
  return out;
}

/** An image-only PDF of `pages` pages (A4), the images cycling through `images` (from extractImageStreams). Classic xref table. */
export function buildImageOnlyPdf(images, pages) {
  if (images.length === 0) throw new Error('no images to build from');
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    size += buf.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  // objects: 1 catalog, 2 pages, then per used image: image; per page: content + page
  const kidsStart = 3 + images.length;
  const kids = Array.from({ length: pages }, (_, i) => `${kidsStart + i * 2 + 1} 0 R`);
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(2, `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`);
  images.forEach((img, i) => {
    offsets[3 + i] = size;
    push(`${3 + i} 0 obj\n<<${img.dict}/Length ${img.data.length}>>\nstream\n`);
    push(img.data);
    push('\nendstream\nendobj\n');
  });
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  for (let i = 0; i < pages; i++) {
    const c = kidsStart + i * 2;
    obj(c, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    obj(
      c + 1,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im0 ${3 + (i % images.length)} 0 R>>>>/Contents ${c} 0 R>>`,
    );
  }
  const count = kidsStart + pages * 2;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table + `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** Fixed-width table of { name, value, budget, ok } rows for the console. */
export function formatPerfTable(rows) {
  const cols = ['measurement', 'result', 'budget', 'verdict'];
  const data = rows.map((r) => [r.name, r.value, r.budget, r.ok ? 'PASS' : 'FAIL' + (r.why ? ` (${r.why})` : '')]);
  const w = cols.map((c, i) => Math.max(c.length, ...data.map((d) => String(d[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...data.map(line)].join('\n');
}

// ---- accessibility ----------------------------------------------------------------------------------------------------------

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'slider',
  'spinbutton',
  'option',
  'treeitem',
  'listbox',
  'tree',
  'menu',
  'menubar',
  'tablist',
  'toolbar',
  'radiogroup',
]);
// Containers that are named by label but need no name when they are mere composites without label (kept strict for dialogs only).
const NAME_OPTIONAL = new Set([
  'RootWebArea',
  'WebArea',
  'menu',
  'menubar',
  'tablist',
  'toolbar',
  'radiogroup',
  'listbox',
  'tree',
]);
const NO_ROLE = new Set(['', 'generic', 'none', 'presentation', 'GenericContainer', 'Section']);
const CHECKABLE = new Set(['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio']);

export const axRole = (n) => String(n.role?.value ?? '');
export const axName = (n) => String(n.name?.value ?? '').trim();
export const axProp = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;
const describe = (n) => ({ role: axRole(n), name: axName(n), nodeId: n.nodeId, backendDOMNodeId: n.backendDOMNodeId });

/**
 * Checks the nodes of `Accessibility.getFullAXTree` (ADR-140 section 4). Ignored nodes are not exposed and are skipped.
 * Rules: focusable-role (a focusable node has a real role), name (focusable or interactive nodes have a non-empty name),
 * checked (checkable roles expose checked), expanded (a popup trigger exposes expanded), selected (tabs expose selected),
 * dialog-name, dialog-modal (skipped with `skipModal` when the DOM says aria-modal).
 * @returns {{rule:string, role:string, name:string, nodeId?:string, backendDOMNodeId?:number}[]}
 */
export function auditAxNodes(nodes, { skipModal = false } = {}) {
  const out = [];
  const add = (rule, n) => out.push({ rule, ...describe(n) });
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = axRole(n);
    if (role === 'RootWebArea' || role === 'WebArea') continue;
    const focusable = axProp(n, 'focusable') === true;
    const disabled = axProp(n, 'disabled') === true;
    if (focusable && NO_ROLE.has(role)) add('focusable-role', n);
    const interactive = INTERACTIVE.has(role) && !NAME_OPTIONAL.has(role);
    if ((focusable || interactive) && !NAME_OPTIONAL.has(role) && axName(n) === '') add('name', n);
    if (CHECKABLE.has(role) && axProp(n, 'checked') === undefined) add('checked', n);
    const popup = axProp(n, 'hasPopup');
    if (popup !== undefined && popup !== false && popup !== 'false' && !disabled && axProp(n, 'expanded') === undefined)
      add('expanded', n);
    if (role === 'tab' && axProp(n, 'selected') === undefined) add('selected', n);
    if (role === 'dialog' || role === 'alertdialog') {
      if (axName(n) === '') add('dialog-name', n);
      if (!skipModal && axProp(n, 'modal') !== true) add('dialog-modal', n);
    }
  }
  return out;
}

/** True when a computed style shows a keyboard focus indicator (a visible outline or a box shadow). */
export function hasFocusIndicator(s) {
  const outline = s.outlineStyle !== 'none' && s.outlineStyle !== 'hidden' && parseFloat(s.outlineWidth) > 0;
  const shadow = typeof s.boxShadow === 'string' && s.boxShadow !== '' && s.boxShadow !== 'none';
  return outline || shadow;
}

/**
 * Tab-stop verdict. `controls`: [{ name, seen, tabindex, composite }] (seen = reached by Tab; composite = the id of the roving
 * container it belongs to, or null). A control that Tab never reached is fine when it sits in a composite one of whose members
 * was reached (arrow keys move inside it); otherwise it is unreachable.
 */
export function unreachable(controls) {
  const reachedComposites = new Set(controls.filter((c) => c.seen && c.composite !== null).map((c) => c.composite));
  return controls
    .filter((c) => !c.seen && !(c.composite !== null && reachedComposites.has(c.composite)))
    .map((c) => c.name);
}

/** axe-core result -> compact violations (`violations` only; `incomplete` is counted, never failed). */
export function summariseAxe(result) {
  // The positioner of an open popup (menu, popover) is a transient layer, not page content: axe's page-level `region` rule does not apply to it.
  const targetOf = (n) => (Array.isArray(n.target) ? n.target.join(' ') : String(n.target));
  const isPopupLayer = (n) => targetOf(n) === '.z-popover' || targetOf(n).startsWith('div[data-side=');
  const real = (result.violations ?? [])
    .map((v) => (v.id === 'region' ? { ...v, nodes: v.nodes.filter((n) => !isPopupLayer(n)) } : v))
    .filter((v) => v.nodes.length > 0);
  return {
    violations: real.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => (Array.isArray(n.target) ? n.target.join(' ') : String(n.target))),
    })),
    incomplete: (result.incomplete ?? []).length,
  };
}

/** Menu items the sweep must not activate: they leave the document, write files, print, restart or open native dialogs. */
export const SKIP_ITEM =
  /schlie(ß|ss)en|close|beenden|quit|exit|drucken|print|speichern|save|öffnen|open|zurücksetzen|reset|löschen|delete|entfernen|remove|aktualisier|update|neu laden|reload|vollbild|full ?screen|exportieren|export|zuletzt|recent/i;

/** Rolls per-screen results up: { screens, violations, byRule } for the console and JSON. */
export function rollUp(screens) {
  const byRule = {};
  let violations = 0;
  for (const s of screens) {
    for (const v of s.violations) {
      violations++;
      byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    }
  }
  return { screens: screens.length, violations, byRule };
}
