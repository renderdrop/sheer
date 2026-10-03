// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../api/annotations';
import type { ChangeSet } from '../../api/annotations';
import type { PageSlotInfo } from '../../api/pages';
import { useAnnotations, EMPTY_HISTORY } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { Inspector } from '../shell/Inspector';
import { setFileRotation } from '../viewer/fileRotation';
import { fitsAll, sizesDiffer, targetPages } from './actions';
import { CropLayer } from './CropLayer';
import { installCropMode } from './mode';
import { useCrop } from './store';

vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  applyCommand: vi.fn(),
}));
const applyMock = vi.mocked(api.applyCommand);

const uiInitial = useUi.getState();
const documentsInitial = useDocuments.getState();
const annotationsInitial = useAnnotations.getState();

function slot(id: number, extra: Partial<PageSlotInfo> = {}): PageSlotInfo {
  return {
    id,
    width: 600,
    height: 800,
    rotation: 0,
    rev: 0,
    label: null,
    origin: 'file',
    media: { width: 600, height: 800 },
    crop: null,
    ...extra,
  };
}

const SLOTS = [slot(0), slot(1), slot(2), slot(3)];

const changes: ChangeSet = {
  rev: 2,
  upserted: [],
  removed: [],
  pages: null,
  history: { ...EMPTY_HISTORY, canUndo: true, undoLabel: 'crop', dirty: true },
};

let stop: () => void = () => undefined;

function load(slots: readonly PageSlotInfo[] = SLOTS) {
  useDocuments.setState({
    ...documentsInitial,
    byId: { 1: { id: 1, pageCount: slots.length, displayName: 'a.pdf' } },
    order: [1],
    activeId: 1,
  });
  usePages.getState().setSlots(1, slots);
  useView.getState().open(1, slots.length);
  slots.forEach((s) => setFileRotation(1, s.id, s.rotation));
}

beforeEach(() => {
  stop();
  useUi.setState({ ...uiInitial }, true);
  useDocuments.setState({ ...documentsInitial }, true);
  useAnnotations.setState({ ...annotationsInitial }, true);
  useCrop.getState().clear();
  applyMock.mockReset();
  applyMock.mockResolvedValue(changes);
  load();
  stop = installCropMode();
});

describe('targetPages', () => {
  it('knows the three scopes', () => {
    expect(targetPages(SLOTS, SLOTS[1]!, 'current', '')?.map((s) => s.id)).toEqual([1]);
    expect(targetPages(SLOTS, SLOTS[1]!, 'all', '')?.map((s) => s.id)).toEqual([0, 1, 2, 3]);
    expect(targetPages(SLOTS, SLOTS[1]!, 'range', '1-2, 4')?.map((s) => s.id)).toEqual([0, 1, 3]);
    expect(targetPages(SLOTS, SLOTS[1]!, 'range', '3-')?.map((s) => s.id)).toEqual([2, 3]);
  });

  it('refuses a range that is not valid', () => {
    for (const text of ['', '0', '5', '3-1', 'a', '1,,2', '1-9']) {
      expect(targetPages(SLOTS, SLOTS[0]!, 'range', text)).toBeNull();
    }
  });

  it('checks that every page keeps the minimum and tells different sizes', () => {
    const small = slot(9, { media: { width: 100, height: 100 } });
    expect(fitsAll({ top: 0, right: 0, bottom: 0, left: 40 }, [small])).toBe(false);
    expect(fitsAll({ top: 0, right: 0, bottom: 0, left: 40 }, SLOTS)).toBe(true);
    expect(sizesDiffer([...SLOTS, small])).toBe(true);
    expect(sizesDiffer(SLOTS)).toBe(false);
  });
});

describe('the crop mode', () => {
  it('forces single page view and opens the inspector, and gives both back', () => {
    useUi.getState().setInspector('closed');
    act(() => useUi.getState().selectTool('crop'));
    expect(useView.getState().byDoc[1]?.scrollMode).toBe('single');
    expect(useUi.getState().inspector).toBe('open');
    act(() => useUi.getState().releaseTool());
    expect(useView.getState().byDoc[1]?.scrollMode).toBe('continuous');
    expect(useUi.getState().inspector).toBe('closed');
  });

  it('ends when another document becomes active', () => {
    act(() => useUi.getState().selectTool('crop'));
    act(() => useDocuments.setState({ activeId: null }));
    expect(useUi.getState().activeTool).toBe('select');
  });
});

