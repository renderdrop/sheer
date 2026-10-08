// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyBibRecord } from '../../api/citations';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { invalidateBibliography } from './bibliography';
import { ReferenceButton } from './ReferencePopover';
import { STYLE_KEY, useCitationPrefs } from './style';

const api = vi.hoisted(() => ({ getBibliography: vi.fn(), listCitations: vi.fn(), saveCitationList: vi.fn() }));
vi.mock('../../api/citations', async (original) => ({
  ...(await original<typeof import('../../api/citations')>()),
  getBibliography: api.getBibliography,
  listCitations: api.listCitations,
  saveCitationList: api.saveCitationList,
}));

MotionGlobalConfig.skipAnimations = true;

const info = (over: object = {}) => ({
  record: {
    ...emptyBibRecord(),
    title: 'On quotations',
    year: '2020',
    authors: [{ family: 'Müller', given: 'Anna' }],
    ...over,
  },
  sources: {},
  pending: false,
  droppedByStrip: false,
});
const cite = (id: number) => ({
  id,
  pageId: 1,
  locator: String(id),
  quote: `Quote ${id}`,
  contents: '',
  tags: [],
  group: null,
  color: [220, 207, 255],
});

beforeEach(() => {
  invalidateBibliography(1);
  localStorage.clear();
  useCitationPrefs.setState({ style: undefined, format: 'txt' });
  useUi.setState({ toast: null, propsOpen: false });
  api.getBibliography.mockReset().mockResolvedValue(info());
  api.listCitations.mockReset().mockResolvedValue([cite(1), cite(2)]);
  api.saveCitationList.mockReset().mockResolvedValue(true);
});

const open = async (ui = <ReferenceButton docId={1} />) => {
  const view = setup(ui);
  await view.user.click(screen.getByRole('button', { name: 'Reference and citation list' }));
  return view;
};

describe('ReferenceButton', () => {
  it('shows the preview in the current style with the count', async () => {
    await open();
    await waitFor(() => expect(screen.getByText(/On quotations/)).toBeTruthy());
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Müller, A. (2020). On quotations.');
    await waitFor(() => expect(screen.getByText('2 citations')).toBeTruthy());
    expect(screen.queryByText('Some details are missing.')).toBeNull();
  });

  it('changes the style, stores it and updates the preview', async () => {
    const { user } = await open();
    await waitFor(() => expect(screen.getByText(/On quotations/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /APA 7/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'MLA 9' }));
    expect(localStorage.getItem(STYLE_KEY)).toBe('mla9');
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Müller, Anna. “On quotations.” 2020.'),
    );
  });

  it('warns about missing details', async () => {
    api.getBibliography.mockResolvedValue(info({ year: null }));
    await open();
    await waitFor(() => expect(screen.getByText('Some details are missing.')).toBeTruthy());
  });

  it('disables the list buttons without citations and says why', async () => {
    api.listCitations.mockResolvedValue([]);
    await open();
    await waitFor(() => expect(screen.getByText(/No citations yet/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Copy list' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Save list…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('lets the list buttons wrap instead of touching or clipping in a narrow panel', async () => {
    await open();
    const row = document.querySelector('[data-reference="list-actions"]') as HTMLElement;
    expect(row.className).toContain('flex-wrap');
    expect(row.className).toContain('gap-2');
    for (const name of ['Copy list', 'Save list…']) {
      const cls = screen.getByRole('button', { name }).className;
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).not.toContain('min-w-0');
    }
  });

  it('saves the list through the native dialog', async () => {
    const { user } = await open();
    await waitFor(() => expect(screen.getByText('2 citations')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Save list…' }));
    await waitFor(() => expect(api.saveCitationList).toHaveBeenCalled());
    expect(api.saveCitationList.mock.calls[0]?.[1]).toBe('txt');
  });

  it('Edit reference closes the popover and calls the handler', async () => {
    const onEditReference = vi.fn();
    const { user } = await open(<ReferenceButton docId={1} onEditReference={onEditReference} />);
    await user.click(screen.getByRole('button', { name: 'Edit reference…' }));
    expect(onEditReference).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit reference…' })).toBeNull());
  });

  it('opens Document properties by default', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Edit reference…' }));
    expect(useUi.getState().propsOpen).toBe(true);
  });

  it('Esc closes the popover and returns focus to the button', async () => {
    const { user } = await open();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit reference…' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reference and citation list' }));
  });
});

describe('the width while open', () => {
  it('follows the panel it opens from when that is resized', async () => {
    let notify: () => void = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    let panelWidth = 300;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const width = this.dataset.region === 'left' ? panelWidth : 0;
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    try {
      await open(
        <div data-region="left">
          <ReferenceButton docId={1} />
        </div>,
      );
      const surface = () => document.querySelector<HTMLElement>('[style*="max-width"]');
      await waitFor(() => expect(surface()?.style.maxWidth).toBe('284px'));
      panelWidth = 260;
      act(() => notify());
      await waitFor(() => expect(surface()?.style.maxWidth).toBe('244px'));
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
