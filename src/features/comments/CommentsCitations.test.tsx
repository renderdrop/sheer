// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { TAG_PALETTE } from '../../api/cite';
import { emptyBibRecord, type CitationInfo } from '../../api/citations';
import { DEFAULT_SETTINGS } from '../../api/app';
import { useAnnotations } from '../../stores/annotations';
import { useSettings } from '../../stores/settings';
import { setup } from '../../test/render';
import { useCitationStore } from '../citations/store';
import { cancelJumpWait } from '../viewer/scrollBridge';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { Comments } from './Comments';
import { useComments } from './store';
import { clearQuotes } from './useQuote';

const listDocumentAnnotations = vi.hoisted(() => vi.fn());
const listAnnotations = vi.hoisted(() => vi.fn());
const getAnnotationQuote = vi.hoisted(() => vi.fn());
const listCitations = vi.hoisted(() => vi.fn());
const getBibliography = vi.hoisted(() => vi.fn());
const copyCitation = vi.hoisted(() => vi.fn());
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listDocumentAnnotations,
  listAnnotations,
  getAnnotationQuote,
}));
vi.mock('../../api/citations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/citations')>()),
  listCitations,
  getBibliography,
}));
vi.mock('../citations/exportActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../citations/exportActions')>()),
  copyCitation,
}));

const summary = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'note',
  color: [255, 248, 77],
  contents: `Text ${id}`,
  author: 'Ann',
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
  ...over,
});

const LIST = [
  summary(1, { kind: 'highlight', contents: '', cite: true, tags: ['Method'] }),
  summary(2, { kind: 'note', contents: 'A plain note', tags: ['Method', 'Idea'] }),
  summary(3, { kind: 'note', contents: 'Another note' }),
];

const CITATION: CitationInfo = {
  id: 1,
  pageId: 0,
  locator: 'iv',
  quote: 'The quoted passage of the paper',
  contents: '',
  tags: ['Method'],
  group: null,
  color: [255, 248, 77],
};

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  listDocumentAnnotations.mockReset().mockResolvedValue(LIST);
  listAnnotations.mockReset().mockResolvedValue([]);
  getAnnotationQuote.mockReset().mockResolvedValue(null);
  listCitations.mockReset().mockResolvedValue([CITATION]);
  getBibliography.mockReset().mockResolvedValue({
    record: { ...emptyBibRecord(), title: 'On things', year: '2021', authors: [{ family: 'Müller', given: 'Anna' }] },
    sources: {},
    pending: false,
    droppedByStrip: false,
  });
  copyCitation.mockReset().mockResolvedValue(undefined);
  clearQuotes();
  useCitationStore.setState({ byDoc: {} });
  useComments.setState({ byDoc: {}, views: {}, editing: {} });
  useAnnotations.setState({ byDoc: {}, selectedIds: {} });
  useSettings.setState({
    ...DEFAULT_SETTINGS,
    tags: [
      { name: 'Method', color: TAG_PALETTE[0] as [number, number, number] },
      { name: 'Idea', color: TAG_PALETTE[1] as [number, number, number] },
    ],
  });
  resetViewer();
  showDocument({ id: 1, pageCount: 5, displayName: 'Book.pdf' });
});

afterEach(async () => {
  cancelJumpWait();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  useSettings.setState({ ...DEFAULT_SETTINGS });
});

const cards = () => screen.queryAllByRole('article');

async function shown() {
  const view = setup(<Comments />);
  await vi.waitFor(() => expect(cards().length).toBe(3), { timeout: 8000 });
  return view;
}

describe('citation cards', () => {
  it('shows the quote, the short citation with the page label, chips and Copy', async () => {
    const { user } = await shown();
    const card = cards().find((c) => within(c).queryByText('The quoted passage of the paper') !== null);
    expect(card).toBeDefined();
    const inCard = within(card as HTMLElement);
    expect(await inCard.findByText(/Müller, 2021.*p\. iv/u)).toBeTruthy();
    expect(inCard.getByText('Method')).toBeTruthy();
    expect(inCard.getByText('Citation:', { exact: false })).toBeTruthy();
    await user.click(inCard.getByRole('button', { name: 'Copy citation' }));
    expect(copyCitation).toHaveBeenCalledWith(1, 1);
    // A citation has Copy, not Reply; Delete lives in the ⋯ menu, so the action row stays one row.
    expect(inCard.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(inCard.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('shows chips on a normal card', async () => {
    await shown();
    const card = cards().find((c) => within(c).queryByText('A plain note') !== null) as HTMLElement;
    expect(within(card).getByText('Method')).toBeTruthy();
    expect(within(card).getByText('Idea')).toBeTruthy();
  });
});

describe('comments filter', () => {
  it('filters by the type Citation and reports "n of m" with a reset', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: /^Filter/u }));
    await user.click(screen.getByRole('checkbox', { name: 'Citation' }));
    expect(cards()).toHaveLength(1);
    expect(screen.getByText('1 of 3')).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(screen.getAllByRole('button', { name: 'Reset' })[0] as HTMLElement);
    expect(cards()).toHaveLength(3);
  });

  it('filters by tag, and by "No tag"', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: /^Filter/u }));
    await user.click(screen.getByRole('checkbox', { name: /^Idea/u }));
    expect(cards()).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: /^Idea/u }));
    await user.click(screen.getByRole('checkbox', { name: /^No tag/u }));
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0] as HTMLElement).getByText('Another note')).toBeTruthy();
  });

  it('opens the tag manager in the same popover, and has no Tags group without tags', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: /^Filter/u }));
    await user.click(screen.getByRole('button', { name: 'Manage tags…' }));
    expect(screen.getByRole('heading', { name: 'Tags' })).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('places the Reference button above the empty Comments state', async () => {
    listDocumentAnnotations.mockResolvedValue([]);
    listCitations.mockResolvedValue([]);
    setup(<Comments />);
    const empty = await screen.findByText('No comments yet');
    const button = screen.getByRole('button', { name: 'Reference and citation list' });
    expect(button.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the Reference button between Filter and sort', async () => {
    await shown();
    const row = screen.getByRole('button', { name: /^Filter/u }).parentElement as HTMLElement;
    const names = within(row)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names[0]).toMatch(/^Filter/u);
    expect(names[1]).toBe('Reference and citation list');
    expect(names).toHaveLength(3);
  });
});