describe('the inspector', () => {
  it('shows nothing of the crop outside the mode', () => {
    setup(<Inspector />);
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('applies the margins to the current page as one command and ends the mode', async () => {
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    expect(screen.getByRole('heading', { name: 'Crop pages' })).not.toBeNull();
    const top = screen.getByLabelText('Top');
    await user.clear(top);
    await user.type(top, '1{Enter}');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(1, {
      type: 'cropPages',
      pages: [0],
      spec: { type: 'margins', top: 72, right: 0, bottom: 0, left: 0 },
    });
    await vi.waitFor(() => expect(useUi.getState().activeTool).toBe('select'));
  });

  it('applies to all pages and to a range, and checks the range', async () => {
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    await user.click(screen.getByRole('radio', { name: 'All pages' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(applyMock.mock.calls[0]?.[1]).toMatchObject({ pages: [0, 1, 2, 3] });

    applyMock.mockClear();
    act(() => useUi.getState().selectTool('crop'));
    await user.click(screen.getByRole('radio', { name: 'Pages' }));
    const range = screen.getByRole('textbox', { name: 'Pages' });
    await user.type(range, '9');
    expect(range.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use pages 1 to 4, e.g. 1-3, 5, 8-.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(applyMock).not.toHaveBeenCalled();
    await user.clear(range);
    await user.type(range, '2-3');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(applyMock.mock.calls[0]?.[1]).toMatchObject({ pages: [1, 2] });
  });

  it('flags a size under the minimum and keeps the rectangle', async () => {
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    const left = screen.getByLabelText('Left');
    await user.clear(left);
    await user.type(left, '8{Enter}');
    expect(left.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('The area must be at least 1 inch on each side.')).not.toBeNull();
    expect(useCrop.getState().margins).toBeNull();
  });

  it('maps the Top field to the page side that is on top when the page is turned', async () => {
    load([slot(0, { rotation: 90 })]);
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    const top = screen.getByLabelText('Top');
    await user.clear(top);
    await user.type(top, '1{Enter}');
    expect(useCrop.getState().margins).toEqual({ top: 0, right: 0, bottom: 0, left: 72 });
  });

  it('resets the chosen pages to the MediaBox and says Reset only where there is a crop', async () => {
    load([slot(0, { crop: { top: 10, right: 10, bottom: 10, left: 10 } }), slot(1)]);
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'cropPages', pages: [0], spec: { type: 'reset' } });
  });

  it('keeps the mode and shows the error when the backend refuses', async () => {
    applyMock.mockRejectedValue({ code: 'invalid_argument', key: 'error.invalidArgument', retryable: false });
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(useUi.getState().activeTool).toBe('crop');
    expect(useUi.getState().banner).not.toBeNull();
  });

  it('cancels without sending anything', async () => {
    const { user } = setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUi.getState().activeTool).toBe('select');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('says that cropping hides content', () => {
    setup(<Inspector />);
    act(() => useUi.getState().selectTool('crop'));
    expect(screen.getByText(/hides content but keeps it/)).not.toBeNull();
  });
});

describe('the layer', () => {
  const props = {
    docId: 1,
    pageIndex: 0,
    boxWidth: 600,
    boxHeight: 800,
    widthPt: 600,
    heightPt: 800,
    rotation: 0,
    ready: true,
  };

  it('renders only in the mode, on the current page', () => {
    const { container, rerender } = setup(<CropLayer {...props} />);
    expect(container.querySelector('[data-crop-rect]')).toBeNull();
    act(() => useUi.getState().selectTool('crop'));
    rerender(<CropLayer {...props} />);
    expect(container.querySelector('[data-crop-rect]')).not.toBeNull();
    expect(container.querySelectorAll('[data-crop-handle]')).toHaveLength(8);
    rerender(<CropLayer {...props} pageIndex={1} />);
    expect(container.querySelector('[data-crop-rect]')).toBeNull();
  });

  it('moves and resizes with the arrow keys, and Enter applies', async () => {
    const { user } = setup(<CropLayer {...props} />);
    act(() => useUi.getState().selectTool('crop'));
    const rect = screen.getByRole('group', { name: 'Crop area, page 1' });
    // At the page's edges there is no room to move: shrink the right edge first (Alt+Left), then move right.
    rect.focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(useCrop.getState().margins).toEqual({ top: 0, right: 1, bottom: 0, left: 0 });
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(useCrop.getState().margins).toEqual({ top: 0, right: 0, bottom: 0, left: 1 });
    await user.keyboard('{Enter}');
    expect(applyMock).toHaveBeenCalledWith(1, expect.objectContaining({ pages: [0] }));
  });

  it('draws the rectangle in the page space of a turned page', () => {
    load([slot(0, { rotation: 90, width: 600, height: 800 })]);
    act(() => useUi.getState().selectTool('crop'));
    const { container } = setup(<CropLayer {...props} widthPt={800} heightPt={600} boxWidth={800} boxHeight={600} />);
    const rect = container.querySelector<HTMLElement>('[data-crop-rect]');
    expect(rect?.style.width).toBe('600px');
    expect(rect?.style.height).toBe('800px');
  });
});
