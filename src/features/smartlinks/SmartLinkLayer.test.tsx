// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SmartLink } from '../../api/smartLinks';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { clearSmartLinkCache } from './cache';
import { clearRealLinkCache } from './realLinks';
import { SmartLinkLayer } from './SmartLinkLayer';
import { useSmartLinks } from './store';

const mocks = vi.hoisted(() => ({
  getSmartLinks: vi.fn(),
  getPageLinks: vi.fn(),
  openLink: vi.fn(),
  jumpTo: vi.fn(),
  tip: vi.fn(),
}));
vi.mock('../../api/smartLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/smartLinks')>()),
  getSmartLinks: mocks.getSmartLinks,
}));
vi.mock('../../api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/links')>()),
  getPageLinks: mocks.getPageLinks,
  openLink: mocks.openLink,
}));
vi.mock('../history', () => ({ jumpTo: mocks.jumpTo }));
vi.mock('../history/actions', () => ({ historyBinding: () => ({ key: 'ArrowLeft', mods: ['alt'] }) }));
vi.mock('../tips/runtime', () => ({ maybeShowSmartLinksTip: mocks.tip }));

const footnote: SmartLink = {
  kind: 'footnote',
  rects: [{ x: 100, y: 100, w: 10, h: 10 }],
  marker: '3',
  target: { pageId: 1, rect: { x: 72, y: 700, w: 300, h: 12 } },
  preview: 'The note text.',
};
const contents: SmartLink = {
  kind: 'contents',
  rects: [
    { x: 500, y: 300, w: 12, h: 10 },
    { x: 72, y: 300, w: 440, h: 10 },
  ],
  marker: 'Methods',
  target: { pageId: 4 },
  preview: '',
};
const ready = (links: SmartLink[]) => Promise.resolve({ rev: 1, ready: true, links });

/** Layout stand-in: a run sits where its style and its link's style say, at the page's origin. */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute('data-smartlink-run')) return new DOMRect(0, 0, 0, 0);
    const outer = this.parentElement as HTMLElement;
    const x = parseFloat(outer.style.left) + parseFloat(this.style.left);
    const y = parseFloat(outer.style.top) + parseFloat(this.style.top);
    return new DOMRect(x, y, parseFloat(this.style.width), parseFloat(this.style.height));
  });
}

function Page({ index = 0 }: { index?: number }) {
  return (
    <div data-page={index + 1}>
      <SmartLinkLayer
        docId={1}
        pageIndex={index}
        boxWidth={600}
        boxHeight={800}
        widthPt={600}
        heightPt={800}
        rotation={0}
        ready
        slotRev={0}
      />
    </div>
  );
}

const pageEl = () => document.querySelector('[data-page]') as HTMLElement;
const press = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
  fireEvent(
    pageEl(),
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }),
  );
const link = (name: RegExp | string) => screen.findByRole('link', { name });

beforeEach(() => {
  clearSmartLinkCache();
  clearRealLinkCache();
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 5, displayName: 'a.pdf' });
  useSmartLinks.setState({ enabled: true, overrides: {}, visited: {} });
  useUi.setState({ activeTool: 'select', redactMode: false });
  mocks.getSmartLinks.mockReset().mockImplementation(() => ready([footnote, contents]));
  mocks.getPageLinks.mockReset().mockResolvedValue([]);
  mocks.openLink.mockReset().mockResolvedValue(undefined);
  mocks.jumpTo.mockReset();
  mocks.tip.mockReset();
  stubLayout();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDocuments();
});

