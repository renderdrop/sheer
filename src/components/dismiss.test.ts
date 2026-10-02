// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DISMISS_PRIORITY, registerDismissLayer } from './dismiss';

const unregister: (() => void)[] = [];

/** Opens a layer for the length of the test: `dismiss` is what Esc calls on it, `close` takes the layer away. */
function layer(priority: number) {
  const dismiss = vi.fn();
  const close = registerDismissLayer(priority, dismiss);
  unregister.push(close);
  return { dismiss, close };
}

const escape = (target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

afterEach(() => {
  for (const close of unregister.splice(0)) close();
});

describe('the order of the layers that take Esc', () => {
  it('follows the stacking order of DESIGN 1.7 from the top: tooltip, then dialog, then popover', () => {
    expect(DISMISS_PRIORITY.tooltip).toBeLessThan(DISMISS_PRIORITY.modal);
    expect(DISMISS_PRIORITY.modal).toBeLessThan(DISMISS_PRIORITY.popover);
  });

  it('gives Esc to the topmost layer only, one layer per press: tooltip, dialog, popover', () => {
    // Opened bottom-up and top-down in turn does not matter: the rank decides.
    const popover = layer(DISMISS_PRIORITY.popover);
    const tooltip = layer(DISMISS_PRIORITY.tooltip);
    const modal = layer(DISMISS_PRIORITY.modal);

    escape();
    expect(tooltip.dismiss).toHaveBeenCalledTimes(1);
    expect(modal.dismiss).not.toHaveBeenCalled();
    tooltip.close();
    escape();
    expect(modal.dismiss).toHaveBeenCalledTimes(1);
    expect(popover.dismiss).not.toHaveBeenCalled();
    modal.close();
    escape();
    expect(popover.dismiss).toHaveBeenCalledTimes(1);
  });

  for (const [name, order] of [
    ['the dialog opened first', ['modal', 'popover']],
    ['the popover opened first', ['popover', 'modal']],
  ] as const) {
    it(`closes a dialog before a popover that is open beneath it, when ${name}`, () => {
      const layers = new Map(order.map((kind) => [kind, layer(DISMISS_PRIORITY[kind])]));
      escape();
      expect(layers.get('modal')?.dismiss).toHaveBeenCalledTimes(1);
      expect(layers.get('popover')?.dismiss).not.toHaveBeenCalled();
    });
  }

  it('lets the layer that opened last go first among layers of the same rank', () => {
    const first = layer(DISMISS_PRIORITY.popover);
    const second = layer(DISMISS_PRIORITY.popover);
    escape();
    expect(second.dismiss).toHaveBeenCalledTimes(1);
    expect(first.dismiss).not.toHaveBeenCalled();
  });

  it('claims the key it handles, and leaves other keys and a field that keeps Esc for itself', () => {
    const modal = layer(DISMISS_PRIORITY.modal);
    const other = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.body.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);

    const field = document.body.appendChild(document.createElement('input'));
    field.setAttribute('data-keep-escape', '');
    escape(field);
    expect(modal.dismiss).not.toHaveBeenCalled();

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(modal.dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not touch Esc when no layer is open', () => {
    const modal = layer(DISMISS_PRIORITY.modal);
    modal.close();
    expect(escape()).toBe(true);
    expect(modal.dismiss).not.toHaveBeenCalled();
  });
});
