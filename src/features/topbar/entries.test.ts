import { describe, expect, it } from 'vitest';

import { NO_DOCUMENT } from '../../actions/state';
import { translators } from '../../i18n';
import { exportEntries, moreEntries, zoomEntries } from './entries';

const t = translators.en;
const ctx = { t, platform: 'windows' as const, state: { ...NO_DOCUMENT, hasDocument: true } };
const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

describe('top bar menus', () => {
  it('lists the export commands', () => {
    expect(ids(exportEntries(ctx))).toEqual(['export-copy', 'export-images', 'compress-document']);
  });

  it('lists the More commands with Save As after the separator', () => {
    const entries = moreEntries(ctx);
    expect(ids(entries).slice(0, 5)).toEqual(['document-properties', 'protect', 'flatten-form', 'print', 'more-sep-1']);
    expect(ids(entries)).toContain('welcome-tour');
  });

  it('checks the current scroll mode and disables commands without a document', () => {
    const entries = zoomEntries(ctx, 'single');
    expect(entries.find((entry) => entry.id === 'scroll-single')).toMatchObject({ checked: true });
    expect(entries.find((entry) => entry.id === 'scroll-spread')).toMatchObject({ checked: false });
    const empty = zoomEntries({ ...ctx, state: NO_DOCUMENT }, 'continuous');
    expect(empty.find((entry) => entry.id === 'zoom-in')).toMatchObject({ disabled: true });
  });
});
