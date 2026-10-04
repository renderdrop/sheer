// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobEvent } from '../../api/jobs';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { handleImagesDropped } from './imagesDropped';
import { ImagesToPdfDialog } from './ImagesToPdfDialog';
import { MARGIN_PT, toOptions } from './options';
import { useImagesToPdf } from './state';

const api = vi.hoisted(() => ({ imagesToPdf: vi.fn(), releaseImageBatch: vi.fn() }));
const app = vi.hoisted(() => ({ appReady: vi.fn() }));
const adopt = vi.hoisted(() => vi.fn());
vi.mock('../../api/imagesToPdf', () => api);
vi.mock('../../api/app', async (importOriginal) => ({ ...(await importOriginal<object>()), ...app }));
vi.mock('../viewer/useViewer', () => ({ adoptOpenOutcomes: adopt }));
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), cancelJob: vi.fn() }));

MotionGlobalConfig.skipAnimations = true;

const reports = (event: JobEvent) => (_opts: unknown, onEvent: (e: JobEvent) => void) => {
  queueMicrotask(() => onEvent(event));
  return Promise.resolve(3);
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  app.appReady.mockResolvedValue({ paper: 'letter' });
  api.releaseImageBatch.mockResolvedValue(undefined);
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
  it('defaults the paper from the OS region and creates from the open dialog', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    expect(api.imagesToPdf.mock.calls[0]?.[0]).toEqual({
      source: { type: 'dialog' },
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
    expect(await screen.findByText('3 images ready to add.')).toBeTruthy();
    expect(screen.getByText('1 image could not be used and was left out.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('2 images could not be used and were left out.'));
    expect(api.imagesToPdf.mock.calls[0]?.[0].source).toEqual({ type: 'batch', batch: 7 });
    expect(api.releaseImageBatch).not.toHaveBeenCalled();
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
