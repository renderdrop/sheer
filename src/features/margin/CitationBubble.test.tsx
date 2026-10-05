// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { emptyBibRecord, type BibliographyInfo, type CitationInfo } from '../../api/citations';
import { useAnnotations } from '../../stores/annotations';
import { setup } from '../../test/render';
import { useCitationStore, requestCitationFocus } from '../citations/store';
import { buildThreads, type Thread } from '../comments/model';
import { PageLayout, buildMetrics } from '../viewer/layout';
import { publishViewRect } from '../viewer/scrollBridge';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { MarginColumn } from './MarginColumn';
import { hasBubble } from './useBubbles';

const mocks = vi.hoisted(() => ({
  bib: { info: undefined, loading: false } as { info: unknown; loading: boolean },
  copyCitation: vi.fn(),
  openReferenceDetails: vi.fn(),
}));
vi.mock('../citations/bibliography', () => ({
  useBibliography: () => mocks.bib,
  invalidateBibliography: vi.fn(),
}));
vi.mock('../citations/exportActions', () => ({ copyCitation: mocks.copyCitation }));
vi.mock('../properties/openReference', () => ({ openReferenceDetails: mocks.openReferenceDetails }));
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listAnnotations: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api/citations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/citations')>()),
  listCitations: vi.fn().mockResolvedValue([]),
}));

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const cite = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'highlight',
  color: [220, 207, 255],
  contents: '',
  author: null,
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
  cite: true,
  ...over,
});

const info = (id: number, over: Partial<CitationInfo> = {}): CitationInfo => ({
  id,
  pageId: 0,
  locator: 'xii',
  quote: 'A sentence worth keeping.',
  contents: '',
  tags: [],
  group: null,
  color: [220, 207, 255],
  ...over,
});

const complete: BibliographyInfo = {
  record: {
    ...emptyBibRecord(),
    kind: 'book',
    authors: [{ family: 'Müller', given: 'Anna' }],
    title: 'Things',
    year: '2021',
  },
  sources: {},
  pending: false,
  droppedByStrip: false,
};

const layout = () =>
  new PageLayout(buildMetrics([[600, 800]], 'continuous'), {
    zoom: 1,
    gap: 24,
    viewport: { width: 700, height: 600 },
    current: 0,
  });

function column(mode: 'full' | 'compact', list: AnnotationSummary[]) {
  const threads: Thread[] = buildThreads(list).filter(hasBubble);
  return setup(
    <MarginColumn docId={1} layout={layout()} threads={threads} mode={mode} drawnSizes={[[600, 800]]} rotation={0} />,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  useAnnotations.setState({ byDoc: {}, selectedIds: {} });
  useCitationStore.setState({ byDoc: { 1: [info(1)] } });
  mocks.bib = { info: complete, loading: false };
  mocks.copyCitation.mockReset().mockResolvedValue(undefined);
  mocks.openReferenceDetails.mockReset();
  resetViewer();
  showDocument({ id: 1, pageCount: 1, displayName: 'Book.pdf' });
  act(() => publishViewRect({ left: 0, top: 0, right: 700, bottom: 600 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  useCitationStore.setState({ byDoc: {} });
});

describe('which threads have a bubble', () => {
  it('gives a citation a bubble even without comment text', () => {
    const all = buildThreads([cite(1), cite(2, { cite: undefined })]);
    expect(all.filter(hasBubble).map((t) => t.root.id)).toEqual([1]);
  });
});

describe('the citation bubble', () => {
  it('shows the page label, the quote in quotation marks and the short citation', () => {
    column('full', [cite(1)]);
    const bubble = screen.getByRole('article', { name: 'Citation, page p. xii' });
    expect(within(bubble).getByText('p. xii')).toBeTruthy();
    expect(bubble.textContent).toContain('“A sentence worth keeping.”');
    expect(bubble.textContent).toContain('(Müller, 2021, p. xii)');
    expect(within(bubble).queryByRole('button', { name: 'Add reference details' })).toBeNull();
  });

  it('shows the tag chips and a Tags, Copy and options button', () => {
    useCitationStore.setState({ byDoc: { 1: [info(1, { tags: ['Key', 'Method'] })] } });
    column('full', [cite(1, { tags: ['Key', 'Method'] })]);
    const bubble = screen.getByRole('article');
    expect(within(bubble).getByText('Key')).toBeTruthy();
    expect(within(bubble).getByText('Method')).toBeTruthy();
    expect(within(bubble).getByRole('button', { name: 'Tags' })).toBeTruthy();
    expect(within(bubble).getByRole('button', { name: 'Copy citation' })).toBeTruthy();
    expect(within(bubble).getByRole('button', { name: 'Comment options' })).toBeTruthy();
  });

  it('copies the citation', async () => {
    const { user } = column('full', [cite(1)]);
    await user.click(screen.getByRole('button', { name: 'Copy citation' }));
    expect(mocks.copyCitation).toHaveBeenCalledWith(1, 1);
  });

  it('offers "Add reference details" while author or year is missing and opens the Reference tab', async () => {
    mocks.bib = { info: { ...complete, record: { ...complete.record, year: null } }, loading: false };
    const { user } = column('full', [cite(1)]);
    const bubble = screen.getByRole('article');
    expect(bubble.textContent).toContain('n.d.');
    await user.click(within(bubble).getByRole('button', { name: 'Add reference details' }));
    expect(mocks.openReferenceDetails).toHaveBeenCalledWith(1);
  });

  it('falls back to the page number without a label and shows a comment', () => {
    useCitationStore.setState({ byDoc: { 1: [] } });
    column('full', [cite(1, { contents: 'My note' })]);
    const bubble = screen.getByRole('article', { name: 'Citation, page p. 1' });
    expect(bubble.textContent).toContain('My note');
  });

  it('is one list with the comment bubbles and moves focus with Up and Down', async () => {
    const { user } = column('full', [cite(1), cite(2)]);
    expect(screen.getByRole('list', { name: 'Comments in margin' })).toBeTruthy();
    const [first, second] = screen.getAllByRole('article') as [HTMLElement, HTMLElement];
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(second);
  });

  it('focuses the bubble when the mini bar asks to open the citation', () => {
    column('full', [cite(1), cite(2)]);
    act(() => requestCitationFocus(2));
    const [, second] = screen.getAllByRole('article') as [HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(second);
  });

  it('collapses to a quote marker that opens the bubble', async () => {
    const { user } = column('compact', [cite(1)]);
    expect(screen.queryByRole('article')).toBeNull();
    const marker = screen.getByRole('button', { name: 'Citation, page 1' });
    expect(marker.querySelector('svg')).not.toBeNull();
    await user.click(marker);
    expect(screen.getByRole('article', { name: 'Citation, page p. xii' })).toBeTruthy();
  });
});
