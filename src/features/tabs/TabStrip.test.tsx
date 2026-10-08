// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDocuments } from '../../stores/documents.testutil';
import { useDocuments } from '../../stores/documents';
import { setup } from '../../test/render';
import { cycleTab } from './nav';
import { MAX_TAB_CHARS, MIN_TAB_CHARS, middleTruncate, TabStrip } from './TabStrip';

const closeSpy = vi.hoisted(() => vi.fn());
vi.mock('../viewer/useViewer', () => ({
  useViewer: {
    getState: () => ({
      close: () => {
        // What the viewer close does to the stores: the active document goes.
        closeSpy();
        const { activeId, remove } = useDocumentsRef.get();
        if (activeId !== null) remove(activeId);
      },
    }),
  },
}));

const useDocumentsRef = { get: () => useDocuments.getState() };

const doc = (id: number, name: string) => ({ id, pageCount: 1, displayName: name });

function open(...names: string[]): void {
  names.forEach((name, index) => useDocuments.getState().add(doc(index + 1, name)));
}

beforeEach(() => {
  resetDocuments();
  closeSpy.mockClear();
});

describe('middleTruncate', () => {
  it('never cuts below a readable minimum and keeps an ellipsis', () => {
    const cut = middleTruncate('Willkommen-Dokument.pdf', 2);
    expect(Array.from(cut)).toHaveLength(MIN_TAB_CHARS);
    expect(cut).toContain('…');
    expect(cut.endsWith('pdf')).toBe(true);
  });

  it('keeps short names and cuts long ones in the middle, keeping the end', () => {
    expect(middleTruncate('a.pdf')).toBe('a.pdf');
    const long = `${'x'.repeat(40)}-final.pdf`;
    const cut = middleTruncate(long);
    expect(Array.from(cut)).toHaveLength(MAX_TAB_CHARS);
    expect(cut).toContain('…');
    expect(cut.endsWith('final.pdf')).toBe(true);
  });
});

