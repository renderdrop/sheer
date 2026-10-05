// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { emptyBibRecord, type BibliographyInfo } from '../../api/citations';
import { setup } from '../../test/render';
import { ReferenceForm } from './ReferenceForm';
import { draftOf, invalidFields, recordOf, type RefDraft } from './referenceRules';

const info = (over: Partial<BibliographyInfo> = {}): BibliographyInfo => ({
  record: {
    ...emptyBibRecord(),
    kind: 'article',
    authors: [
      { family: 'Müller', given: 'Anna' },
      { family: 'Schmidt', given: 'Bo' },
    ],
    title: 'On things',
    year: '2021',
    containerTitle: 'Journal of Things',
  },
  sources: { title: 'xmp', year: 'info', authors: 'heuristic', containerTitle: 'xmp', kind: 'xmp' },
  pending: false,
  droppedByStrip: false,
  ...over,
});

const latest: { current: RefDraft | null } = { current: null };

function Harness({ value, readOnly = false }: { value: BibliographyInfo; readOnly?: boolean }) {
  const [draft, setDraft] = useState(() => draftOf(value.record));
  useEffect(() => {
    latest.current = draft;
  });
  return <ReferenceForm info={value} draft={draft} onChange={setDraft} readOnly={readOnly} />;
}

describe('ReferenceForm', () => {
  it('shows the fields of the type with their source captions', () => {
    setup(<Harness value={info()} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('On things');
    expect((screen.getByLabelText('Journal') as HTMLInputElement).value).toBe('Journal of Things');
    expect(screen.queryByLabelText('Volume')).not.toBeNull();
    expect(screen.queryByLabelText('Edition')).toBeNull();
    expect(screen.getAllByText('from the file').length).toBeGreaterThan(0);
    expect(screen.getAllByText('from page 1').length).toBeGreaterThan(0);
  });

  it('switches the visible fields with the type and keeps the hidden value until the record is made', async () => {
    const { user } = setup(<Harness value={info()} />);
    await user.type(screen.getByLabelText('Volume'), '7');
    await user.selectOptions(screen.getByLabelText('Type'), 'book');
    expect(screen.queryByLabelText('Edition')).not.toBeNull();
    expect(screen.queryByLabelText('Volume')).toBeNull();
    expect(latest.current !== null && recordOf(latest.current).volume).toBeNull();
    await user.selectOptions(screen.getByLabelText('Type'), 'article');
    expect((screen.getByLabelText('Volume') as HTMLInputElement).value).toBe('7');
  });

  it('marks an edited field and restores the file value', async () => {
    const { user } = setup(<Harness value={info()} />);
    const title = screen.getByLabelText('Title');
    await user.type(title, ' more');
    expect(screen.getAllByText('edited').length).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Use the value from the file' }));
    expect((title as HTMLInputElement).value).toBe('On things');
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('validates on blur and reports invalid fields', async () => {
    const { user } = setup(<Harness value={info()} />);
    const year = screen.getByLabelText('Year');
    await user.clear(year);
    await user.type(year, '21');
    await user.tab();
    expect(year.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use a 4-digit year.')).toBeTruthy();
    expect(latest.current !== null && invalidFields(latest.current)).toEqual(['year']);
    await user.clear(year);
    await user.type(year, '2022');
    await user.tab();
    expect(year.hasAttribute('aria-invalid')).toBe(false);
  });

  it('adds, removes and reorders authors (Alt+Down)', async () => {
    const { user } = setup(<Harness value={info()} />);
    const families = () => screen.getAllByLabelText('Family name').map((el) => (el as HTMLInputElement).value);
    expect(families()).toEqual(['Müller', 'Schmidt']);
    screen.getAllByLabelText('Family name')[0]?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(families()).toEqual(['Schmidt', 'Müller']);
    expect(document.activeElement).toBe(screen.getAllByLabelText('Family name')[1]);
    await user.click(screen.getByRole('button', { name: 'Add author' }));
    expect(families()).toEqual(['Schmidt', 'Müller', '']);
    expect(document.activeElement).toBe(screen.getAllByLabelText('Family name')[2]);
    await user.click(screen.getAllByRole('button', { name: 'Remove author' })[0] as HTMLElement);
    expect(families()).toEqual(['Müller', '']);
  });

  it('shows the nothing-found row for an empty record, with editable fields', () => {
    setup(<Harness value={{ ...info(), record: emptyBibRecord(), sources: {} }} />);
    expect(screen.getByText('Nothing found in the file. Fill in what you know.')).toBeTruthy();
    expect(screen.getByLabelText('Title').hasAttribute('readonly')).toBe(false);
  });

  it('renders read-only fields with the read-only caption and no editing buttons', () => {
    setup(<Harness value={info()} readOnly />);
    expect(screen.getByText("This document can't be edited.")).toBeTruthy();
    expect(screen.getByLabelText('Title').hasAttribute('readonly')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add author' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove author' })).toBeNull();
    expect((screen.getByLabelText('Type') as HTMLSelectElement).disabled).toBe(true);
  });
});
