// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { BannerSlot, MAX_NOTICES, queuedCount } from './BannerSlot';

const uiInitial = useUi.getState();

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf' });
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetDocuments();
});

describe('queuedCount', () => {
  it('counts every notice behind a higher banner and only the ones past the cap otherwise', () => {
    expect(queuedCount(3, 'redact')).toBe(3);
    expect(queuedCount(1, 'form')).toBe(1);
    expect(queuedCount(MAX_NOTICES, 'other')).toBe(0);
    expect(queuedCount(MAX_NOTICES + 2, 'other')).toBe(2);
    expect(queuedCount(0, 'signature')).toBe(0);
  });
});

describe('the banner slot', () => {
  it('says so when a notice waits behind the redact band, and stays silent otherwise', async () => {
    setup(<BannerSlot />);
    expect(document.querySelector('[data-banner-queued]')).toBeNull();
    act(() => useUi.getState().showBanner({ code: 'internal', key: 'error.internal', retryable: false }));
    expect(document.querySelector('[data-banner-queued]')).toBeNull();
    act(() => useUi.getState().setRedactMode(true));
    expect(await screen.findByText('1 more notice waiting')).not.toBeNull();
  });
});
