// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { DocumentInfo, SignatureLock } from '../../api/documents';
import { readActionState } from '../../actions/state';
import { useDocuments } from '../../stores/documents';
import { useActionState } from './useActionState';

function open(signatureLock: SignatureLock): void {
  const info: DocumentInfo = { id: 7, pageCount: 1, displayName: 'signed.pdf', signatureLock };
  useDocuments.setState({ byId: { 7: info }, order: [7], activeId: 7 });
}

afterEach(() => useDocuments.setState({ byId: {}, order: [], activeId: null }));

describe('useActionState and the signature lock (DESIGN 3.8 S5)', () => {
  it('carries the lock like readActionState, so the in-window menu and the shortcuts agree', () => {
    for (const lock of ['none', 'fillAndSign', 'annotateFillAndSign', 'locked'] as const) {
      open(lock);
      const { result, unmount } = renderHook(() => useActionState());
      const read = readActionState();
      expect(result.current.signatureLocked === true).toBe(lock === 'locked');
      expect(result.current.signed === true).toBe(lock !== 'none');
      expect(result.current.signatureLocked === true).toBe(read.signatureLocked === true);
      expect(result.current.signed === true).toBe(read.signed === true);
      unmount();
    }
  });
});
