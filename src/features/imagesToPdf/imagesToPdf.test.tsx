// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseFrame } from '../../api/frame';
import { makeFrame } from '../../api/frame.testutil';
import type { JobEvent } from '../../api/jobs';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { MAX_PREVIEWS_IN_FLIGHT } from './ImageList';
import { handleImagesDropped } from './imagesDropped';
import { ImagesToPdfDialog } from './ImagesToPdfDialog';
import { MARGIN_PT, toOptions } from './options';
import { useImagesToPdf } from './state';

const api = vi.hoisted(() => ({
  imagesToPdf: vi.fn(),
  releaseImageBatch: vi.fn(),
  pickImages: vi.fn(),
  listImageBatch: vi.fn(),
  getImageBatchPreview: vi.fn(),
}));
const app = vi.hoisted(() => ({ appReady: vi.fn() }));
const adopt = vi.hoisted(() => vi.fn());
vi.mock('../../api/imagesToPdf', () => api);
vi.mock('../../api/app', async (importOriginal) => ({ ...(await importOriginal<object>()), ...app }));
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: adopt }));
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), cancelJob: vi.fn() }));

MotionGlobalConfig.skipAnimations = true;

const items = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ index, name: `img${index + 1}.png`, width: 100 + index, height: 200 }));
const rows = () => screen.getAllByRole('option').map((row) => row.querySelector('.font-semibold')?.textContent);

const reports = (event: JobEvent) => (_opts: unknown, onEvent: (e: JobEvent) => void) => {
  queueMicrotask(() => onEvent(event));
  return Promise.resolve(3);
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  app.appReady.mockResolvedValue({ paper: 'letter' });
  api.releaseImageBatch.mockResolvedValue(undefined);
  api.getImageBatchPreview.mockResolvedValue(parseFrame(makeFrame()));
  api.listImageBatch.mockResolvedValue(items(3));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  useImagesToPdf.getState().setDropped(null);
  useUi.setState({ imagesToPdfOpen: false });
});

describe('options', () => {
  it('maps the margin presets to points', () => {
    expect(toOptions({ type: 'dialog' }, { paper: 'a4', orientation: 'auto', margin: 'large' })).toEqual({
      source: { type: 'dialog' },
      paper: 'a4',
      orientation: 'auto',
      marginPt: MARGIN_PT.large,
    });
  });
});

