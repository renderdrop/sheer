// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../../test/render';
import { SignatureSheetHost, openSignatureSheet } from '.';
import { canCreate, initialsOf, MOUSE_PRESSURE, pathData, samplePressure, typePrefill } from './model';

const lib = vi.hoisted(() => ({ listSignatures: vi.fn() }));
const sig = vi.hoisted(() => ({
  createDrawnSignature: vi.fn(),
  createTypedSignature: vi.fn(),
  importSignatureImage: vi.fn(),
  saveDraftSignature: vi.fn(),
  getSignaturePreview: vi.fn(),
}));

vi.mock('../../../api/library', async (original) => ({ ...(await original<object>()), ...lib }));
vi.mock('../../../api/signatures', async (original) => ({ ...(await original<object>()), ...sig }));

MotionGlobalConfig.skipAnimations = true;

const art = {
  type: 'vector' as const,
  w: 1000,
  h: 1000,
  paths: [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
  ],
};

describe('model', () => {
  it('a mouse draws a constant 2 px, a pen reports its pressure', () => {
    expect(samplePressure('mouse', 0.9)).toBe(MOUSE_PRESSURE);
    expect(samplePressure('pen', 0.8)).toBe(0.8);
    expect(samplePressure('pen', 0)).toBe(MOUSE_PRESSURE);
    expect(samplePressure('pen', 3)).toBe(1);
  });
  it('builds a closed path per polygon', () => {
    expect(
      pathData([
        [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        [],
      ]),
    ).toBe('M1 2L3 4Z');
  });
  it('initials are the first letters of the words', () => {
    expect(initialsOf('ada lovelace')).toBe('AL');
    expect(typePrefill('initials', 'Grace Brewster Hopper')).toBe('GBH');
    expect(typePrefill('signature', '  Ada ')).toBe('Ada');
  });
  it('create needs something on the active tab and no running create', () => {
    const base = { tab: 'draw', strokes: 0, typed: false, image: false, busy: false } as const;
    expect(canCreate(base)).toBe(false);
    expect(canCreate({ ...base, strokes: 1 })).toBe(true);
    expect(canCreate({ ...base, tab: 'type', typed: true })).toBe(true);
    expect(canCreate({ ...base, tab: 'image', image: true, busy: true })).toBe(false);
  });
});

beforeEach(() => {
  for (const fn of [...Object.values(lib), ...Object.values(sig)]) fn.mockReset();
  lib.listSignatures.mockResolvedValue({ status: 'ready', items: [] });
  sig.createTypedSignature.mockResolvedValue({ id: 7, role: 'signature', art });
  window.localStorage.clear();
});

describe('signature sheet', () => {
  it('focuses the Type tab first, and creates a library reference', async () => {
    sig.saveDraftSignature.mockResolvedValue({ id: 'a'.repeat(32) });
    const { user } = setup(<SignatureSheetHost />);
    let result: unknown = 'pending';
    act(() => {
      void openSignatureSheet('signature').then((ref) => {
        result = ref;
      });
    });
    const tab = await screen.findByRole('tab', { name: 'Type' });
    await waitFor(() => expect(document.activeElement).toBe(tab));
    await user.type(screen.getByRole('textbox'), 'Ada');
    await waitFor(() => expect(sig.createTypedSignature).toHaveBeenLastCalledWith('signature', 'Ada'));
    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(create.getAttribute('aria-disabled')).toBeNull());
    await user.click(create);
    await waitFor(() => expect(result).toEqual({ type: 'library', id: 'a'.repeat(32) }));
    expect(sig.saveDraftSignature).toHaveBeenCalledWith(7, 'Ada');
  });

  it('without a keychain the save box is disabled with a note and a draft comes back', async () => {
    lib.listSignatures.mockResolvedValue({ status: 'unavailable', items: [] });
    const { user } = setup(<SignatureSheetHost />);
    let result: unknown = 'pending';
    act(() => {
      void openSignatureSheet('signature').then((ref) => {
        result = ref;
      });
    });
    await user.type(await screen.findByRole('textbox'), 'Ada');
    expect(await screen.findByText('Not available: no system keychain.')).toBeTruthy();
    const box = screen.getByRole('checkbox');
    expect(box.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(sig.createTypedSignature).toHaveBeenCalled());
    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(create.getAttribute('aria-disabled')).toBeNull());
    await user.click(create);
    await waitFor(() => expect(result).toEqual({ type: 'draft', id: 7 }));
    expect(sig.saveDraftSignature).not.toHaveBeenCalled();
  });

  it('Cancel resolves with null', async () => {
    const { user } = setup(<SignatureSheetHost />);
    let result: unknown = 'pending';
    act(() => {
      void openSignatureSheet('initials').then((ref) => {
        result = ref;
      });
    });
    expect(await screen.findByRole('heading', { name: 'Create initials' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(result).toBeNull());
  });

  it('the Image tab imports through the dialog and shows an error for a bad image', async () => {
    window.localStorage.setItem('sheer.signatureTab', 'image');
    sig.importSignatureImage.mockRejectedValue(new Error('x'));
    const { user } = setup(<SignatureSheetHost />);
    act(() => {
      void openSignatureSheet('signature');
    });
    await user.click(await screen.findByRole('button', { name: 'Choose image…' }));
    expect(await screen.findByText('Use a PNG or JPEG under 10 MB.')).toBeTruthy();
    expect(sig.importSignatureImage).toHaveBeenCalledWith('signature', false);
  });
});
