// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useGoToPage } from '../topbar/goToState';
import { parseZoomInput, StatusBar } from './StatusBar';

const viewer = vi.hoisted(() => ({
  goToPage: vi.fn(),
  setZoom: vi.fn(),
  fitWidth: vi.fn(),
  fitPage: vi.fn(),
  zoomStep: vi.fn(),
  resetZoom: vi.fn(),
}));
vi.mock('../save/commands', () => ({ saveNow: vi.fn(), saveActive: vi.fn(), needsSavePrompt: () => false }));
vi.mock('../viewer/useViewer', () => ({
  useViewer: Object.assign((select: (state: unknown) => unknown) => select({ ...viewer, rendering: false }), {
    getState: () => ({ ...viewer, rendering: false }),
  }),
}));

const bar = () => within(document.querySelector<HTMLElement>('[data-slot="statusbar"]') as HTMLElement);

beforeEach(() => {
  resetDocuments();
  useView.setState({ byDoc: {} });
  usePages.setState({ slotsByDoc: {} });
  useUi.getState().setView('editor');
  Object.values(viewer).forEach((mock) => mock.mockReset());
  useDocuments.getState().add({ id: 1, pageCount: 12, displayName: 'Report.pdf' });
  useView.getState().open(1, 12);
});

describe('parseZoomInput', () => {
  it('reads a percentage with or without the sign, a comma or spaces, and refuses the rest', () => {
    expect(parseZoomInput('125')).toBe(1.25);
    expect(parseZoomInput('125 %')).toBe(1.25);
    expect(parseZoomInput('62,5%')).toBe(0.625);
    expect(parseZoomInput('abc')).toBeNull();
    expect(parseZoomInput('')).toBeNull();
    expect(parseZoomInput('0')).toBeNull();
  });
});

describe('the status bar (DESIGN 3.18 E7)', () => {
  it('is a toolbar named Status bar, 30 high, with the save status at the left', () => {
    setup(<StatusBar />);
    const footer = screen.getByRole('toolbar', { name: 'Status bar' });
    expect(footer.tagName).toBe('DIV');
    expect(footer.className).toContain('h-statusbar');
    expect(footer.getAttribute('data-slot')).toBe('statusbar');
    expect(footer.querySelector('[data-save-status]')).not.toBeNull();
  });

  it('the page field goes to the typed page, refuses a wrong one, and the go-to-page action focuses it', async () => {
    const { user } = setup(<StatusBar />);
    const field = bar().getByRole('textbox', { name: 'Go to page' }) as HTMLInputElement;
    expect(field.value).toBe('1');
    expect(field.parentElement?.textContent).toContain('/ 12');
    expect(field.getAttribute('data-tour-anchor')).toBe('topbar-page-field');
    await user.click(field);
    await user.keyboard('{Control>}a{/Control}13{Enter}');
    expect(viewer.goToPage).not.toHaveBeenCalled();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await user.keyboard('{Control>}a{/Control}5{Enter}');
    expect(viewer.goToPage).toHaveBeenCalledWith(4);
    field.blur();
    act(() => useGoToPage.getState().setOpen(true));
    expect(document.activeElement).toBe(field);
  });

  it('previous and next go one page and are disabled at the ends', async () => {
    const { user } = setup(<StatusBar />);
    expect(bar().getByRole('button', { name: 'Previous page' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(bar().getByRole('button', { name: 'Next page' }));
    expect(viewer.goToPage).toHaveBeenCalledWith(1);
  });

  it('the zoom field shows the zoom, Enter applies a typed percentage and Esc reverts', async () => {
    const { user } = setup(<StatusBar />);
    const field = bar().getByRole('textbox', { name: 'Zoom' }) as HTMLInputElement;
    expect(field.value).toMatch(/^100\s%$/);
    await user.click(field);
    await user.keyboard('150{Enter}');
    expect(viewer.setZoom).toHaveBeenCalledWith(1.5);
    await user.click(field);
    await user.keyboard('zz{Enter}');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(viewer.setZoom).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(field.value).toMatch(/^100\s%$/);
  });

  it('the fit buttons call the fits and the active fit is pressed', async () => {
    const { user } = setup(<StatusBar />);
    const width = bar().getByRole('button', { name: 'Page width' });
    expect(width.getAttribute('aria-pressed')).toBe('false');
    await user.click(width);
    expect(viewer.fitWidth).toHaveBeenCalled();
    act(() => useView.getState().setFit(1, 'page', 1, null));
    expect(bar().getByRole('button', { name: 'Whole page' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('zoom and fits are disabled in Seiten mode', () => {
    useUi.setState({ mode: 'pages' });
    setup(<StatusBar />);
    expect((bar().getByRole('textbox', { name: 'Zoom' }) as HTMLInputElement).disabled).toBe(true);
    expect(bar().getByRole('button', { name: 'Page width' }).getAttribute('aria-disabled')).toBe('true');
  });
});
