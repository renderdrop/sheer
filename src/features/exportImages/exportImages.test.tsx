// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import type { JobEvent } from '../../api/jobs';
import type { PageSlotInfo } from '../../api/pages';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ExportImagesDialog } from './ExportImagesDialog';
import { clampDpi, estimateBytes, parseDpi, resolvePages, toSelection } from './model';

const api = vi.hoisted(() => ({ exportImages: vi.fn(), resolveExportConflicts: vi.fn() }));
const jobs = vi.hoisted(() => ({ cancelJob: vi.fn() }));

vi.mock('../../api/exportImages', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), ...jobs }));

MotionGlobalConfig.skipAnimations = true;

const DOC: DocumentInfo = { id: 1, pageCount: 10, displayName: 'A.pdf' };
const slots: PageSlotInfo[] = Array.from({ length: 10 }, (_, id) => ({
  id,
  width: 612,
  height: 792,
  rotation: 0,
  rev: 0,
  label: null,
  origin: 'file',
}));
const done = (
  outputs: number,
  warnings: JobEvent extends infer E ? (E extends { warnings: infer W } ? W : never) : never = [],
): JobEvent => ({
  type: 'done',
  outputs,
  bytesBefore: 0,
  bytesAfter: 0,
  warnings,
  opened: null,
});

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add(DOC);
  usePages.getState().setSlots(1, slots);
  api.exportImages.mockReset();
  api.resolveExportConflicts.mockReset();
  jobs.cancelJob.mockReset().mockResolvedValue(undefined);
  globalThis.localStorage.clear();
  useUi.setState({ toast: null, exportImagesOpen: false });
});

describe('validation', () => {
  it('accepts whole dpi from 36 to 600 only', () => {
    expect(parseDpi('36')).toBe(36);
    expect(parseDpi('600')).toBe(600);
    expect(parseDpi('35')).toBeNull();
    expect(parseDpi('601')).toBeNull();
    expect(parseDpi('1.5')).toBeNull();
    expect(parseDpi('')).toBeNull();
    expect(clampDpi(9000)).toBe(600);
    expect(clampDpi(1)).toBe(36);
  });

  it('resolves page modes', () => {
    expect(resolvePages('all', '', slots, 0, [])).toMatchObject({ ok: true });
    expect(resolvePages('current', '', slots, 4, [])).toEqual({ ok: true, indices: [4] });
    expect(resolvePages('selected', '', slots, 0, [2, 5])).toEqual({ ok: true, indices: [2, 5] });
    expect(resolvePages('selected', '', slots, 0, [])).toEqual({ ok: false, problem: null });
    expect(resolvePages('range', '1-3, 8-', slots, 0, [])).toEqual({ ok: true, indices: [0, 1, 2, 7, 8, 9] });
    expect(resolvePages('range', '', slots, 0, [])).toEqual({ ok: false, problem: null });
    expect(resolvePages('range', '0-3', slots, 0, [])).toEqual({ ok: false, problem: 'invalid' });
    expect(resolvePages('range', '5-99', slots, 0, [])).toEqual({ ok: false, problem: 'invalid' });
  });

  it('builds the selection the backend takes', () => {
    expect(toSelection('all', '', slots, 0, [])).toEqual({ type: 'all' });
    expect(toSelection('current', '', slots, 3, [])).toEqual({ type: 'current', pageId: 3 });
    expect(toSelection('selected', '', slots, 0, [1, 2])).toEqual({ type: 'pages', pages: [1, 2] });
    expect(toSelection('range', ' 1-2 ', slots, 0, [])).toEqual({ type: 'ranges', text: '1-2' });
  });

  it('estimates more bytes for more pixels and for higher JPEG quality', () => {
    const base = estimateBytes(slots, [0], 150, 'png', 85);
    expect(estimateBytes(slots, [0], 300, 'png', 85)).toBeGreaterThan(base * 3);
    expect(Math.abs(estimateBytes(slots, [0, 1], 150, 'png', 85) - base * 2)).toBeLessThanOrEqual(1);
    expect(estimateBytes(slots, [0], 150, 'jpeg', 95)).toBeGreaterThan(estimateBytes(slots, [0], 150, 'jpeg', 20));
  });
});

