// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { XfaBannerRow } from './Banner';

function info(id: number, xfa: boolean): DocumentInfo {
  return {
    id,
    pageCount: 1,
    displayName: `${id}.pdf`,
    kind: 'user',
    flags: { encrypted: false, xfa, hasForms: xfa, signed: false },
  };
}

afterEach(() => {
  resetDocuments();
  useUi.setState({ xfaDismissed: [] });
});

describe('the XFA warning (DESIGN 3.21)', () => {
  it('shows only for an XFA document, per document, and can be dismissed', async () => {
    setup(<XfaBannerRow />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => useDocuments.getState().add(info(1, true)));
    expect(screen.getByRole('status').textContent).toContain("can't show");
    act(() => useDocuments.getState().add(info(2, false)));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    act(() => useDocuments.getState().setActive(1));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    act(() => useDocuments.getState().add(info(3, true)));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('stays dismissed when the banner is mounted again', async () => {
    const first = setup(<XfaBannerRow />);
    act(() => useDocuments.getState().add(info(1, true)));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    first.unmount();
    setup(<XfaBannerRow />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(useUi.getState().xfaDismissed).toEqual([1]);
  });
});
