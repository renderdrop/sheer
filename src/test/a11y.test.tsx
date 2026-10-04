// @vitest-environment jsdom
import axe from 'axe-core';
import { act, screen } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../api/documents';
import { openAbout, useAboutDialog } from '../features/about/state';
import { RecoveryBanner } from '../features/recovery/RecoveryBanner';
import { useRecovery } from '../features/recovery/store';
import { useSave } from '../features/save/state';
import { useUpdate } from '../features/update/store';
import { UpdateBannerRow } from '../features/update/UpdateBanner';
import { PasswordDialog } from '../features/password/PasswordDialog';
import { requestPassword, usePassword } from '../features/password/state';
import { Shell } from '../features/shell/Shell';
import { useViewer } from '../features/viewer/useViewer';
import { resetViewer } from '../features/viewer/viewer.testutil';
import { opened } from '../stores/documents.testutil';
import { useSettings } from '../stores/settings';
import { useUi } from '../stores/ui';
import { setup } from './render';

/**
 * Automated accessibility rules (DESIGN 3.52) on the main surfaces. jsdom has no layout or paint, so the rules that need
 * them (contrast, target size, region) are off here; contrast is verified by the token tests and DESIGN section 4.
 */
const documentsApi = vi.hoisted(() => ({
  openDocumentDialog: vi.fn(),
  closeDocument: vi.fn(),
  unlockDocument: vi.fn(),
  MAX_PASSWORD_BYTES: 1024,
}));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
const windowApi = vi.hoisted(() => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isWindowMaximized: vi.fn(),
  isWindowFullscreen: vi.fn(),
}));

const recentsApi = vi.hoisted(() => ({
  listRecents: vi.fn(),
  getRecentThumbnail: vi.fn(),
  setMenuState: vi.fn(),
  openRecent: vi.fn(),
  removeRecent: vi.fn(),
  restoreRecent: vi.fn(),
  locateRecent: vi.fn(),
}));
const recoveryApi = vi.hoisted(() => ({ listRecoveries: vi.fn(), restoreRecovery: vi.fn(), discardRecovery: vi.fn() }));

vi.mock('../api/recents', () => recentsApi);
vi.mock('../api/recovery', () => recoveryApi);
vi.mock('../api/documents', () => documentsApi);
vi.mock('../api/render', () => renderApi);
vi.mock('../api/window', () => windowApi);

MotionGlobalConfig.skipAnimations = true;

const uiInitial = useUi.getState();
const settingsInitial = useSettings.getState();
const REPORT: DocumentInfo = { id: 1, pageCount: 3, displayName: 'Report.pdf' };

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useViewer.setState({ viewport: { width: 900, height: 700 } });
  useSettings.setState({ ...settingsInitial, platform: null }, true);
  usePassword.setState({ queue: [] });
  recentsApi.listRecents.mockReset().mockResolvedValue([]);
  recentsApi.getRecentThumbnail.mockReset().mockResolvedValue({ data: new Uint8Array([1]), width: 60, height: 80 });
  recentsApi.setMenuState.mockReset().mockResolvedValue(undefined);
  recoveryApi.listRecoveries.mockReset().mockResolvedValue([]);
  documentsApi.openDocumentDialog.mockReset().mockResolvedValue([opened(REPORT)]);
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  renderApi.renderPage.mockReset().mockResolvedValue({ data: new Uint8Array([1]), width: 816, height: 1056 });
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  for (const mock of Object.values(windowApi)) mock.mockReset().mockResolvedValue(false);
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(window, 'innerWidth', { value: 1100, configurable: true, writable: true });
});

afterEach(() => {
  useUi.setState({ ...uiInitial }, true);
  resetViewer();
  useSettings.setState(settingsInitial, true);
});

async function violations(root: Element) {
  const result = await axe.run(root, {
    rules: {
      'color-contrast': { enabled: false },
      'target-size': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

describe('axe rules on the main surfaces (DESIGN 3.52)', () => {
  it('the empty state shell has no violations', async () => {
    const { container } = setup(<Shell />);
    expect(await violations(container)).toEqual([]);
  });

  it('the document view shell has no violations', async () => {
    const { user, container } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    expect(await violations(container)).toEqual([]);
  });

  it('a dialog has no violations', async () => {
    setup(<PasswordDialog />);
    act(() => requestPassword(4, 'Secret.pdf'));
    const dialog = await screen.findByRole('dialog');
    expect(await violations(dialog)).toEqual([]);
  });

  it('the About dialog has no violations', async () => {
    setup(<Shell />);
    act(() => openAbout());
    const dialog = await screen.findByRole('dialog');
    expect(await violations(dialog)).toEqual([]);
    act(() => useAboutDialog.getState().setOpen(false));
  });

  it('the unsaved-changes dialog has no violations', async () => {
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('img', { name: /^Page 1 of/ });
    act(() => useSave.getState().setPrompt(1));
    const dialog = await screen.findByRole('dialog');
    expect(await violations(dialog)).toEqual([]);
    act(() => useSave.getState().setPrompt(null));
  });

  it('the recents list, with a preview, has no violations and every control is named', async () => {
    recentsApi.listRecents.mockResolvedValue([
      { id: 1, displayName: 'First.pdf', folder: 'Reports', lastOpened: 1, missing: false },
      { id: 2, displayName: 'Gone.pdf', folder: '', lastOpened: 1, missing: true },
    ]);
    const { container } = setup(<Shell />);
    await screen.findByText('First.pdf');
    expect(screen.getAllByRole('button', { name: /First.pdf/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Gone.pdf/ })).toHaveLength(3);
    expect(await violations(container)).toEqual([]);
  });

  it('the error, recovery and update banners have no violations', async () => {
    recoveryApi.listRecoveries.mockResolvedValue([
      { id: 1, displayName: 'doc.pdf', savedAt: '2026-10-01T10:00:00Z', pageCount: 2, original: 'unchanged' },
    ]);
    useRecovery.setState({ entries: [], hidden: false, busy: [], failed: [] });
    useUpdate.setState({ info: { version: '1.2.0', date: null, notes: 'Fixes' }, phase: 'available', hidden: false });
    const { container } = setup(
      <div>
        <RecoveryBanner />
        <UpdateBannerRow />
      </div>,
    );
    await screen.findByRole('group');
    expect(await violations(container)).toEqual([]);
    act(() => useUpdate.setState({ info: null }));
  });
});
