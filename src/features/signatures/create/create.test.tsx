// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../../../test/render';
import { SignatureSheetHost, lastSignatureColour, openSignatureSheet } from '.';
import { signatureDraft } from '../place/drafts';
import { migrateInk, rememberSignatureColour } from './store';
import { canCreate, initialsOf, MOUSE_PRESSURE, pathData, samplePressure, typePrefill } from './model';

const lib = vi.hoisted(() => ({ listSignatures: vi.fn() }));
const sig = vi.hoisted(() => ({
  createDrawnSignature: vi.fn(),
  createTypedSignature: vi.fn(),
  importSignatureImage: vi.fn(),
  saveDraftSignature: vi.fn(),
  discardSignatureDraft: vi.fn(),
  getSignaturePreview: vi.fn(),
}));

vi.mock('../../../api/library', async (original) => ({ ...(await original<object>()), ...lib }));
vi.mock('../../../api/signatures', async (original) => ({ ...(await original<object>()), ...sig }));

MotionGlobalConfig.skipAnimations = true;

const art = {
  type: 'vector' as const,
  w: 1000,
  h: 1000,
  paths: [[['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['Z']]],
};

describe('model', () => {
  it('a mouse draws a constant 2 px, a pen reports its pressure', () => {
    expect(samplePressure('mouse', 0.9)).toBe(MOUSE_PRESSURE);
    expect(samplePressure('pen', 0.8)).toBe(0.8);
    expect(samplePressure('pen', 0)).toBe(MOUSE_PRESSURE);
    expect(samplePressure('pen', 3)).toBe(1);
  });
  it('builds a closed path per polygon', () => {
    expect(pathData([[['M', 1, 2], ['C', 1, 2, 3, 4, 5, 6], ['Z']]])).toBe('M1 2C1 2 3 4 5 6Z');
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

describe('typed font picker', () => {
  it('previews all three fonts, remembers the chosen one and makes the draft of that font', async () => {
    lib.listSignatures.mockResolvedValue({ status: 'unavailable', items: [] });
    const { user } = setup(<SignatureSheetHost />);
    act(() => {
      void openSignatureSheet('signature');
    });
    await user.type(await screen.findByRole('textbox'), 'Ada');
    const group = await screen.findByRole('radiogroup', { name: 'Style' });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Dancing Script' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Great Vibes' }));
    expect(window.localStorage.getItem('signatureFont')).toBe('greatVibes');
    // Arrow keys move and select, wrapping.
    screen.getByRole('radio', { name: 'Great Vibes' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Alex Brush' }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Dancing Script' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Dancing Script' }));
  });

  it('starts with the font of last time, and a removed font falls back to the default', async () => {
    window.localStorage.setItem('signatureFont', 'homemadeApple');
    lib.listSignatures.mockResolvedValue({ status: 'unavailable', items: [] });
    setup(<SignatureSheetHost />);
    act(() => {
      void openSignatureSheet('signature');
    });
    expect((await screen.findByRole('radio', { name: 'Dancing Script' })).getAttribute('aria-checked')).toBe('true');
  });
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
    await waitFor(() =>
      expect(sig.createTypedSignature).toHaveBeenLastCalledWith('signature', 'Ada', expect.any(String)),
    );
    expect(sig.createTypedSignature).toHaveBeenCalledWith('signature', 'Ada', 'dancingScript');
    expect(sig.createTypedSignature).toHaveBeenCalledWith('signature', 'Ada', 'greatVibes');
    expect(sig.createTypedSignature).toHaveBeenCalledWith('signature', 'Ada', 'alexBrush');
    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(create.getAttribute('aria-disabled')).toBeNull());
    await user.click(create);
    await waitFor(() => expect(result).toEqual({ type: 'library', id: 'a'.repeat(32) }));
    expect(sig.saveDraftSignature).toHaveBeenCalledWith(7, 'Ada');
    // The draft was saved to the library and is not needed any more: it is freed when the sheet closes.
    await waitFor(() => expect(sig.discardSignatureDraft).toHaveBeenCalledWith(7));
  });

  it('a draft replaced while typing is discarded, and one handed out is kept', async () => {
    lib.listSignatures.mockResolvedValue({ status: 'unavailable', items: [] });
    // Dancing Script (the default font) is draft 1 for "A" and 2 for "Ab"; the other fonts' previews get ids from 10 up.
    let other = 10;
    sig.createTypedSignature.mockImplementation((_role: string, text: string, font: string) =>
      Promise.resolve({ id: font === 'dancingScript' ? text.length : ++other, role: 'signature', art }),
    );
    const { user } = setup(<SignatureSheetHost />);
    let result: unknown = 'pending';
    act(() => {
      void openSignatureSheet('signature').then((ref) => {
        result = ref;
      });
    });
    const field = await screen.findByRole('textbox');
    await user.type(field, 'A');
    await waitFor(() => expect(sig.createTypedSignature).toHaveBeenCalledWith('signature', 'A', 'dancingScript'));
    await user.type(field, 'b');
    await waitFor(() => expect(sig.discardSignatureDraft).toHaveBeenCalledWith(1));
    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(create.getAttribute('aria-disabled')).toBeNull());
    await user.click(create);
    await waitFor(() => expect(result).toEqual({ type: 'draft', id: 2 }));
    expect(sig.discardSignatureDraft).not.toHaveBeenCalledWith(2);
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

  it('an imported picture that is replaced, and the one left at close, are discarded', async () => {
    window.localStorage.setItem('sheer.signatureTab', 'image');
    sig.importSignatureImage
      .mockResolvedValueOnce({ id: 11, role: 'signature', art })
      .mockResolvedValueOnce({ id: 12, role: 'signature', art });
    const { user } = setup(<SignatureSheetHost />);
    act(() => {
      void openSignatureSheet('signature');
    });
    const choose = await screen.findByRole('button', { name: 'Choose image…' });
    await user.click(choose);
    await waitFor(() => expect(sig.importSignatureImage).toHaveBeenCalledTimes(1));
    await user.click(choose);
    await waitFor(() => expect(sig.discardSignatureDraft).toHaveBeenCalledWith(11));
    expect(sig.discardSignatureDraft).not.toHaveBeenCalledWith(12);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sig.discardSignatureDraft).toHaveBeenCalledWith(12));
  });

  it('a drawn draft whose saving failed is discarded', async () => {
    window.localStorage.setItem('sheer.signatureTab', 'draw');
    sig.createDrawnSignature.mockResolvedValue({ id: 21, role: 'signature', art });
    sig.saveDraftSignature.mockRejectedValue(new Error('x'));
    const { user } = setup(<SignatureSheetHost />);
    act(() => {
      void openSignatureSheet('signature');
    });
    const pad = await screen.findByRole('img', { name: 'Signature pad' });
    for (const [x, y] of [
      [10, 10],
      [40, 60],
      [90, 20],
    ] as const) {
      fireEvent.pointerMove(pad, { pointerId: 1, clientX: x, clientY: y });
      if (x === 10) fireEvent.pointerDown(pad, { pointerId: 1, button: 0, clientX: x, clientY: y });
    }
    fireEvent.pointerUp(pad, { pointerId: 1, clientX: 90, clientY: 20 });
    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(create.getAttribute('aria-disabled')).toBeNull());
    await user.click(create);
    await waitFor(() => expect(sig.discardSignatureDraft).toHaveBeenCalledWith(21));
  });

  it('passes the chosen ink on: the Signature blue swatch becomes the colour of the placed draft', async () => {
    window.localStorage.setItem('sheer.signatureTab', 'type');
    window.localStorage.removeItem('sheer.signatureInk');
    const { user } = setup(<SignatureSheetHost />);
    act(() => {
      void openSignatureSheet('signature');
    });
    expect((await screen.findByRole('radio', { name: 'Ink' })).getAttribute('aria-checked')).toBe('true');
    await user.type(screen.getByRole('textbox'), 'Ada');
    await user.click(screen.getByRole('radio', { name: 'Signature blue' }));
    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(create.getAttribute('aria-disabled')).toBeNull());
    await user.click(create);
    await waitFor(() => expect(lastSignatureColour()).toBe('signature'));
    expect(
      signatureDraft(0, { x: 0, y: 0, w: 1, h: 1 }, 'signature', { assetId: 1, aspect: 2 }, lastSignatureColour()),
    ).toMatchObject({
      color: [31, 58, 147],
    });
    rememberSignatureColour('ink');
  });

  it('migrates a stored ink that no longer exists to Ink', () => {
    expect(migrateInk('blue')).toBe('ink');
    expect(migrateInk('black')).toBe('ink');
    expect(migrateInk(null)).toBe('ink');
    expect(migrateInk('signature')).toBe('signature');
  });
});
