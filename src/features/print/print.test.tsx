// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import type { JobEvent } from '../../api/jobs';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useRedact } from '../redact/store';
import { setup } from '../../test/render';
import { PrintDialog } from './PrintDialog';
import { PrintSurface } from './PrintSurface';
import { clearSurface, handOver, PRINT_GRACE_MS, PRINT_LINGER_MS, stageFrames, usePrintSurface } from './session';

const print = vi.hoisted(() => ({
  preparePrint: vi.fn(),
  getPrintPage: vi.fn(),
  openPrintDialog: vi.fn(),
  releasePrint: vi.fn(),
}));
const jobs = vi.hoisted(() => ({ cancelJob: vi.fn() }));
vi.mock('../../api/print', async (importOriginal) => ({ ...(await importOriginal<object>()), ...print }));
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), ...jobs }));

MotionGlobalConfig.skipAnimations = true;

const DOC: DocumentInfo = { id: 1, pageCount: 4, displayName: 'A.pdf' };
const frame = { data: new Uint8Array([0xff, 0xd8, 0xff]), width: 100, height: 140 };

const finishes = (event: JobEvent) => (_id: number, _opts: unknown, onEvent: (e: JobEvent) => void) => {
  queueMicrotask(() => onEvent(event));
  return Promise.resolve(7);
};
const doneEvent = (pages: number): JobEvent => ({
  type: 'done',
  outputs: 1,
  bytesBefore: 0,
  bytesAfter: 0,
  warnings: [],
  opened: null,
  print: { printId: 9, pages },
});

