// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { isSignatureLocked, useSignatureLock } from './useSignatureLock';

function put(id: number, signatureLock?: 'none' | 'fillAndSign' | 'annotateFillAndSign' | 'locked'): void {
  useDocuments.setState((state) => ({
    byId: {
      ...state.byId,
      [id]: { id, pageCount: 1, displayName: 'a.pdf', ...(signatureLock ? { signatureLock } : {}) },
    },
  }));
}

describe('signature lock', () => {
  beforeEach(() => useDocuments.setState({ byId: {} }));

  it('is locked only for the locked level', () => {
    put(1, 'locked');
    put(2, 'none');
    put(3, 'annotateFillAndSign');
    put(4);
    expect([1, 2, 3, 4, 9].map((id) => isSignatureLocked(id))).toEqual([true, false, false, false, false]);
    expect(isSignatureLocked(null)).toBe(false);
  });

  it('gives the hook a reason while locked', () => {
    put(1, 'locked');
    expect(renderHook(() => useSignatureLock(1)).result.current).toEqual({ locked: true, reason: 'cert.locked.tool' });
    expect(renderHook(() => useSignatureLock(undefined)).result.current).toEqual({ locked: false });
  });
});
