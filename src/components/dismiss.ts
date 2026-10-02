/**
 * Escape handling for transient layers (DESIGN 2.3: tooltip, then dialog, then popover, then gesture, tool, selection).
 * Every open layer registers here; one capture listener on the document lets only the topmost layer see the key,
 * so Esc closes a shown tooltip first and never also closes the popover or dialog below it.
 *
 * An element inside a layer can keep Esc for itself by carrying `data-keep-escape` while it has something to cancel (a
 * numeric field with an unsaved edit): the first Esc reverts the edit, the next one closes the layer.
 */

/**
 * The layers that take Esc, topmost first: the lowest number is seen first. This is DESIGN 1.7's stacking order from the
 * top (tooltip 400, modal 300, popover 100; the toast and the drag layer take no Esc), so the key always closes what is on
 * top of everything else: a dialog above a popover takes Esc before it, and a tooltip inside either one before both. The
 * order is written down only here; a new layer takes its number here.
 */
export const DISMISS_PRIORITY = { tooltip: 0, modal: 1, popover: 2 } as const;

interface Layer {
  priority: number;
  order: number;
  dismiss: () => void;
}

const layers = new Set<Layer>();
let counter = 0;

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing) return;
  if (event.target instanceof Element && event.target.closest('[data-keep-escape]') !== null) return;
  let top: Layer | undefined;
  for (const layer of layers) {
    if (
      top === undefined ||
      layer.priority < top.priority ||
      (layer.priority === top.priority && layer.order > top.order)
    ) {
      top = layer;
    }
  }
  if (top === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  top.dismiss();
}

/** Registers an open layer. Returns the function that unregisters it. */
export function registerDismissLayer(priority: number, dismiss: () => void): () => void {
  counter += 1;
  const layer: Layer = { priority, order: counter, dismiss };
  layers.add(layer);
  if (layers.size === 1) document.addEventListener('keydown', onKeyDown, true);
  return () => {
    layers.delete(layer);
    if (layers.size === 0) document.removeEventListener('keydown', onKeyDown, true);
  };
}