describe('Create PDF from images dialog', () => {
  it('defaults the paper from the OS region and creates from the picked images', async () => {
    api.pickImages.mockResolvedValueOnce({ batch: 9, count: 3, added: 3, skipped: 0 });
    api.imagesToPdf.mockImplementation(
      reports({
        type: 'done',
        outputs: 1,
        bytesBefore: 0,
        bytesAfter: 1,
        warnings: [],
        opened: { id: 9, pageCount: 2, displayName: 'Images' },
        skipped: 0,
      }),
    );
    const { user } = setup(<ImagesToPdfDialog />);
    act(() => useUi.getState().setImagesToPdfOpen(true));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Letter' }).getAttribute('aria-checked')).toBe('true'),
    );
    await user.click(screen.getByRole('radio', { name: 'Landscape' }));
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    await screen.findAllByRole('option');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    expect(api.imagesToPdf.mock.calls[0]?.[0]).toEqual({
      source: { type: 'batch', batch: 9 },
      paper: 'letter',
      orientation: 'landscape',
      marginPt: 68,
    });
    await waitFor(() => expect(useUi.getState().imagesToPdfOpen).toBe(false));
    expect(api.releaseImageBatch).not.toHaveBeenCalled();
  });

  it('opens prefilled for a dropped batch, uses it, and warns about skipped images', async () => {
    api.imagesToPdf.mockImplementation(
      reports({
        type: 'done',
        outputs: 1,
        bytesBefore: 0,
        bytesAfter: 1,
        warnings: ['imagesSkipped'],
        opened: null,
        skipped: 2,
      }),
    );
    const { user } = setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 7, count: 3, skipped: 1 }));
    expect(await screen.findByText('3 pages')).toBeTruthy();
    expect(screen.getByText('1 image could not be used and was left out.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('2 images could not be used and were left out.'));
    expect(api.imagesToPdf.mock.calls[0]?.[0].source).toEqual({ type: 'batch', batch: 7 });
    expect(api.releaseImageBatch).not.toHaveBeenCalled();
  });

  it('closes when the picker is cancelled', async () => {
    api.pickImages.mockResolvedValueOnce(null);
    setup(<ImagesToPdfDialog />);
    act(() => useUi.getState().setImagesToPdfOpen(true));
    await waitFor(() => expect(useUi.getState().imagesToPdfOpen).toBe(false));
  });

  it('lists names, reorders with Alt+arrows, removes, and sends the order', async () => {
    api.imagesToPdf.mockImplementation(
      reports({ type: 'done', outputs: 1, bytesBefore: 0, bytesAfter: 1, warnings: [], opened: null, skipped: 0 }),
    );
    const { user } = setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 7, count: 3, skipped: 0 }));
    await screen.findAllByRole('option');
    expect(rows()).toEqual(['img1.png', 'img2.png', 'img3.png']);
    screen.getAllByRole('option')[0]?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(rows()).toEqual(['img2.png', 'img1.png', 'img3.png']);
    await user.keyboard('{Delete}');
    expect(rows()).toEqual(['img2.png', 'img3.png']);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.imagesToPdf).toHaveBeenCalled());
    expect(api.imagesToPdf.mock.calls[0]?.[2]).toEqual([1, 2]);
  });

  it('adds images to the batch without resurrecting removed ones, and disables Create when empty', async () => {
    const { user } = setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 7, count: 2, skipped: 0 }));
    api.listImageBatch.mockResolvedValue(items(2));
    await screen.findAllByRole('option');
    await user.click(screen.getByRole('button', { name: 'Remove img1.png' }));
    api.pickImages.mockResolvedValueOnce({ batch: 7, count: 3, added: 1, skipped: 0 });
    api.listImageBatch.mockResolvedValue(items(3));
    await user.click(screen.getByRole('button', { name: 'Add images…' }));
    await waitFor(() => expect(rows()).toEqual(['img2.png', 'img3.png']));
    expect(api.pickImages).toHaveBeenCalledWith(7);
    await user.click(screen.getByRole('button', { name: 'Remove img2.png' }));
    await user.click(screen.getByRole('button', { name: 'Remove img3.png' }));
    expect(screen.getByText('Add images to begin.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('blocks Create on an image that cannot be read until it is removed', async () => {
    api.getImageBatchPreview.mockRejectedValue(new Error('cannot decode'));
    const { user } = setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 7, count: 3, skipped: 0 }));
    await screen.findAllByText("Can't read this image");
    expect(screen.getByRole('button', { name: 'Create' }).getAttribute('aria-disabled')).toBe('true');
    for (const name of ['img1.png', 'img2.png'])
      await user.click(screen.getByRole('button', { name: `Remove ${name}` }));
    await user.click(screen.getByRole('button', { name: 'Remove img3.png' }));
    expect(screen.getByText('Add images to begin.')).toBeTruthy();
  });

  it('releases the batch on Cancel and on Esc', async () => {
    const { user } = setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 4, count: 1, skipped: 0 }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(api.releaseImageBatch).toHaveBeenCalledWith(4);
    expect(useUi.getState().imagesToPdfOpen).toBe(false);

    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 5, count: 1, skipped: 0 }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(api.releaseImageBatch).toHaveBeenCalledWith(5));
  });

  it('lets go at once of a batch without a usable image, and of an earlier unused batch', () => {
    handleImagesDropped({ type: 'imagesDropped', batch: 1, count: 0, skipped: 2 });
    expect(api.releaseImageBatch).toHaveBeenCalledWith(1);
    expect(useUi.getState().imagesToPdfOpen).toBe(false);
    handleImagesDropped({ type: 'imagesDropped', batch: 2, count: 1, skipped: 0 });
    handleImagesDropped({ type: 'imagesDropped', batch: 3, count: 1, skipped: 0 });
    expect(api.releaseImageBatch).toHaveBeenCalledWith(2);
  });
});

describe('thumbnail loading', () => {
  const observers: Array<{ el: Element; fire: (v: boolean) => void }> = [];
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        cb: IntersectionObserverCallback;
        constructor(cb: IntersectionObserverCallback) {
          this.cb = cb;
        }
        observe(el: Element) {
          observers.push({
            el,
            fire: (v) =>
              this.cb([{ isIntersecting: v } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
          });
        }
        disconnect() {}
      },
    );
  });

  it('requests previews only for rows that became visible', async () => {
    api.listImageBatch.mockResolvedValue(items(6));
    setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 7, count: 6, skipped: 0 }));
    await screen.findAllByRole('option');
    await waitFor(() => expect(observers.length).toBe(6));
    expect(api.getImageBatchPreview).not.toHaveBeenCalled();
    act(() => {
      observers[0]?.fire(true);
      observers[1]?.fire(true);
    });
    await waitFor(() => expect(api.getImageBatchPreview).toHaveBeenCalledTimes(2));
  });

  it('never has more than the cap of previews in flight', async () => {
    api.listImageBatch.mockResolvedValue(items(10));
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    api.getImageBatchPreview.mockImplementation(() => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve(parseFrame(makeFrame()));
        });
      });
    });
    setup(<ImagesToPdfDialog />);
    act(() => handleImagesDropped({ type: 'imagesDropped', batch: 7, count: 10, skipped: 0 }));
    await waitFor(() => expect(observers.length).toBe(10));
    act(() => observers.forEach((o) => o.fire(true)));
    await waitFor(() => expect(api.getImageBatchPreview).toHaveBeenCalledTimes(MAX_PREVIEWS_IN_FLIGHT));
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        releases.shift()?.();
        await Promise.resolve();
      });
    }
    await waitFor(() => expect(api.getImageBatchPreview).toHaveBeenCalledTimes(10));
    expect(peak).toBeLessThanOrEqual(MAX_PREVIEWS_IN_FLIGHT);
  });
});
