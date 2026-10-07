// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { useUi } from '../../../stores/ui';
import { STAMP_KEY, armStamp, parseStored, useStamp } from './store';

beforeEach(() => {
  globalThis.localStorage.clear();
  useStamp.setState({ pickerOpen: false, keyboard: false, changing: null, recent: [] });
  useUi.setState({ activeTool: 'select', toolLocked: false });
});

describe('the stamp store', () => {
  it('starts with a Solar Draft', () => {
    expect(parseStored(null).choice).toMatchObject({ stamp: 'draft', tone: 'solar', withDate: false });
  });

  it('drops what storage got wrong', () => {
    const stored = parseStored({ choice: { stamp: 'urgent', custom: 5, withDate: 'yes', tone: 'red' }, recent: 4 });
    expect(stored.choice).toMatchObject({ stamp: 'draft', custom: '', tone: 'solar', withDate: false });
    expect(stored.recent).toEqual([]);
  });

  it('remembers a choice and the recent texts on this device', () => {
    useStamp.getState().choose({ stamp: 'custom', custom: 'Bezahlt', withDate: true, tone: 'ink' });
    useStamp.getState().remember({ text: 'Bezahlt', date: true });
    const saved: unknown = JSON.parse(globalThis.localStorage.getItem(STAMP_KEY) ?? 'null');
    expect(parseStored(saved)).toMatchObject({
      choice: { stamp: 'custom', custom: 'Bezahlt', withDate: true, tone: 'ink' },
      recent: [{ text: 'Bezahlt', date: true }],
    });
  });

  it('arms the tool and opens the picker, again on every call', () => {
    armStamp();
    expect(useUi.getState().activeTool).toBe('stamp');
    expect(useStamp.getState().pickerOpen).toBe(true);
    useStamp.getState().setPicker(false);
    armStamp();
    expect(useUi.getState().activeTool).toBe('stamp');
    expect(useStamp.getState().pickerOpen).toBe(true);
  });

  it('forgets which stamp is being changed when the picker closes', () => {
    useStamp.getState().setChanging(7);
    useStamp.getState().setPicker(true);
    useStamp.getState().setPicker(false);
    expect(useStamp.getState().changing).toBeNull();
  });
});
