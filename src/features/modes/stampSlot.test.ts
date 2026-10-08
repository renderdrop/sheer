import { beforeEach, describe, expect, it } from 'vitest';

import { translators } from '../../i18n';
import { useUi } from '../../stores/ui';
import { useToolInspector } from '../inspector/toolInspector';
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

const slot = (mode: 'comment' | 'edit', id: string, over: Partial<Inputs> = {}, lang: 'en' | 'de' = 'en') => {
  const found = slotsFor(mode, inputs(over, lang)).find((s) => s.id === id);
  if (found === undefined) throw new Error(`no ${id} slot`);
  return found;
};

beforeEach(() => {
  useUi.setState({ activeTool: 'select', toolLocked: false });
  useStamp.setState({ pickerOpen: false, changing: null, keyboard: false });
  useLastVariant.setState({ last: {} });
  useToolInspector.setState({ open: null });
});

describe('Notiz and Stempel (DESIGN 3.18 E4)', () => {
  it('Kommentieren has eight slots; Notiz is a plain colour tool without variants', () => {
    expect(slotsFor('comment', inputs())).toHaveLength(8);
    const note = slot('comment', 'note');
    expect(note.label).toBe('Note');
    expect(note.variants).toBeUndefined();
    expect(note.colour?.kinds).toEqual(['note']);
  });

  it('Stempel is its own Bearbeiten slot, in German too, and a group of its own with Zuschneiden and Kopf-/Fußzeile', () => {
    const slots = slotsFor('edit', inputs());
    expect(slots).toHaveLength(9);
    expect(slots.map((s) => s.id).slice(3, 6)).toEqual(['crop', 'headerFooter', 'stamp']);
    expect(slots[3]?.separatorBefore).toBe(true);
    expect(slots[6]?.separatorBefore).toBe(true);
    expect(slot('edit', 'stamp').label).toBe('Stamp');
    expect(slot('edit', 'stamp', {}, 'de').label).toBe('Stempel');
  });

  it('choosing Stempel arms the tool and opens the inspector', () => {
    slot('edit', 'stamp').run();
    expect(useUi.getState().activeTool).toBe('stamp');
    expect(useToolInspector.getState().open).toBe('stamp');
  });

  it('Stempel is on while the tool is active; a read-only document disables it with the usual reason', () => {
    expect(slot('edit', 'stamp', { activeTool: 'stamp' }).on).toBe(true);
    expect(slot('edit', 'stamp').disabledReason).toBeUndefined();
    expect(slot('edit', 'stamp', { readOnly: true }).disabledReason).toBe(translators.en('tool.readOnly'));
  });

  it('Zuschneiden and Kopf-/Fußzeile open their inspector pages', () => {
    slot('edit', 'crop').run();
    expect(useToolInspector.getState().open).toBe('crop');
    slot('edit', 'headerFooter').run();
    expect(useToolInspector.getState().open).toBe('headerFooter');
  });
});
