// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '../../../stores/ui';
import { useSignatureLibrary } from '../library/state';
import { rememberSignatureColour } from '../create/store';
import { useSignMenuEntries } from './menu';
import { placeItem } from './place';
import { usePlacement } from './store';
import { useAnnotations } from '../../../stores/annotations';

vi.mock('../../../api/library', async (original) => ({
  ...(await original<typeof import('../../../api/library')>()),
  listSignatures: () => Promise.resolve({ status: 'ready', items: [] }),
}));
vi.mock('../../../api/signatures', async (original) => ({
  ...(await original<typeof import('../../../api/signatures')>()),
  useSignature: () => Promise.resolve({ assetId: 3, aspect: 2, art: { type: 'vector', w: 2, h: 1, paths: [] } }),
}));

describe('Sign menu wiring', () => {
  beforeEach(() => {
    useUi.setState({ activeTool: 'select', toolLocked: false });
    usePlacement.getState().disarm();
  });

  it('has a Manage row that opens the library', () => {
    const { result } = renderHook(() => useSignMenuEntries());
    const manage = result.current.find((entry) => entry.type !== 'separator' && entry.id === 'manage');
    expect(manage).toBeDefined();
    if (manage !== undefined && manage.type !== 'separator') manage.onSelect?.();
    expect(useSignatureLibrary.getState().open).toBe(true);
  });

  it('is a hook with a stable entry order across renders (the toolbar calls it as one)', () => {
    const { result, rerender } = renderHook(() => useSignMenuEntries());
    const ids = () => result.current.map((entry) => entry.id);
    const first = ids();
    rerender();
    expect(ids()).toEqual(first);
    expect(first.slice(0, 3)).toEqual(['sec-sign', 'add-signature', 'add-initials']);
    expect(first).toContain('fill');
  });

  it('plugs create and place into the library; place arms the entry', () => {
    const { place, create } = useSignatureLibrary.getState().handlers;
    expect(create).toBeTypeOf('function');
    place?.({
      id: 'b'.repeat(32),
      role: 'initials',
      name: 'x',
      created: 0,
      aspect: 1.5,
      kind: 'vector',
      preview: null,
    });
    expect(useUi.getState().activeTool).toBe('signature');
    expect(usePlacement.getState().item).toMatchObject({ type: 'signature', role: 'initials', aspect: 1.5 });
  });

  it('places with the ink colour chosen in the sheet', async () => {
    const apply = vi.fn(() => Promise.resolve({ upserted: [], removed: [], rev: 1 }));
    useAnnotations.setState({ apply } as never);
    rememberSignatureColour('signature');
    await placeItem(
      1,
      0,
      { type: 'signature', role: 'signature', ref: { type: 'library', id: 'c'.repeat(32) }, aspect: 2 },
      { x: 50, y: 50 },
      [600, 800],
    );
    expect(apply).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ draft: expect.objectContaining({ color: [31, 58, 147] }) }),
    );
    rememberSignatureColour('ink');
  });
});