describe('the smart link layer', () => {
  it('is one list per page with a named link for each detected link and the preview text as its description', async () => {
    render(<Page />);
    const list = await screen.findByRole('list', { name: 'Links on page 1' });
    const note = within(list).getByRole('link', { name: 'Footnote 3, detected, page 2' });
    expect(within(list).getByRole('link', { name: 'Methods, detected, page 5' })).not.toBeNull();
    const described = document.getElementById(note.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Detected · Footnote · p. 2 · The note text.');
  });

  it('names the printed page first and the file page in parentheses when they differ', async () => {
    mocks.getSmartLinks.mockImplementation(() =>
      ready([{ ...contents, target: { pageId: 4, label: '1' }, preview: 'Methods' }]),
    );
    render(<Page />);
    const line = await link('Methods, detected, page 1');
    const described = document.getElementById(line.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Detected · Contents · p. 1 (page 5 of the file) · Methods');
  });

  it('draws the cue under the page number only for a contents line', async () => {
    render(<Page />);
    const line = await link(/^Methods/);
    const cues = line.querySelectorAll<HTMLElement>('[data-smartlink-cue]');
    expect(cues).toHaveLength(1);
    expect(parseFloat(cues[0]!.style.left)).toBe(500 - 72);
    expect(line.querySelectorAll('[data-smartlink-run]')).toHaveLength(1);
  });

  it('has one Tab stop and moves with the arrows; Enter follows and marks the link visited', async () => {
    render(<Page />);
    const first = await link(/^Footnote/);
    const second = await link(/^Methods/);
    expect([first, second].map((el) => el.tabIndex)).toEqual([0, -1]);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(mocks.jumpTo).toHaveBeenCalledWith(1, footnote.target, { pageId: 0, rect: footnote.rects[0] });
    await waitFor(() => expect(first.hasAttribute('data-visited')).toBe(true));
    expect(second.hasAttribute('data-visited')).toBe(false);
  });

  it('past the last link focus goes to the next page', async () => {
    render(
      <>
        <Page index={0} />
        <Page index={1} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole('list')).toHaveLength(2));
    const lists = screen.getAllByRole('list');
    const last = within(lists[0]!).getByRole('link', { name: /^Methods/ });
    last.focus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(lists[1]!).getAllByRole('link')[0]);
  });

  it('a click follows, a press that moves 4 px or more does not, and the padded 24 px box is hit', async () => {
    render(<Page />);
    await link(/^Footnote/);
    // The run is 10 x 10 at (100, 100): grown to 24 x 24 it spans 93 to 117.
    press('pointerdown', 95, 95);
    press('pointerup', 95, 95);
    expect(mocks.jumpTo).toHaveBeenCalledTimes(1);
    press('pointerdown', 105, 105);
    press('pointermove', 112, 105);
    press('pointerup', 112, 105);
    expect(mocks.jumpTo).toHaveBeenCalledTimes(1);
    press('pointerdown', 60, 60);
    press('pointerup', 60, 60);
    expect(mocks.jumpTo).toHaveBeenCalledTimes(1);
  });

  it('shows the preview with "Detected" after the hover delay, and the tip is asked for', async () => {
    render(<Page />);
    await link(/^Footnote/);
    fireEvent(pageEl(), new MouseEvent('pointermove', { bubbles: true, clientX: 105, clientY: 105 }));
    expect(pageEl().hasAttribute('data-link-hover')).toBe(true);
    expect(mocks.tip).toHaveBeenCalled();
    const tooltip = await waitFor(
      () => {
        const found = document.querySelector('[role="tooltip"]');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      },
      { timeout: 1500 },
    );
    expect(tooltip.textContent).toContain('Detected · Footnote · p. 2');
    expect(tooltip.textContent).toContain('The note text.');
    expect(tooltip.textContent).toContain('Click to jump');
    fireEvent(pageEl(), new MouseEvent('pointerleave'));
    await waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
  });

  it.each(['highlight', 'note', 'editText', 'draw'] as const)(
    'is hidden and asks for nothing under the %s tool',
    async (tool) => {
      useUi.setState({ activeTool: tool });
      render(<Page />);
      await act(() => new Promise((done) => setTimeout(done, 30)));
      expect(screen.queryByRole('list')).toBeNull();
      expect(mocks.getSmartLinks).not.toHaveBeenCalled();
    },
  );

  it('is hidden while another tool is active (L9)', async () => {
    useUi.setState({ activeTool: 'editText' });
    render(<Page />);
    await act(() => new Promise((done) => setTimeout(done, 30)));
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('is hidden during a redaction band, and live again for the Hand tool', async () => {
    useUi.setState({ redactMode: true });
    render(<Page />);
    await act(() => new Promise((done) => setTimeout(done, 30)));
    expect(screen.queryByRole('list')).toBeNull();
    act(() => useUi.setState({ redactMode: false, activeTool: 'hand' }));
    expect(await screen.findByRole('list')).not.toBeNull();
  });

  it('turning smart links off for the tab removes them at once and stops fetching; turning on brings them back', async () => {
    render(<Page />);
    await link(/^Footnote/);
    act(() => useSmartLinks.getState().setForDoc(1, false));
    expect(screen.queryByRole('link')).toBeNull();
    const calls = mocks.getSmartLinks.mock.calls.length;
    await act(() => new Promise((done) => setTimeout(done, 30)));
    expect(mocks.getSmartLinks.mock.calls.length).toBe(calls);
    act(() => useSmartLinks.getState().setForDoc(1, true));
    expect(await link(/^Footnote/)).not.toBeNull();
  });

  it('never draws links of an older revision: a change to the document hides them until the new ones arrive', async () => {
    render(<Page />);
    await link(/^Footnote/);
    let answer: (() => void) | undefined;
    mocks.getSmartLinks.mockImplementation(
      () => new Promise((done) => (answer = () => done({ rev: 2, ready: true, links: [contents] }))),
    );
    act(() =>
      useAnnotations.setState((state) => ({
        byDoc: { ...state.byDoc, 1: { ...(state.byDoc[1] ?? { byId: {}, loaded: {}, removed: {} }), rev: 9 } as never },
      })),
    );
    expect(screen.queryByRole('link', { name: /^Footnote/ })).toBeNull();
    await waitFor(() => expect(answer).toBeDefined());
    await act(async () => answer?.());
    expect(await link(/^Methods/)).not.toBeNull();
    expect(screen.queryByRole('link', { name: /^Footnote/ })).toBeNull();
    useAnnotations.setState({ byDoc: {} });
  });

  it('Esc inside the list returns focus to the canvas', async () => {
    render(
      <div data-action-scope="canvas">
        <div role="region" tabIndex={-1} data-testid="canvas">
          <Page />
        </div>
      </div>,
    );
    const first = await link(/^Footnote/);
    first.focus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByTestId('canvas'));
  });
});

describe('real links (L3)', () => {
  const real = [
    { index: 0, rect: { x: 100, y: 500, w: 80, h: 12 }, target: { type: 'url', url: 'https://example.org/a' } },
    { index: 1, rect: { x: 100, y: 540, w: 80, h: 12 }, target: { type: 'page', pageId: 3, y: 10 } },
  ];

  it('are named by target, get no cue and no Detected, and show even when smart links are off', async () => {
    mocks.getPageLinks.mockResolvedValue(real);
    useSmartLinks.setState({ enabled: false });
    render(<Page />);
    const url = await link('Link to example.org');
    const page = await link('Link to page 4');
    for (const el of [url, page]) {
      expect(el.hasAttribute('data-reallink')).toBe(true);
      expect(el.querySelector('[data-smartlink-cue]')).toBeNull();
    }
    expect(mocks.getSmartLinks).not.toHaveBeenCalled();
  });

  it('a click on a web link goes through open_link, one to a page through jumpTo', async () => {
    mocks.getPageLinks.mockResolvedValue(real);
    render(<Page />);
    await link('Link to example.org');
    press('pointerdown', 130, 506);
    press('pointerup', 130, 506);
    expect(mocks.openLink).toHaveBeenCalledWith(1, 0, 0);
    press('pointerdown', 130, 546);
    press('pointerup', 130, 546);
    expect(mocks.jumpTo).toHaveBeenCalledWith(1, { pageId: 3 }, { pageId: 0, rect: real[1]!.rect });
  });
});

describe('a range run (L14)', () => {
  const range: SmartLink = {
    kind: 'literature',
    rects: [{ x: 200, y: 400, w: 30, h: 10 }],
    marker: '3–5',
    target: { pageId: 4 },
    preview: '',
    choices: [
      { number: 3, preview: 'Autor A. Titel drei.', target: { pageId: 4, rect: { x: 72, y: 100, w: 300, h: 12 } } },
      { number: 4, preview: 'Autor B. Titel vier.', target: { pageId: 4, rect: { x: 72, y: 120, w: 300, h: 12 } } },
      { number: 5, preview: 'Autor C. Titel fünf.', target: { pageId: 5, rect: { x: 72, y: 90, w: 300, h: 12 } } },
    ],
  };
  const name = 'Sources 3–5, detected, 3 entries';

  beforeEach(() => {
    mocks.getSmartLinks.mockImplementation(() => ready([range]));
  });

  it('is a button that opens a listbox and says how many entries it has', async () => {
    render(<Page />);
    const run = await screen.findByRole('button', { name });
    expect(run.getAttribute('aria-haspopup')).toBe('listbox');
    expect(run.getAttribute('aria-expanded')).toBe('false');
    const described = document.getElementById(run.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Detected · Source · 3 entries');
  });

  it('opens on Enter with the first row current; arrows and Enter jump with the run as the origin', async () => {
    render(<Page />);
    const run = await screen.findByRole('button', { name });
    run.focus();
    fireEvent.keyDown(run, { key: 'Enter' });
    const list = await screen.findByRole('listbox', { name: 'Sources 3–5' });
    expect(run.getAttribute('aria-expanded')).toBe('true');
    expect(run.getAttribute('data-state')).toBe('active');
    expect(document.activeElement).toBe(list);
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
      'Source 3, page 5',
      'Source 4, page 5',
      'Source 5, page 6',
    ]);
    expect(list.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(mocks.jumpTo).toHaveBeenCalledWith(1, range.choices![2]!.target, { pageId: 0, rect: range.rects[0] });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('Esc closes it and returns focus to the run; a typed digit jumps to that number', async () => {
    render(<Page />);
    const run = await screen.findByRole('button', { name });
    fireEvent.keyDown(run, { key: ' ' });
    const list = await screen.findByRole('listbox');
    fireEvent.keyDown(list, { key: '5' });
    expect(list.getAttribute('aria-activedescendant')).toBe(within(list).getAllByRole('option')[2]!.id);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(document.activeElement).toBe(run);
    expect(mocks.jumpTo).not.toHaveBeenCalled();
  });

  it('a click on the run opens it and a click on a row follows that entry', async () => {
    render(<Page />);
    await screen.findByRole('button', { name });
    press('pointerdown', 210, 405);
    press('pointerup', 210, 405);
    const list = await screen.findByRole('listbox');
    expect(mocks.jumpTo).not.toHaveBeenCalled();
    fireEvent.click(within(list).getAllByRole('option')[1]!);
    expect(mocks.jumpTo).toHaveBeenCalledWith(1, range.choices![1]!.target, { pageId: 0, rect: range.rects[0] });
    expect(useSmartLinks.getState().visited[1]).toHaveLength(1);
  });
});
