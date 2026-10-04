// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import type { JobEvent } from '../../api/jobs';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ExportCopyDialog, canEditCopy, effectiveOptions, exportWarnings } from './ExportCopyDialog';

const api = vi.hoisted(() => ({ exportPdf: vi.fn() }));
vi.mock('../../api/exportPdf', () => api);
const cancelJob = vi.hoisted(() => vi.fn());
vi.mock('../../api/jobs', async (importOriginal) => ({ ...(await importOriginal<object>()), cancelJob }));

MotionGlobalConfig.skipAnimations = true;

const flags = { encrypted: false, xfa: false, hasForms: false, signed: false };
const doc = (extra: Partial<DocumentInfo> = {}): DocumentInfo => ({
  id: 1,
  pageCount: 3,
  displayName: 'A.pdf',
  ...extra,
});

const reports =
  (event: JobEvent) => (_docId: number, _opts: unknown, _ack: unknown, onEvent: (e: JobEvent) => void) => {
    queueMicrotask(() => onEvent(event));
    return Promise.resolve(7);
  };
const done = (
  warnings: JobEvent extends infer E ? (E extends { warnings: infer W } ? W : never) : never = [],
): JobEvent => ({
  type: 'done',
  outputs: 1,
  bytesBefore: 1,
  bytesAfter: 1,
  warnings,
  opened: null,
});

function open(info: DocumentInfo = doc()) {
  resetDocuments();
  useDocuments.getState().add(info);
  useUi.setState({ exportCopyOpen: true, toast: null });
  return setup(<ExportCopyDialog />);
}

beforeEach(() => {
  api.exportPdf.mockReset();
  cancelJob.mockReset().mockResolvedValue(undefined);
});

describe('helpers', () => {
  it('reads the edit permission', () => {
    expect(canEditCopy(null)).toBe(true);
    expect(canEditCopy(undefined)).toBe(true);
    expect(canEditCopy(['print'])).toBe(false);
    expect(canEditCopy(['edit'])).toBe(true);
  });
  it('limits the options without the permission', () => {
    expect(effectiveOptions('remove', true, false)).toEqual({ annotations: 'keep', removeMetadata: false });
    expect(effectiveOptions('remove', true, true)).toEqual({ annotations: 'remove', removeMetadata: true });
  });
  it('keeps only warnings it can say', () => {
    expect(exportWarnings(['signaturesRemoved', 'dpiLowered'])).toEqual(['signaturesRemoved']);
  });
});

describe('ExportCopyDialog', () => {
  it('shows the options with their explanation and the note', () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Export a copy' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Keep' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Comments and markup stay editable in the copy.')).toBeTruthy();
    expect(screen.getByText(/Unsaved edits are included/)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('sends the chosen options and ends with a toast', async () => {
    api.exportPdf.mockImplementation(reports(done()));
    const { user } = open();
    await user.click(screen.getByRole('radio', { name: 'Flatten' }));
    expect(screen.getByText(/become part of the pages/)).toBeTruthy();
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/left out/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    await waitFor(() => expect(useUi.getState().exportCopyOpen).toBe(false));
    expect(api.exportPdf.mock.calls[0]?.slice(0, 3)).toEqual([1, { annotations: 'flatten', removeMetadata: true }, {}]);
    expect(useUi.getState().toast?.message).toBe('Copy saved');
  });

  it('stays open when the Save As dialog is cancelled', async () => {
    api.exportPdf.mockResolvedValue(null);
    const { user } = open();
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    await waitFor(() => expect(api.exportPdf).toHaveBeenCalled());
    expect(useUi.getState().exportCopyOpen).toBe(true);
    expect(useUi.getState().toast).toBeNull();
  });

  it('enables Save again after Save As is cancelled', async () => {
    api.exportPdf.mockResolvedValue(null);
    const { user } = open();
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    await waitFor(() => expect(api.exportPdf).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save copy…' }).getAttribute('aria-disabled')).not.toBe('true'),
    );
  });

  it('cancels the running job on Escape', async () => {
    api.exportPdf.mockResolvedValue(7);
    const { user } = open();
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    await waitFor(() => expect(api.exportPdf).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Exporting…' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(cancelJob).toHaveBeenCalledWith(7));
    expect(useUi.getState().exportCopyOpen).toBe(true);
  });

  it('gives each option its own hint id', () => {
    open();
    const ids = ['Keep', 'Flatten', 'Remove'].map((name) =>
      screen.getByRole('radio', { name }).getAttribute('aria-describedby'),
    );
    expect(new Set(ids).size).toBe(3);
    const current = ids[0] ?? '';
    expect(document.getElementById(current)?.textContent).toBe('Comments and markup stay editable in the copy.');
  });

  it('disables the options without the edit permission and explains why', async () => {
    api.exportPdf.mockImplementation(reports(done()));
    const { user } = open(doc({ flags: { ...flags, permissions: ['print', 'copy'] } }));
    expect(screen.getByRole('radio', { name: 'Flatten' }).hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/permissions don't allow this/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    await waitFor(() => expect(api.exportPdf).toHaveBeenCalled());
    expect(api.exportPdf.mock.calls[0]?.[1]).toEqual({ annotations: 'keep', removeMetadata: false });
  });

  it('asks before rewriting a protected file and retries with the acknowledgement', async () => {
    api.exportPdf.mockRejectedValueOnce({ code: 'needs_confirmation', params: { what: 'rewriteEncrypted' } });
    api.exportPdf.mockImplementationOnce(reports(done()));
    const { user } = open(doc({ flags: { ...flags, encrypted: true } }));
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    expect(await screen.findByText('Copy a protected file?')).toBeTruthy();
    expect(api.exportPdf).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(useUi.getState().exportCopyOpen).toBe(false));
    expect(api.exportPdf.mock.calls.at(-1)?.[2]).toEqual({ rewriteEncrypted: true });
  });

  it('goes back from the confirmation without exporting', async () => {
    api.exportPdf.mockRejectedValueOnce({ code: 'needs_confirmation', params: { what: 'rewriteEncrypted' } });
    const { user } = open(doc({ flags: { ...flags, encrypted: true } }));
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Save copy…' })).toBeTruthy();
    expect(api.exportPdf).toHaveBeenCalledTimes(1);
  });

  it('shows the warning of the job and closes on Done', async () => {
    api.exportPdf.mockImplementation(reports(done(['signaturesRemoved'])));
    const { user } = open(doc({ flags: { ...flags, signed: true } }));
    await user.click(screen.getByRole('button', { name: 'Save copy…' }));
    expect(await screen.findByText('The digital signatures were removed from the copy.')).toBeTruthy();
    expect(useUi.getState().toast?.message).toBe('Copy saved');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(useUi.getState().exportCopyOpen).toBe(false);
  });

  it('closes on Escape', async () => {
    const { user } = open();
    await user.keyboard('{Escape}');
    await act(async () => undefined);
    expect(useUi.getState().exportCopyOpen).toBe(false);
  });
});