describe('the tab strip', () => {
  it('is not there without a document', () => {
    setup(<TabStrip />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('has one tab per document, the active one selected, and an accessible name', () => {
    open('A.pdf', 'B.pdf');
    setup(<TabStrip />);
    const list = screen.getByRole('tablist', { name: 'Open documents' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['A.pdf', 'B.pdf']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0]);
  });

  it('each tab is 36 high with a width that shares the strip across at most five, and the strip says how many', () => {
    open('a.pdf', 'b.pdf', 'c.pdf');
    setup(<TabStrip />);
    const wrap = screen.getByRole('tab', { name: 'a.pdf' }).parentElement?.parentElement;
    expect(wrap?.className).toContain('h-doc-tab');
    expect(wrap?.className).toContain('w-doc-tab-fit');
    expect(screen.getByRole('tablist').style.getPropertyValue('--tabs-n')).toBe('3');
  });

  it('five tabs share the strip, and six keep that width and scroll', () => {
    open('a', 'b', 'c', 'd', 'e');
    const { unmount } = setup(<TabStrip />);
    expect(screen.getByRole('tablist').style.getPropertyValue('--tabs-n')).toBe('5');
    expect(screen.queryByRole('button', { name: 'Scroll tabs left' })).toBeNull();
    unmount();
    resetDocuments();
    open('a', 'b', 'c', 'd', 'e', 'f');
    setup(<TabStrip />);
    expect(screen.getByRole('tablist').style.getPropertyValue('--tabs-n')).toBe('5');
  });

  it('from six tabs there are scroll arrows, out of the tab order, disabled at the ends', () => {
    open('a', 'b', 'c', 'd', 'e', 'f');
    setup(<TabStrip />);
    const left = screen.getByRole('button', { name: 'Scroll tabs left' }) as HTMLButtonElement;
    const right = screen.getByRole('button', { name: 'Scroll tabs right' }) as HTMLButtonElement;
    expect(left.tabIndex).toBe(-1);
    expect(right.tabIndex).toBe(-1);
    // jsdom has no layout: nothing overflows, so both ends are reached.
    expect(left.disabled).toBe(true);
    expect(right.disabled).toBe(true);
  });

  it('the active tab shows its close and the 2 px underline; the unsaved dot comes before the name', () => {
    open('A.pdf', 'B.pdf');
    setup(<TabStrip />);
    const active = screen.getByRole('tab', { name: /B\.pdf/ }).parentElement?.parentElement as HTMLElement;
    expect(active.querySelector('[class*="bg-accent"]')).not.toBeNull();
    expect(active.className).toContain('bg-panel');
    expect(screen.getByRole('tab', { name: /A\.pdf/ }).parentElement?.parentElement?.className).toContain('bg-subtle');
  });

  it('a click selects, and the close button is out of the tab order and closes that tab only', () => {
    open('A.pdf', 'B.pdf');
    setup(<TabStrip />);
    fireEvent.click(screen.getByRole('tab', { name: /A\.pdf/ }));
    expect(useDocuments.getState().activeId).toBe(1);
    const close = screen.getByLabelText('Close B.pdf');
    expect(close.tabIndex).toBe(-1);
    fireEvent.click(close);
    expect(useDocuments.getState().order).toEqual([1]);
    expect(useDocuments.getState().activeId).toBe(1);
  });

  it('closing the active tab selects its right neighbour, else its left', () => {
    open('A.pdf', 'B.pdf', 'C.pdf');
    setup(<TabStrip />);
    act(() => useDocuments.getState().setActive(2));
    fireEvent.click(screen.getByLabelText('Close B.pdf'));
    expect(useDocuments.getState().activeId).toBe(3);
    fireEvent.click(screen.getByLabelText('Close C.pdf'));
    expect(useDocuments.getState().activeId).toBe(1);
  });

  it('a middle click closes', () => {
    open('A.pdf', 'B.pdf');
    setup(<TabStrip />);
    fireEvent(
      screen.getByRole('tab', { name: /A\.pdf/ }).parentElement as HTMLElement,
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    expect(useDocuments.getState().order).toEqual([2]);
  });

  it('Left, Right, Home and End move focus and wrap, Enter activates, Delete closes the focused tab', async () => {
    open('A.pdf', 'B.pdf', 'C.pdf');
    const { user } = setup(<TabStrip />);
    screen.getByRole('tab', { name: /C.pdf/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /A.pdf/ }));
    expect(useDocuments.getState().activeId).toBe(3);
    await user.keyboard('{Enter}');
    expect(useDocuments.getState().activeId).toBe(1);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /C.pdf/ }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /A.pdf/ }));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /C.pdf/ }));
    await user.keyboard('{Delete}');
    expect(useDocuments.getState().order).toEqual([1, 2]);
  });

  it('closing the only document from its tab leaves no document open (Home)', async () => {
    open('Only.pdf');
    const { user } = setup(<TabStrip />);
    await user.click(screen.getByLabelText('Close Only.pdf'));
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(useDocuments.getState().order).toEqual([]);
  });

  it('Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs', async () => {
    open('A.pdf', 'B.pdf', 'C.pdf');
    const { user } = setup(<TabStrip />);
    await user.keyboard('{Control>}{Tab}{/Control}');
    expect(useDocuments.getState().activeId).toBe(1);
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}');
    expect(useDocuments.getState().activeId).toBe(3);
  });
});

describe('cycleTab', () => {
  it('wraps both ways and does nothing with fewer than two documents', () => {
    cycleTab(1);
    open('A.pdf');
    cycleTab(1);
    expect(useDocuments.getState().activeId).toBe(1);
    open('A.pdf', 'B.pdf');
    cycleTab(1);
    expect(useDocuments.getState().activeId).toBe(1);
    cycleTab(-1);
    expect(useDocuments.getState().activeId).toBe(2);
  });
});
