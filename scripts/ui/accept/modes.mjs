// F22: the mode tabs are gone; the mode follows the active tool. A script enters a mode by clicking one tool of its group, then
// releases the tool (Esc) so the idle tool of that mode is active, as the former tab click left it.
const ENTRY = { read: 'hand', comment: 'highlight', fill: 'text', pages: 'organize', edit: 'editText' };

export async function enterMode(input, id, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const tool = ENTRY[id];
  if (!tool) throw new Error(`unknown mode ${id}`);
  await input.click({ selector: `[data-mode-group="${id}"] [data-toolbar-item="${tool}"]` });
  await sleep(250);
  if (id !== 'pages') await input.press('Escape').catch(() => {});
}
