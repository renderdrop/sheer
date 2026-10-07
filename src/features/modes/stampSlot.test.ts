import { beforeEach, describe, expect, it } from 'vitest';

import { translators } from '../../i18n';
import { useUi } from '../../stores/ui';
import { useStamp } from '../annotations/stamps/store';
import { slotsFor } from './useSlots';
import { useLastVariant } from './lastVariant';

type Inputs = Parameters<typeof slotsFor>[1];

const inputs = (over: Partial<Inputs> = {}, lang: 'en' | 'de' = 'en'): Inputs => ({
  t: translators[lang],
  activeTool: 'select',
  redactMode: false,
  markup: 'highlight',
  shapes: 'rect',
  armed: null,
  docId: 1,
  readOnly: false,
  selectedPages: 0,
  pageCount: 1,
  last: {},
  library: [],
  identities: [],
  certStatus: 'ready',
  certId: null,
  certActive: false,
  dirty: false,
  ...over,
});

const noteSlot = (over: Partial<Inputs> = {}, lang: 'en' | 'de' = 'en') => {
  const slot = slotsFor('comment', inputs(over, lang)).find((s) => s.id === 'note');
  if (slot === undefined) throw new Error('no note slot');
  return slot;
};

beforeEach(() => {
  useUi.setState({ activeTool: 'select', toolLocked: false });
  useStamp.setState({ pickerOpen: false, changing: null, keyboard: false });
  useLastVariant.setState({ last: {} });
});

describe('the Notiz / Stempel split (DESIGN 3.14 ST1)', () => {
  it('keeps Kommentieren at eight slots, Notiz in the fifth place', () => {
    const slots = slotsFor('comment', inputs());
    expect(slots).toHaveLength(8);
    expect(slots[4]?.id).toBe('note');
  });

  it('shows Notiz first and offers Notiz and Stempel in the menu', () => {
    const slot = noteSlot();
    expect(slot.label).toBe('Note');
    expect(slot.variants?.map((v) => v.label)).toEqual(['Note', 'Stamp']);
    expect(slot.colour?.kinds).toEqual(['note']);
    expect(slot.colour?.label).toBe('Note colour');
  });

  it('shows the label of the variant used last, in German too', () => {
    expect(noteSlot({ last: { note: 'stamp' } }).label).toBe('Stamp');
    expect(noteSlot({ last: { note: 'stamp' } }, 'de').label).toBe('Stempel');
    expect(noteSlot({ activeTool: 'stamp' }).label).toBe('Stamp');
  });

  it('choosing Stempel arms the tool, opens the picker and is remembered', () => {
    const slot = noteSlot();
    slot.variants?.find((v) => v.id === 'stamp')?.run();
    expect(useUi.getState().activeTool).toBe('stamp');
    expect(useStamp.getState().pickerOpen).toBe(true);
    expect(useLastVariant.getState().last.note).toBe('stamp');
  });

  it('the main part repeats the last variant', () => {
    noteSlot({ last: { note: 'stamp' } }).run();
    expect(useUi.getState().activeTool).toBe('stamp');
    expect(useStamp.getState().pickerOpen).toBe(true);
  });

  it('is on for either tool and hangs the picker on the main part while it is open', () => {
    expect(noteSlot({ activeTool: 'note' }).on).toBe(true);
    expect(noteSlot({ activeTool: 'stamp', stampPicker: true }).picker?.open).toBe(true);
    expect(noteSlot({ activeTool: 'stamp', stampPicker: false }).picker?.open).toBe(false);
    expect(noteSlot({ activeTool: 'select', stampPicker: true }).picker?.open).toBe(false);
  });

  it('a read-only document disables only the Stempel variant, with the usual reason', () => {
    expect(noteSlot({ readOnly: true }).disabledReason).toBeUndefined();
    expect(noteSlot({ readOnly: true, last: { note: 'stamp' } }).disabledReason).toBe(translators.en('tool.readOnly'));
  });
});
