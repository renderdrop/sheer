// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { useAnnotations } from '../../stores/annotations';
import { setup } from '../../test/render';
import { buildThreads, type Thread } from '../comments/model';
import { useComments } from '../comments/store';
import { useCommentHover } from '../comments/useCommentsData';
import { PageLayout, buildMetrics } from '../viewer/layout';
import { publishViewRect } from '../viewer/scrollBridge';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { MarginColumn } from './MarginColumn';
import { MarkOutline } from './MarkOutline';
import { hasBubble } from './useBubbles';

const hoisted = vi.hoisted(() => ({
  listAnnotations: vi.fn(),
  run: vi.fn(),
  discardNew: vi.fn(),
}));
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listAnnotations: hoisted.listAnnotations,
}));
vi.mock('../comments/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comments/actions')>()),
  run: hoisted.run,
  discardNew: hoisted.discardNew,
}));

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** The frame around a mark follows the mark's current box: it is read again on scroll, not kept. */
describe('MarkOutline position (F19.24 c)', () => {
  let scrollTop = 0;
  let frames: FrameRequestCallback[] = [];
  const flush = () =>
    act(() => {
      const run = frames;
      frames = [];
      for (const callback of run) callback(0);
    });
  beforeEach(() => {
    scrollTop = 0;
    frames = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  function Host() {
    const origin = useRef<HTMLDivElement | null>(null);
    return (
      <div role="region" data-testid="scroller">
        <div ref={origin} data-testid="origin" style={{ position: 'relative' }}>
          <MarkOutline origin={origin} annotId={5} mode="frame" />
        </div>
        <div data-annot-frame="5" data-testid="mark" />
      </div>
    );
  }

  it('is recomputed on scroll and on resize from the current boxes', () => {
    render(<Host />);
    const mark = screen.getByTestId('mark');
    const origin = screen.getByTestId('origin');
    // The origin stays put; the mark moves with the scroll position.
    origin.getBoundingClientRect = () => rect(100, 50, 400, 900);
    mark.getBoundingClientRect = () => rect(120, 200 - scrollTop, 80, 16);
    act(() => {
      fireEvent.scroll(screen.getByTestId('scroller'));
    });
    flush();
    const frame = () => document.querySelector<HTMLElement>('[data-mark-outline="5"]');
    expect(frame()?.style.left).toBe('20px');
    expect(frame()?.style.top).toBe('150px');
    scrollTop = 120;
    act(() => {
      fireEvent.scroll(screen.getByTestId('scroller'));
    });
    flush();
    expect(frame()?.style.top).toBe('30px');
    // A layout shift above the mark, reported by a resize, moves it too.
    mark.getBoundingClientRect = () => rect(140, 90, 100, 20);
    act(() => {
      fireEvent(window, new Event('resize'));
    });
    flush();
    expect(frame()?.style.left).toBe('40px');
    expect(frame()?.style.top).toBe('40px');
    expect(frame()?.style.width).toBe('100px');
  });

  it('shows nothing while the mark is not on screen', () => {
    render(<Host />);
    expect(document.querySelector('[data-mark-outline]')).toBeNull();
  });
});

const summary = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'highlight',
  color: [255, 235, 0],
  contents: `Text ${id}`,
  author: 'Ann',
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
  ...over,
});

const layout = () =>
  new PageLayout(buildMetrics([[600, 800]], 'continuous'), {
    zoom: 1,
    gap: 24,
    viewport: { width: 700, height: 600 },
    current: 0,
  });

function column(list: AnnotationSummary[], writing: number | null = null) {
  const threads: Thread[] = buildThreads(list).filter((thread) => hasBubble(thread, writing));
  return setup(
    <>
      <div data-annot-frame="1" />
      <MarginColumn docId={1} layout={layout()} threads={threads} mode="full" drawnSizes={[[600, 800]]} rotation={0} />
    </>,
  );
}

describe('hover pulse (F19.24 a)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    hoisted.listAnnotations.mockReset().mockResolvedValue([]);
    useAnnotations.setState({ byDoc: {}, selectedIds: {} });
    resetViewer();
    showDocument({ id: 1, pageCount: 1, displayName: 'Book.pdf' });
    act(() => publishViewRect({ left: 0, top: 0, right: 700, bottom: 600 }));
    useCommentHover.setState({ hovered: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('draws no connector line and pulses the mark once, for 400 ms', () => {
    vi.useFakeTimers();
    column([summary(1)]);
    const mark = document.querySelector<HTMLElement>('[data-annot-frame="1"]') as HTMLElement;
    mark.getBoundingClientRect = () => rect(10, 10, 50, 12);
    act(() => useCommentHover.getState().hover(1));
    expect(document.querySelector('[data-margin-column] svg line')).toBeNull();
    expect(document.querySelector('[data-mark-outline="1"][data-mode="pulse"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(document.querySelector('[data-mode="pulse"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(document.querySelector('[data-mode="pulse"]')).toBeNull();
  });

  it('with reduced motion the outline stays static for 600 ms', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    column([summary(1)]);
    const mark = document.querySelector<HTMLElement>('[data-annot-frame="1"]') as HTMLElement;
    mark.getBoundingClientRect = () => rect(10, 10, 50, 12);
    act(() => useCommentHover.getState().hover(1));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector('[data-mode="pulse"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(document.querySelector('[data-mode="pulse"]')).toBeNull();
  });
});

describe('a new comment is written in its bubble (F19.24 b)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    hoisted.listAnnotations.mockReset().mockResolvedValue([]);
    hoisted.run.mockReset().mockResolvedValue(undefined);
    hoisted.discardNew.mockReset().mockResolvedValue(undefined);
    useAnnotations.setState({ byDoc: {}, selectedIds: {} });
    resetViewer();
    showDocument({ id: 1, pageCount: 1, displayName: 'Book.pdf' });
    act(() => publishViewRect({ left: 0, top: 0, right: 700, bottom: 600 }));
    useComments.setState({ editing: { 1: { id: 1, fresh: true } } });
  });
  afterEach(() => {
    useComments.setState({ editing: {} });
    vi.unstubAllGlobals();
  });

  it('puts the focus in the field, takes typing, and Enter confirms', async () => {
    const { user } = column([summary(1, { contents: '' })], 1);
    const field = screen.getByRole('textbox', { name: 'Note text' });
    expect(document.activeElement).toBe(field);
    await user.keyboard('Hello{Shift>}{Enter}{/Shift}there');
    expect((field as HTMLTextAreaElement).value).toBe('Hello\nthere');
    await user.keyboard('{Enter}');
    expect(hoisted.run).toHaveBeenCalledWith(1, {
      type: 'updateAnnotation',
      id: 1,
      patch: { contents: 'Hello\nthere' },
    });
    expect(useComments.getState().editing[1]).toBeNull();
  });

  it('Esc discards the new comment', async () => {
    const { user } = column([summary(1, { contents: '' })], 1);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Note text' }));
    await user.keyboard('{Escape}');
    expect(hoisted.discardNew).toHaveBeenCalledWith(1, 1);
    expect(useComments.getState().editing[1]).toBeNull();
  });

  it('Enter on an empty new comment does nothing', async () => {
    const { user } = column([summary(1, { contents: '' })], 1);
    await user.keyboard('{Enter}');
    expect(hoisted.run).not.toHaveBeenCalled();
    expect(useComments.getState().editing[1]).toEqual({ id: 1, fresh: true });
  });
});
