// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { clearTextCache, loadLayer } from './cache';
import { copySelection, useTextKeys } from './useTextSelection';

const textApi = vi.hoisted(() => ({ getTextLayer: vi.fn() }));
vi.mock('../../api/text', () => textApi);

const TEXT = 'Alpha beta\r\ngamma';

function boxes(): Float32Array {
  const out: number[] = [];
  let row = 0;
  let x = 0;
  for (const char of TEXT) {
    if (char === '\r' || char === '\n') {
      out.push(x, row * 14, 0, 0);
      if (char === '\n') {
        row += 1;
        x = 0;
      }
    } else {
      out.push(x, row * 14, 6, 12);
      x += 6;
    }
  }
  return Float32Array.from(out);
}

function Region({ page = 0 }: { page?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useTextKeys(ref, 1);
  return (
    <div ref={ref} tabIndex={0} data-testid="region">
      <div data-text-layer="" data-text-page={page} data-text-length={TEXT.length}>
        <span data-run-start="0" data-run-end="10">
          Alpha beta
        </span>
        <span data-run-start="12" data-run-end="17">
          gamma
        </span>
      </div>
    </div>
  );
}

beforeEach(async () => {
  clearTextCache();
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' });
  useView.getState().open(1, 3);
  textApi.getTextLayer.mockReset().mockResolvedValue({ text: TEXT, boxes: boxes(), truncated: false });
  await loadLayer(1, 0);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  resetDocuments();
  useView.setState({ byDoc: {} });
  useUi.setState({ activeTool: 'select', toolLocked: false });
});

function selectAcross(root: HTMLElement) {
  const spans = root.querySelectorAll('span');
  window.getSelection()?.setBaseAndExtent(spans[0]?.firstChild as Node, 6, spans[1]?.firstChild as Node, 3);
}

describe('copy', () => {
  it('writes the page text between the boundaries, with its line break, as plain text only', () => {
    const { getByTestId } = render(<Region />);
    selectAcross(getByTestId('region'));
    const data: Record<string, string> = {};
    const event = {
      clipboardData: { setData: (type: string, value: string) => (data[type] = value) },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    expect(copySelection(event)).toBe(true);
    expect(data).toEqual({ 'text/plain': 'beta\ngam' });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('leaves a selection outside the text layers, and an empty one, to the browser', () => {
    const { container } = render(
      <>
        <Region />
        <p>plain</p>
      </>,
    );
    const event = { clipboardData: { setData: vi.fn() }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    expect(copySelection(event)).toBe(false);
    window.getSelection()?.selectAllChildren(container.querySelector('p') as HTMLElement);
    expect(copySelection(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('the canvas keys for the text', () => {
  it('primary+A selects the text of the current page only', () => {
    const { getByTestId } = render(<Region />);
    const region = getByTestId('region');
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    region.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toContain('Alpha beta');
    expect(window.getSelection()?.getRangeAt(0).commonAncestorContainer).toBe(
      region.querySelector('[data-text-layer]'),
    );
  });

  it('primary+A on a page whose text is not mounted leaves the key alone', () => {
    useView.getState().setPage(1, 2);
    const { getByTestId } = render(<Region />);
    const event = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true });
    getByTestId('region').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Esc clears a selection in the text, but not under another tool or when something else took the key', () => {
    const { getByTestId } = render(<Region />);
    const region = getByTestId('region');
    selectAcross(region);
    useUi.setState({ activeTool: 'draw' });
    region.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(window.getSelection()?.isCollapsed).toBe(false);
    useUi.setState({ activeTool: 'select' });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    region.dispatchEvent(event);
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    // Nothing selected: Esc is not taken.
    const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    region.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });
});
