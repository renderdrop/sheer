// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { useAnnotations } from '../../stores/annotations';
import { setup } from '../../test/render';
import { buildThreads, type Thread } from '../comments/model';
import { PageLayout, buildMetrics } from '../viewer/layout';
import { publishViewRect } from '../viewer/scrollBridge';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { MarginColumn } from './MarginColumn';
import { hasBubble } from './useBubbles';

const listAnnotations = vi.hoisted(() => vi.fn());
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listAnnotations,
}));

const summary = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'note',
  color: [255, 235, 0],
  contents: `Text ${id}`,
  author: 'Ann',
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
  ...over,
});

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const layout = () =>
  new PageLayout(buildMetrics([[600, 800]], 'continuous'), {
    zoom: 1,
    gap: 24,
    viewport: { width: 700, height: 600 },
    current: 0,
  });

const threadsOf = (list: AnnotationSummary[]): Thread[] => buildThreads(list).filter(hasBubble);

function column(mode: 'full' | 'compact', list: AnnotationSummary[]) {
  return setup(
    <MarginColumn
      docId={1}
      layout={layout()}
      threads={threadsOf(list)}
      mode={mode}
      drawnSizes={[[600, 800]]}
      rotation={0}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  listAnnotations.mockReset().mockResolvedValue([]);
  useAnnotations.setState({ byDoc: {}, selectedIds: {} });
  resetViewer();
  showDocument({ id: 1, pageCount: 1, displayName: 'Book.pdf' });
  act(() => publishViewRect({ left: 0, top: 0, right: 700, bottom: 600 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which comments have a bubble', () => {
  it('takes comment text or replies, not a text box and not an empty mark', () => {
    const all = buildThreads([
      summary(1),
      summary(2, { contents: '' }),
      summary(3, { kind: 'freeText' }),
      summary(4, { contents: '' }),
      summary(5, { inReplyTo: 4, contents: 'reply' }),
    ]);
    expect(all.filter(hasBubble).map((t) => t.root.id)).toEqual([1, 4]);
  });
});

describe('MarginColumn', () => {
  it('is a list with a bubble per comment, named by type, author and page', () => {
    column('full', [summary(1), summary(2, { author: null })]);
    expect(screen.getByRole('list', { name: 'Comments in margin' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Note by Ann, page 1' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Note by No author, page 1' })).toBeTruthy();
  });

  it('shows the avatar initial, the text, the replies and a reply field', () => {
    column('full', [summary(1), summary(2, { inReplyTo: 1, author: 'Bob', contents: 'An answer' })]);
    const bubble = screen.getByRole('article', { name: /Note by Ann/ });
    expect(bubble.textContent).toContain('A');
    expect(bubble.textContent).toContain('Text 1');
    expect(bubble.textContent).toContain('An answer');
    expect(within(bubble).getByRole('textbox', { name: 'Write a reply' })).toBeTruthy();
    expect(within(bubble).getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });

  it('is one tab stop and moves between bubbles with Up and Down, Enter going to the reply field', async () => {
    const { user } = column('full', [summary(1), summary(2, { author: 'Bob' })]);
    const [first, second] = screen.getAllByRole('article') as [HTMLElement, HTMLElement];
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(second);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{Enter}');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(within(first).getByRole('textbox', { name: 'Write a reply' })),
    );
  });

  it('stacks bubbles 8 px apart when their anchors are close', () => {
    column('full', [summary(1), summary(2, { author: 'Bob' })]);
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-item]'));
    // Both anchors are at the top of the page (no geometry yet); the heights are estimates (120) in jsdom.
    expect(items.map((el) => el.style.top)).toEqual(['0px', '128px']);
  });

  it('collapses to avatar markers that open the bubble as a popover', async () => {
    const { user } = column('compact', [summary(1)]);
    expect(screen.queryByRole('article')).toBeNull();
    const marker = screen.getByRole('button', { name: 'Open comment by Ann' });
    await user.click(marker);
    expect(screen.getByRole('article', { name: 'Note by Ann, page 1' })).toBeTruthy();
    await user.keyboard('{Escape}');
  });

  it('mounts only the bubbles near the viewport', () => {
    const many = Array.from({ length: 40 }, (_, i) => summary(i + 1));
    column('full', many);
    // Everything is on one page here: all 40 stack, but only those within a viewport of the view are mounted.
    expect(screen.getAllByRole('article').length).toBeLessThan(40);
  });
});