describe('the dialog', () => {
  const open = async () => {
    const view = setup(<ExportImagesDialog />);
    act(() => useUi.getState().setExportImagesOpen(true));
    await screen.findByRole('dialog');
    return view;
  };

  it('focuses the format first and shows the estimate', async () => {
    await open();
    expect(screen.getByRole('radio', { name: 'PNG' })).toBe(document.activeElement);
    expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/10 images, about/);
  });

  it('blocks Go on an invalid range and says why', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('radio', { name: 'Pages' }));
    await user.type(screen.getByRole('textbox', { name: 'Page ranges' }), '3-99');
    await screen.findByText('Use pages 1 to 10, e.g. 1-3, 5, 8-.');
    expect(screen.getByRole('button', { name: 'Export…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('runs a job and closes with a toast', async () => {
    api.exportImages.mockImplementation((_doc: number, _opts: unknown, onEvent: (e: JobEvent) => void) => {
      queueMicrotask(() => onEvent(done(10)));
      return Promise.resolve({ type: 'started', jobId: 7 });
    });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(useUi.getState().exportImagesOpen).toBe(false));
    expect(api.exportImages.mock.calls[0]?.[1]).toMatchObject({
      pages: { type: 'all' },
      dpi: 150,
      format: 'png',
      annotations: true,
    });
    expect(useUi.getState().toast?.message).toContain('10 images saved');
  });

  it('says a lowered resolution in the dialog with Done, not in the toast', async () => {
    api.exportImages.mockImplementation((_doc: number, _opts: unknown, onEvent: (e: JobEvent) => void) => {
      queueMicrotask(() => onEvent(done(10, ['dpiLowered'])));
      return Promise.resolve({ type: 'started', jobId: 7 });
    });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    expect(await screen.findByText('Some large pages are exported at a lower resolution.')).toBeTruthy();
    expect(useUi.getState().exportImagesOpen).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(useUi.getState().exportImagesOpen).toBe(false);
  });

  it('names the file in the toast for a single page', async () => {
    api.exportImages.mockImplementation((_doc: number, _opts: unknown, onEvent: (e: JobEvent) => void) => {
      queueMicrotask(() => onEvent(done(1)));
      return Promise.resolve({ type: 'started', jobId: 7 });
    });
    const { user } = await open();
    await user.click(screen.getByRole('radio', { name: 'Current page' }));
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(useUi.getState().exportImagesOpen).toBe(false));
    expect(useUi.getState().toast?.message).toBe('Saved A-p01.png');
  });

  it('steps the custom dpi with the arrows, ten at a time with Shift', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const field = screen.getByRole('textbox', { name: 'Custom resolution in dpi' }) as HTMLInputElement;
    await user.click(field);
    await user.keyboard('{ArrowUp}');
    expect(field.value).toBe('151');
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(field.value).toBe('161');
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{ArrowDown}');
    expect(field.value).toBe('150');
  });

  it('remembers format, resolution and quality', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('radio', { name: 'JPEG' }));
    await user.click(screen.getByRole('radio', { name: '300' }));
    expect(JSON.stringify(Object.values(globalThis.localStorage))).toMatch(/300/);
    act(() => useUi.getState().setExportImagesOpen(false));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => useUi.getState().setExportImagesOpen(true));
    await screen.findByRole('dialog');
    expect(screen.getByRole('radio', { name: 'JPEG' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '300' }).getAttribute('aria-checked')).toBe('true');
  });

  it('returns to the form when the folder dialog is cancelled', async () => {
    api.exportImages.mockResolvedValue({ type: 'cancelled' });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export…' }).getAttribute('aria-disabled')).not.toBe('true'),
    );
    expect(useUi.getState().exportImagesOpen).toBe(true);
  });

  it('offers the three conflict choices', async () => {
    api.exportImages.mockResolvedValue({ type: 'conflicts', ticket: 3, count: 2, names: ['A-p01.png', 'A-p02.png'] });
    api.resolveExportConflicts.mockImplementation((_t: number, _c: string, onEvent: (e: JobEvent) => void) => {
      queueMicrotask(() => onEvent(done(10)));
      return Promise.resolve(8);
    });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await screen.findByText('Files already exist');
    expect(screen.getByText('A-p01.png')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep both' }));
    await waitFor(() => expect(useUi.getState().exportImagesOpen).toBe(false));
    expect(api.resolveExportConflicts.mock.calls[0]?.slice(0, 2)).toEqual([3, 'keepBoth']);
  });

  it('cancelling the conflict step releases the ticket and keeps the dialog', async () => {
    api.exportImages.mockResolvedValue({ type: 'conflicts', ticket: 4, count: 1, names: ['A-p01.png'] });
    api.resolveExportConflicts.mockResolvedValue(null);
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await screen.findByText('Files already exist');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.resolveExportConflicts.mock.calls[0]?.slice(0, 2)).toEqual([4, 'cancel']);
    await screen.findByRole('button', { name: 'Export…' });
    expect(useUi.getState().exportImagesOpen).toBe(true);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'PNG' })).toBe(document.activeElement));
  });

  it('stops a running job and says how many files were written', async () => {
    let emit: (e: JobEvent) => void = () => undefined;
    api.exportImages.mockImplementation((_d: number, _o: unknown, onEvent: (e: JobEvent) => void) => {
      emit = onEvent;
      return Promise.resolve({ type: 'started', jobId: 9 });
    });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(api.exportImages).toHaveBeenCalled());
    await act(async () => {
      emit({ type: 'progress', phase: 'encode', done: 3, total: 10 });
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(jobs.cancelJob).toHaveBeenCalledWith(9);
    await act(async () => {
      emit({ type: 'cancelled' });
    });
    expect(useUi.getState().toast?.message).toBe('Export stopped, 3 images saved');
    expect(useUi.getState().exportImagesOpen).toBe(false);
  });

  it('explains and blocks when copying is not permitted', async () => {
    useDocuments.setState((state) => ({
      byId: {
        ...state.byId,
        1: { ...DOC, flags: { encrypted: true, xfa: false, hasForms: false, signed: false, permissions: ['print'] } },
      },
    }));
    await open();
    expect(screen.getByText("The document's permissions don't allow this.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('closes on Escape', async () => {
    const { user } = await open();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(useUi.getState().exportImagesOpen).toBe(false));
  });
});