let created: string[];
let revoked: string[];

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add(DOC);
  useUi.setState({ printOpen: true, banner: null });
  clearSurface();
  usePrintSurface.setState({ frames: [] });
  for (const fn of [...Object.values(print), ...Object.values(jobs)]) fn.mockReset();
  print.getPrintPage.mockResolvedValue(frame);
  print.releasePrint.mockResolvedValue(undefined);
  jobs.cancelJob.mockResolvedValue(undefined);
  created = [];
  revoked = [];
  let n = 0;
  URL.createObjectURL = () => {
    n += 1;
    const url = `blob:test/${n}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  HTMLImageElement.prototype.decode = vi.fn().mockResolvedValue(undefined);
  window.localStorage.clear();
});

const renderBoth = () =>
  setup(
    <>
      <PrintDialog />
      <PrintSurface />
    </>,
  );

describe('the print flow', () => {
  it('prepares, loads and decodes the frames, opens the dialog, then releases everything', async () => {
    let seen = -1;
    print.preparePrint.mockImplementation(finishes(doneEvent(2)));
    print.openPrintDialog.mockImplementation(() => {
      seen = document.querySelectorAll('[data-print-surface] > img').length;
      return Promise.resolve('system');
    });
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.preparePrint).toHaveBeenCalledWith(
      1,
      { pages: { type: 'all' }, annotations: true, quality: 'standard', autoRotate: true, paper: 'portrait' },
      expect.any(Function),
    );
    expect(seen).toBe(2);
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledTimes(2);
    expect(print.openPrintDialog).toHaveBeenCalledWith(9);
    expect(useUi.getState().printOpen).toBe(false);
    // The native dialog returns when it is opened (macOS: a sheet that paints after the user confirms): the pages stay until the
    // print is over, otherwise WKWebView prints blank sheets (ADR-107).
    expect(usePrintSurface.getState().frames).toHaveLength(2);
    expect(document.querySelectorAll('[data-print-surface] > img')).toHaveLength(2);
    expect(revoked).toEqual([]);
    vi.useFakeTimers();
    try {
      act(() => {
        window.dispatchEvent(new Event('afterprint'));
        vi.advanceTimersByTime(PRINT_GRACE_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(revoked).toEqual(created);
    expect(usePrintSurface.getState().frames).toEqual([]);
  });

  it('drops frames that nobody printed after the linger time', async () => {
    print.openPrintDialog.mockResolvedValue('webview');
    await stageFrames([{ url: 'blob:test/linger', width: 100, height: 140 }]);
    vi.useFakeTimers();
    try {
      await handOver(9);
      expect(usePrintSurface.getState().frames).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(PRINT_LINGER_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(usePrintSurface.getState().frames).toEqual([]);
    expect(revoked).toEqual(['blob:test/linger']);
  });

  it('sends the range and the options, and releases even when the dialog fails', async () => {
    print.preparePrint.mockImplementation(finishes(doneEvent(1)));
    print.openPrintDialog.mockRejectedValue(new Error('boom'));
    const { user } = renderBoth();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('radio', { name: 'Pages' }));
    await user.type(screen.getByRole('textbox', { name: 'Pages' }), '2-3');
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.preparePrint.mock.calls[0]?.[1]).toMatchObject({
      pages: { type: 'ranges', text: '2-3' },
      annotations: false,
      quality: 'high',
    });
    expect(revoked).toEqual(created);
    expect(useUi.getState().banner).not.toBeNull();
  });

  it('does not print an invalid range', async () => {
    const { user } = renderBoth();
    await user.click(screen.getByRole('radio', { name: 'Pages' }));
    await user.type(screen.getByRole('textbox', { name: 'Pages' }), '9');
    expect(screen.getByRole('button', { name: 'Print…' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Use pages 1 to 4/)).toBeTruthy();
  });

  it('releases the set and revokes the URLs when cancelled while the frames load', async () => {
    print.preparePrint.mockImplementation(finishes(doneEvent(3)));
    let release: (value: typeof frame) => void = () => undefined;
    print.getPrintPage
      .mockResolvedValueOnce(frame)
      .mockImplementationOnce(() => new Promise<typeof frame>((resolve) => (release = resolve)));
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.getPrintPage).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => release(frame));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.openPrintDialog).not.toHaveBeenCalled();
    expect(revoked).toEqual(created);
  });

  it('cancels the job while it prepares', async () => {
    print.preparePrint.mockResolvedValue(7);
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.preparePrint).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(jobs.cancelJob).toHaveBeenCalledWith(7));
    expect(print.openPrintDialog).not.toHaveBeenCalled();
  });

  it('treats a set with no pages as an error and never prints', async () => {
    print.preparePrint.mockImplementation(finishes(doneEvent(0)));
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.openPrintDialog).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(useUi.getState().printOpen).toBe(true);
  });

  it('drops the set when the dialog unmounts while the job prepares', async () => {
    let emit: (e: JobEvent) => void = () => undefined;
    print.preparePrint.mockImplementation((_id: number, _o: unknown, onEvent: (e: JobEvent) => void) => {
      emit = onEvent;
      return Promise.resolve(7);
    });
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.preparePrint).toHaveBeenCalled());
    act(() => useUi.getState().setPrintOpen(false));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => emit(doneEvent(2)));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.getPrintPage).not.toHaveBeenCalled();
    expect(print.openPrintDialog).not.toHaveBeenCalled();
  });

  it('releases the set and the URLs when the dialog unmounts while the images decode', async () => {
    print.preparePrint.mockImplementation(finishes(doneEvent(2)));
    const decoded: (() => void)[] = [];
    HTMLImageElement.prototype.decode = vi.fn(() => new Promise<void>((resolve) => void decoded.push(resolve)));
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(HTMLImageElement.prototype.decode).toHaveBeenCalled());
    act(() => useUi.getState().setPrintOpen(false));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => decoded.forEach((resolve) => resolve()));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.openPrintDialog).not.toHaveBeenCalled();
    expect(revoked).toEqual(created);
    expect(usePrintSurface.getState().frames).toEqual([]);
  });

  it('shows an error and releases everything when a decode fails', async () => {
    print.preparePrint.mockImplementation(finishes(doneEvent(2)));
    HTMLImageElement.prototype.decode = vi.fn().mockRejectedValue(new Error('bad image'));
    const { user } = renderBoth();
    await user.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(print.releasePrint).toHaveBeenCalledWith(9));
    expect(print.openPrintDialog).not.toHaveBeenCalled();
    expect(revoked).toEqual(created);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(useUi.getState().printOpen).toBe(true);
  });

  it('cannot start a second print while the system dialog is open', () => {
    usePrintSurface.setState({ printing: true });
    renderBoth();
    expect(screen.getByRole('button', { name: 'Print…' }).getAttribute('aria-disabled')).toBe('true');
    usePrintSurface.setState({ printing: false });
  });

  it('names the pending redaction marks', () => {
    renderBoth();
    expect(screen.queryByText('Unapplied redaction marks are not included.')).toBeNull();
    act(() => useRedact.setState({ marks: { 1: { 5: { id: 5, pageId: 0, kind: 'redactMark' } } } } as never));
    expect(screen.getByText('Unapplied redaction marks are not included.')).toBeTruthy();
    act(() => useRedact.setState({ marks: {} } as never));
  });

  it('is disabled with an explanation without print permission', () => {
    resetDocuments();
    useDocuments.getState().add({
      ...DOC,
      flags: { encrypted: true, xfa: false, hasForms: false, signed: false, permissions: ['copy'] },
    });
    renderBoth();
    expect(screen.getByRole('button', { name: 'Print…' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText("The document's permissions don't allow this.")).toBeTruthy();
  });
});

describe('the print surface and stylesheet', () => {
  it('renders one image per frame, hidden from assistive technology', () => {
    usePrintSurface.setState({ frames: [{ url: 'blob:x', width: 100, height: 140 }] });
    const { container } = render(<PrintSurface />);
    expect(container.querySelectorAll('[data-print-surface] > img')).toHaveLength(1);
    expect(container.querySelector('[data-print-surface]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hides the app under @media print and shows only the surface, with no margins', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'print.css'), 'utf8');
    const screenPart = css.slice(0, css.indexOf('@media print {'));
    const printPart = css.slice(css.indexOf('@media print {'));
    expect(screenPart).toMatch(/\[data-print-surface\]\s*\{\s*display:\s*none/);
    expect(printPart).toMatch(/#root > :not\(\[data-print-surface\]\)[^{]*\{\s*display:\s*none !important/);
    expect(printPart).toMatch(/body > :not\(#root\)/);
    expect(printPart).toMatch(/@page\s*\{\s*margin:\s*0/);
    expect(printPart).toMatch(/break-after:\s*page/);
  });
});
