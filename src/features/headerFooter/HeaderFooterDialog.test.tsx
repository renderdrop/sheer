// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HeaderFooterInfo, HfSpec } from '../../api/headerFooter';
import type { PageSlotInfo } from '../../api/pages';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { HeaderFooterDialog } from './HeaderFooterDialog';
import { openHeaderFooterDialog } from './runtime';
import { useHeaderFooter } from './store';

const api = vi.hoisted(() => ({ getHeaderFooter: vi.fn(), resolveHeaderFooter: vi.fn() }));
vi.mock('../../api/headerFooter', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock('../../api/render', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderPage: vi.fn().mockRejectedValue(new Error('no backend')),
}));

MotionGlobalConfig.skipAnimations = true;

const slots: PageSlotInfo[] = [10, 11, 12, 13, 14].map((id) => ({
  id,
  width: 612,
  height: 792,
  rotation: 0,
  rev: 0,
  label: null,
  origin: 'file',
}));
const DEFAULTS: HfSpec = {
  slots: {
    headerLeft: '',
    headerCenter: '',
    headerRight: '',
    footerLeft: '{date}',
    footerCenter: '',
    footerRight: '{page}',
  },
  pages: { type: 'all' },
  fontSize: 9,
  margin: 28,
  color: [15, 15, 15],
  date: '',
};
const info = (patch: Partial<HeaderFooterInfo> = {}): HeaderFooterInfo => ({
  spec: null,
  defaults: DEFAULTS,
  pending: false,
  fileLayers: 0,
  refusal: null,
  ...patch,
});

const applyCommand = vi.fn();

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 5, displayName: 'A.pdf' });
  usePages.getState().setSlots(1, slots);
  api.getHeaderFooter.mockReset();
  api.resolveHeaderFooter.mockReset().mockResolvedValue([]);
  applyCommand
    .mockReset()
    .mockResolvedValue({ rev: 1, upserted: [], removed: [], pages: null, doc: ['headerFooter'], history: null });
  useAnnotations.setState({ apply: applyCommand } as never);
  useHeaderFooter.setState({ dialog: null, busy: {} });
  useUi.setState({ toast: null });
});

describe('the dialog', () => {
  it('opens on the footer-right trigger with the defaults and applies them as one command', async () => {
    useHeaderFooter.getState().openDialog({ docId: 1, info: info(), preselect: null });
    const { user } = setup(<HeaderFooterDialog />);
    const right = await screen.findByRole('button', { name: 'Footer, Right' });
    await waitFor(() => expect(document.activeElement).toBe(right));
    expect(right.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Footer, Left' }).textContent).toBe('Date');
    expect(right.textContent).toBe('Page number');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(applyCommand).toHaveBeenCalledTimes(1));
    const command = applyCommand.mock.calls[0]?.[1] as { type: string; spec: HfSpec };
    expect(command.type).toBe('setHeaderFooter');
    expect(command.spec.slots.footerRight).toBe('Page {page} of {total}');
    expect(command.spec.fontSize).toBe(10);
    expect(command.spec.margin).toBe(24);
    await waitFor(() => expect(useHeaderFooter.getState().dialog).toBeNull());
    expect(useUi.getState().toast?.message).toBe('Headers and footers added to 5 pages');
  });

  it('disables Apply with a danger caption for an invalid range', async () => {
    useHeaderFooter.getState().openDialog({ docId: 1, info: info(), preselect: { first: 2, last: 3 } });
    const { user } = setup(<HeaderFooterDialog />);
    const from = await screen.findByRole('textbox', { name: 'From' });
    expect((from as HTMLInputElement).value).toBe('2');
    expect((screen.getByRole('textbox', { name: 'To' }) as HTMLInputElement).value).toBe('3');
    await user.clear(from);
    await user.type(from, '9');
    expect(screen.getByRole('alert').textContent).toBe('Enter pages from 1 to 5.');
    expect(screen.getByRole('button', { name: 'Apply' }).getAttribute('aria-disabled')).toBe('true');
  });

  it("loads the file's settings, says so, and Remove stages null", async () => {
    const spec: HfSpec = { ...DEFAULTS, slots: { ...DEFAULTS.slots, headerCenter: 'Draft' }, fontSize: 11 };
    useHeaderFooter.getState().openDialog({ docId: 1, info: info({ spec, fileLayers: 5 }), preselect: null });
    const { user } = setup(<HeaderFooterDialog />);
    expect(await screen.findByText(/Applying replaces them/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Header, Centre' }).textContent).toBe('Text');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(applyCommand).toHaveBeenCalledTimes(1));
    expect(applyCommand.mock.calls[0]?.[1]).toEqual({ type: 'setHeaderFooter', spec: null });
    await waitFor(() => expect(useUi.getState().toast?.message).toBe('Headers and footers removed'));
  });
});

describe('opening', () => {
  it('refuses a signed file with its toast and does not open', async () => {
    api.getHeaderFooter.mockResolvedValue(info({ refusal: 'signed' }));
    await openHeaderFooterDialog();
    expect(useHeaderFooter.getState().dialog).toBeNull();
    expect(useUi.getState().toast?.message).toMatch(/This file is signed/);
  });

  it('opens with what the backend answered', async () => {
    api.getHeaderFooter.mockResolvedValue(info());
    await openHeaderFooterDialog();
    expect(useHeaderFooter.getState().dialog?.docId).toBe(1);
  });
});
