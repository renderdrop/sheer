import { beforeEach, describe, expect, it } from 'vitest';

import { useUi } from '../../../stores/ui';
import { reportRefusal } from './refusal';

describe('reportRefusal', () => {
  beforeEach(() => {
    useUi.setState({ toast: null, banner: null });
  });

  it('toasts a read-only refusal', () => {
    reportRefusal({ code: 'read_only', key: 'error.read_only', retryable: false });
    expect(useUi.getState().toast?.message).toMatch(/permissions/);
    expect(useUi.getState().banner).toBeNull();
  });

  it('shows any other refusal in the banner', () => {
    reportRefusal({ code: 'limit_exceeded', key: 'error.limit_exceeded', retryable: false });
    expect(useUi.getState().banner).not.toBeNull();
    expect(useUi.getState().toast).toBeNull();
  });
});
