// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useForms } from '../forms/store';
import { useBannerWinner, type BannerKind } from './bannerPriority';

const seen: BannerKind[] = [];
function Probe() {
  seen.push(useBannerWinner());
  return null;
}
const last = () => seen[seen.length - 1];

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf' });
  useForms.setState({ byDoc: {}, bannerDismissed: {} });
  useUi.setState({ redactMode: false });
});

describe('the banner priority', () => {
  it('is redact band, then form banner, then the other notices', () => {
    render(<Probe />);
    expect(last()).toBe('other');
    act(() =>
      useForms.setState({
        byDoc: { 1: { status: 'ready', fields: [{ id: 1 }] } as never },
      }),
    );
    expect(last()).toBe('form');
    act(() => useUi.getState().setRedactMode(true));
    expect(last()).toBe('redact');
    act(() => useUi.getState().setRedactMode(false));
    act(() => useForms.getState().dismissBanner(1));
    expect(last()).toBe('other');
  });
});
