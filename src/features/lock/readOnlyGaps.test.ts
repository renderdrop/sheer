import { beforeEach, describe, expect, it } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { isReadOnly } from '../organize/commands';

describe('page commands honour the signature lock', () => {
  beforeEach(() => {
    resetDocuments();
    useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf', signatureLock: 'locked' });
    useDocuments.getState().add({ id: 2, pageCount: 1, displayName: 'b.pdf', signatureLock: 'fillAndSign' });
  });
  it('treats a locked document as read-only, not an editable one', () => {
    expect(isReadOnly(1)).toBe(true);
    expect(isReadOnly(2)).toBe(false);
  });
});
