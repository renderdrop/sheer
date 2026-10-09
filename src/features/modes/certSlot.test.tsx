// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SigningIdentityInfo } from '../../api/signing';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { useIdentities } from '../signatures/sign/identities';
import { useCertSign } from '../signatures/sign/store';
import { ModeRow, ToolRow, switchMode } from '.';

const openManager = vi.fn();
vi.mock('../signatures/certs/open', () => ({ openCertificateManager: (tab?: string) => openManager(tab) }));
vi.mock('../../api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/library')>()),
  listSignatures: vi.fn().mockResolvedValue({ status: 'ready', items: [] }),
}));
vi.mock('../../api/signing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/signing')>()),
  listSigningIdentities: vi.fn().mockImplementation(() => Promise.resolve({ status: 'ready', items: mockItems })),
}));

let mockItems: SigningIdentityInfo[] = [];

const name = (commonName: string) => ({ commonName, organization: null, email: null });
const identity = (
  id: string,
  commonName: string,
  expired = false,
  email: string | null = null,
): SigningIdentityInfo => ({
  id,
  subject: { ...name(commonName), email },
  issuer: name(commonName),
  selfSigned: true,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2029-01-01T00:00:00Z',
  serialHex: '01',
  fingerprintSha256: 'a'.repeat(64),
  source: 'generated',
  key: { type: 'ecP256' },
  chainLength: 1,
  expired,
});

const annotationsInitial = useAnnotations.getState();
const uiInitial = useUi.getState();

const Rows = () => (
  <>
    <ModeRow />
    <ToolRow />
  </>
);
const item = (label: string | RegExp) => within(screen.getByRole('toolbar')).getByRole('button', { name: label });

beforeEach(() => {
  useSettings.setState({ showToolLabels: true });
  mockItems = [];
  openManager.mockClear();
  useUi.setState({ ...uiInitial }, true);
  useAnnotations.setState({ ...annotationsInitial }, true);
  useIdentities.setState({ status: 'unknown', items: [] });
  useCertSign.getState().reset();
  resetDocuments();
  act(() => useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf' }));
  act(() => switchMode('fill'));
});

describe('the Zertifikat slot (DESIGN 3.8 S1)', () => {
  it('is the eighth, letter-less slot; without a certificate the menu offers "New certificate…" only', async () => {
    const { user } = setup(<Rows />);
    await waitFor(() => expect(useIdentities.getState().status).toBe('ready'));
    await user.click(item('Options for Certificate'));
    const menu = await screen.findByRole('menu');
    const entries = within(menu).getAllByRole('menuitem');
    expect(entries.map((entry) => entry.textContent)).toEqual(['New certificate…']);
    await user.click(entries[0] as HTMLElement);
    expect(openManager).toHaveBeenCalledWith('certificates');
  });

  it('the main part opens the manager when there is no certificate', async () => {
    const { user } = setup(<Rows />);
    await user.click(item('Certificate'));
    expect(openManager).toHaveBeenCalled();
    expect(useCertSign.getState().active).toBe(false);
  });

  it('lists the certificates, then New and Manage; choosing one turns the tool on with it', async () => {
    mockItems = [identity('1'.repeat(32), 'Ada', false, 'ada@example.org'), identity('2'.repeat(32), 'Bo', true)];
    const { user } = setup(<Rows />);
    await waitFor(() => expect(useIdentities.getState().items).toHaveLength(2));
    await user.click(item('Options for Certificate'));
    const menu = await screen.findByRole('menu');
    // L2: identities are radios (the check marks the active one, the email is the second line), the commands are plain items.
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((entry) => entry.textContent)).toEqual(['Adaada@example.org', 'Bo']);
    expect(radios.map((entry) => entry.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(within(radios[0] as HTMLElement).getByText('ada@example.org').className).toContain('text-text-muted');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((entry) => entry.textContent),
    ).toEqual(['New certificate…', 'Manage certificates…']);
    await user.click(within(menu).getByRole('menuitemradio', { name: /^Ada/ }));
    expect(useCertSign.getState()).toMatchObject({ active: true, identityId: '1'.repeat(32) });
    expect(useUi.getState().activeTool).toBe('signature');
    expect(item('Certificate').getAttribute('aria-pressed')).toBe('true');
  });

  it('is disabled with the reason while the document has unsaved changes', async () => {
    mockItems = [identity('1'.repeat(32), 'Ada')];
    useAnnotations.setState(
      (state) =>
        ({
          byDoc: { ...state.byDoc, 1: { ...(state.byDoc[1] ?? ({} as never)), history: { dirty: true } } },
        }) as never,
    );
    setup(<Rows />);
    await waitFor(() => expect(useIdentities.getState().items).toHaveLength(1));
    expect(item('Certificate').getAttribute('aria-disabled')).toBe('true');
  });

  it('every slot of the mode is disabled while a signature locks the document', async () => {
    act(() => useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'a.pdf', signatureLock: 'locked' }));
    setup(<Rows />);
    const buttons = within(screen.getByRole('toolbar'))
      .getAllByRole('button')
      .filter((button) => !(button.getAttribute('aria-label') ?? '').startsWith('Options'));
    expect(buttons.length).toBeGreaterThanOrEqual(8);
    for (const button of buttons) expect(button.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the fit at 960 x 640', () => {
  it('keeps the eight tools of Ausfüllen & Signieren icon-only at step 2, without Mehr', () => {
    window.innerWidth = 1440; // wide: the fit is measured, not forced by the window
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute('role') !== 'toolbar') return 0;
        let total = 0;
        for (const child of Array.from(this.children)) total += child.querySelector('[data-label]') === null ? 36 : 120;
        return total;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'toolbar' ? 8 * 36 + 120 : 0;
      },
    });
    try {
      setup(<Rows />);
      expect(screen.getByRole('toolbar').getAttribute('data-fit')).toBe('2');
      expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
      expect(item('Certificate').getAttribute('aria-label')).toBe('Certificate');
    } finally {
      if (scroll !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
      if (client !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    }
  });
});
