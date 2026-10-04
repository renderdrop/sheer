import { describe, expect, it } from 'vitest';

import { NO_DOCUMENT } from '../../actions/state';
import { translators } from '../../i18n';
import { zoomEntries } from './entries';

const t = translators.en;
const ctx = { t, platform: 'windows' as const, state: { ...NO_DOCUMENT, hasDocument: true } };

describe('top bar menus', () => {
  it('checks the current scroll mode and disables commands without a document', () => {
    const entries = zoomEntries(ctx, 'single');
    expect(entries.find((entry) => entry.id === 'scroll-single')).toMatchObject({ checked: true });
    expect(entries.find((entry) => entry.id === 'scroll-spread')).toMatchObject({ checked: false });
    const empty = zoomEntries({ ...ctx, state: NO_DOCUMENT }, 'continuous');
    expect(empty.find((entry) => entry.id === 'zoom-in')).toMatchObject({ disabled: true });
  });
});
