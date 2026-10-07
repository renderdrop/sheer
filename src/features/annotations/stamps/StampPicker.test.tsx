// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLocaleStore } from '../../../i18n/store';
import { StampPickerBody } from './StampPicker';
import { FIRST_CHOICE } from './model';
import { useStamp } from './store';

const close = vi.fn();

beforeEach(() => {
  close.mockClear();
  useLocaleStore.setState({ locale: 'de' });
  useStamp.setState({ choice: FIRST_CHOICE, recent: [], pickerOpen: true, keyboard: false, changing: null });
});
afterEach(() => {
  cleanup();
  useLocaleStore.setState({ locale: 'en' });
});

describe('the stamp picker', () => {
  it('shows the four stamps in the UI language, upper case, Received with the date', () => {
    render(<StampPickerBody close={close} />);
    const tiles = within(screen.getByRole('radiogroup', { name: 'Stempel' })).getAllByRole('radio');
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([
      'ENTWURF',
      'GENEHMIGT',
      'VERTRAULICH',
      expect.stringMatching(/^ERHALTEN, \d{2}\.\d{2}\.\d{4}$/),
    ]);
    expect(tiles[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('writes the date the English way in English', () => {
    useLocaleStore.setState({ locale: 'en' });
    render(<StampPickerBody close={close} />);
    expect(screen.getByRole('radio', { name: /^RECEIVED, [A-Z][a-z]{2} \d{1,2}, \d{4}$/ })).toBeTruthy();
  });

  it('chooses a tile, closes and arms placement', () => {
    render(<StampPickerBody close={close} />);
    fireEvent.click(screen.getByRole('radio', { name: 'GENEHMIGT' }), { detail: 1 });
    expect(useStamp.getState().choice.stamp).toBe('approved');
    expect(useStamp.getState().keyboard).toBe(false);
    expect(close).toHaveBeenCalledWith('select');
  });

  it('a choice made with the keyboard starts the keyboard ghost', () => {
    render(<StampPickerBody close={close} />);
    fireEvent.click(screen.getByRole('radio', { name: 'VERTRAULICH' }), { detail: 0 });
    expect(useStamp.getState().keyboard).toBe(true);
  });

  it('moves between tiles with the arrows and keeps one tab stop', () => {
    render(<StampPickerBody close={close} />);
    const tiles = screen.getAllByRole('radio').filter((el) => el.hasAttribute('data-stamp-tile'));
    expect(tiles.filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
    tiles[0]?.focus();
    fireEvent.keyDown(tiles[0] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tiles[1]);
    fireEvent.keyDown(tiles[1] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tiles[3]);
    fireEvent.keyDown(tiles[3] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tiles[3]);
  });

  it('switches the colour without closing', () => {
    render(<StampPickerBody close={close} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Schwarz' }));
    expect(useStamp.getState().choice.tone).toBe('ink');
    expect(close).not.toHaveBeenCalled();
  });

  it('takes an own text on Enter, limited to 32 characters, with the date switch', () => {
    render(<StampPickerBody close={close} />);
    const field = screen.getByLabelText('Eigener Text') as HTMLInputElement;
    expect(field.maxLength).toBe(32);
    expect(field.placeholder).toBe('z. B. Bezahlt');
    fireEvent.click(screen.getByLabelText('Heutiges Datum hinzufügen'));
    fireEvent.change(field, { target: { value: 'Bezahlt' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(useStamp.getState().choice).toMatchObject({ stamp: 'custom', custom: 'Bezahlt', withDate: true });
    expect(useStamp.getState().keyboard).toBe(true);
    expect(close).toHaveBeenCalledWith('select');
  });

  it('does nothing on Enter in an empty field', () => {
    render(<StampPickerBody close={close} />);
    fireEvent.keyDown(screen.getByLabelText('Eigener Text'), { key: 'Enter' });
    expect(close).not.toHaveBeenCalled();
  });

  it('has no Recent list until an own text was placed', () => {
    render(<StampPickerBody close={close} />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('lists the recent texts, with a calendar for a dated one, and chooses one with Enter', () => {
    useStamp.setState({
      recent: [
        { text: 'Bezahlt', date: true },
        { text: 'Geprüft', date: false },
      ],
    });
    render(<StampPickerBody close={close} />);
    const rows = within(screen.getByRole('listbox', { name: 'Zuletzt' })).getAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual(['Bezahlt', 'Geprüft']);
    expect(rows[0]?.querySelector('svg')).not.toBeNull();
    expect(rows[1]?.querySelector('svg')).toBeNull();
    rows[0]?.focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Enter' });
    expect(useStamp.getState().choice).toMatchObject({ stamp: 'custom', custom: 'Geprüft', withDate: false });
    expect(close).toHaveBeenCalledWith('select');
  });

  it('names the surface for the gate', () => {
    const { container } = render(<StampPickerBody close={close} />);
    expect(container.querySelector('[data-surface="stamp-picker"]')).not.toBeNull();
  });
});
