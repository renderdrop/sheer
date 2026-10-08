import { describe, expect, it } from 'vitest';

import { headerFooterReason, mayHeaderFooter, type ActionState } from '../../actions/state';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import {
  HF_UNDO_LABELS,
  buildSpec,
  canApply,
  checkRange,
  defaultDraft,
  draftFromSpec,
  escapeText,
  formatHfDate,
  parseSlotText,
  refusalKey,
  serializeSlot,
  simpleRange,
  unescapeText,
  withRange,
  withValue,
} from './model';

const CTX = { color: [15, 15, 15] as [number, number, number], date: '7 Oct 2026', total: 5, lang: 'en' as const };

describe('defaults (HF3)', () => {
  it('starts with the date left and "Page n of N" right in the footer, 10 pt, 24 pt, all pages', () => {
    const draft = defaultDraft();
    expect(draft.slots.footerLeft.kind).toBe('date');
    expect(draft.slots.footerRight).toMatchObject({ kind: 'page', format: 'pageNofTotal' });
    expect(draft.slots.headerLeft.kind).toBe('none');
    expect(draft.current).toBe('footerRight');
    expect([draft.fontSize, draft.margin, draft.allPages]).toEqual([10, 24, true]);
    const spec = buildSpec(draft, CTX);
    expect(spec?.slots.footerLeft).toBe('{date}');
    expect(spec?.slots.footerRight).toBe('Page {page} of {total}');
    expect(spec?.pages).toEqual({ type: 'all' });
    expect(spec?.date).toBe('7 Oct 2026');
  });
});

describe('slots', () => {
  it('writes one item per place in the UI language and reads it back', () => {
    const page = { kind: 'page', text: '', format: 'pageNofTotal' } as const;
    expect(serializeSlot(page, 'de')).toBe('Seite {page} von {total}');
    expect(parseSlotText('Seite {page} von {total}')).toMatchObject({ kind: 'page', format: 'pageNofTotal' });
    expect(parseSlotText('{page} / {total}')).toMatchObject({ kind: 'page', format: 'nSlashTotal' });
    expect(parseSlotText('{date}').kind).toBe('date');
    expect(parseSlotText('{file}').kind).toBe('file');
    expect(parseSlotText('').kind).toBe('none');
  });

  it('keeps braces in a text literal', () => {
    expect(escapeText('a {b}')).toBe('a {{b}}');
    expect(unescapeText('a {{b}}')).toBe('a {b}');
    const slot = { kind: 'text', text: '{page}', format: 'n' } as const;
    expect(serializeSlot(slot, 'en')).toBe('{{page}}');
    expect(parseSlotText('{{page}}')).toMatchObject({ kind: 'text', text: '{page}' });
  });
});

describe('page range', () => {
  it('accepts whole pages from 1 to the count, in order', () => {
    expect(checkRange('2', '3', 5)).toMatchObject({ valid: true, text: '2-3', first: 2, last: 3, count: 2 });
    expect(checkRange('', '', 5)).toMatchObject({ valid: true, text: '1-5', count: 5 });
    expect(checkRange('4', '', 5)).toMatchObject({ valid: true, text: '4-5', count: 2 });
  });

  it('refuses 0, past the end, reversed, and non-numbers', () => {
    for (const [from, to] of [
      ['0', '2'],
      ['1', '6'],
      ['4', '2'],
      ['a', '2'],
      ['1.5', '2'],
      ['-1', '2'],
    ] as const) {
      expect(checkRange(from, to, 5).valid, `${from}-${to}`).toBe(false);
    }
  });

  it('reads one simple range back from a spec, else falls back to all pages', () => {
    expect(simpleRange('2-3', 5)).toEqual({ from: 2, to: 3 });
    expect(simpleRange('4-', 5)).toEqual({ from: 4, to: 5 });
    expect(simpleRange('3', 5)).toEqual({ from: 3, to: 3 });
    expect(simpleRange('1-3, 5', 5)).toBeNull();
    const spec = buildSpec({ ...defaultDraft(), allPages: false, from: '1', to: '3' }, CTX);
    expect(spec?.pages).toEqual({ type: 'ranges', text: '1-3' });
    if (spec === null) throw new Error('no spec');
    expect(draftFromSpec(spec, 5)).toMatchObject({ allPages: false, from: '1', to: '3' });
    const messy = { ...spec, pages: { type: 'ranges' as const, text: '1-3, 5' } };
    expect(draftFromSpec(messy, 5).allPages).toBe(true);
  });

  it('carries the background option both ways and starts without it', () => {
    expect(defaultDraft().background).toBe(false);
    expect(buildSpec(defaultDraft(), CTX)?.background).toBe(false);
    const spec = buildSpec({ ...defaultDraft(), background: true }, CTX);
    expect(spec?.background).toBe(true);
    if (spec === null) throw new Error('no spec');
    expect(draftFromSpec(spec, 5).background).toBe(true);
  });

  it('preselects the selected pages', () => {
    expect(withRange(defaultDraft(), 2, 4)).toMatchObject({ allPages: false, from: '2', to: '4' });
  });
});

describe('apply rules', () => {
  it('needs something in a place, a valid range and no blank text', () => {
    const draft = defaultDraft();
    expect(canApply(draft, 5)).toBe(true);
    expect(canApply({ ...draft, allPages: false, from: '4', to: '2' }, 5)).toBe(false);
    expect(buildSpec({ ...draft, allPages: false, from: '4', to: '2' }, CTX)).toBeNull();
    const blank = {
      ...draft,
      slots: { ...draft.slots, headerLeft: { kind: 'text' as const, text: '  ', format: 'n' as const } },
    };
    expect(canApply(blank, 5)).toBe(false);
    const none = {
      ...draft,
      slots: {
        ...draft.slots,
        footerLeft: { ...draft.slots.footerLeft, kind: 'none' as const },
        footerRight: { ...draft.slots.footerRight, kind: 'none' as const },
      },
    };
    expect(canApply(none, 5)).toBe(false);
  });

  it('keeps a size the file has beside the standard ones', () => {
    expect(withValue([8, 9, 10], 9)).toEqual([8, 9, 10]);
    expect(withValue([8, 10], 9)).toEqual([8, 9, 10]);
  });

  it('formats the date short, with plain spaces', () => {
    const text = formatHfDate(new Date(2026, 9, 7), 'en');
    expect(text.length).toBeLessThanOrEqual(32);
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`));
  });
});

const NO_DOC: ActionState = { hasDocument: false, zoomAtMin: false, zoomAtMax: false, canUndo: false, canRedo: false };

describe('refusal (HF6)', () => {
  const open: ActionState = { ...NO_DOC, hasDocument: true };

  it('is enabled on an editable document', () => {
    expect(mayHeaderFooter(open)).toBe(true);
    expect(headerFooterReason(open)).toBeNull();
  });

  it('names the reason: certified lock first, then signed, permission, OCR', () => {
    expect(headerFooterReason({ ...open, signatureLocked: true, signed: true })).toBe('cert.locked.tool');
    expect(headerFooterReason({ ...open, signedFile: true })).toBe('hf.signed');
    expect(headerFooterReason({ ...open, canEdit: false })).toBe('tool.readOnly');
    expect(headerFooterReason({ ...open, readOnly: true })).toBe('tool.readOnly');
    expect(headerFooterReason({ ...open, ocrBusy: true })).toBe('ocr.busy');
    for (const flag of [{ signedFile: true }, { canEdit: false }, { ocrBusy: true }, { signatureLocked: true }]) {
      expect(mayHeaderFooter({ ...open, ...flag })).toBe(false);
    }
    expect(mayHeaderFooter(NO_DOC)).toBe(false);
  });

  it("maps the backend's refusal to a message", () => {
    expect(refusalKey('signed')).toBe('hf.signed');
    expect(refusalKey('permission')).toBe('tool.readOnly');
  });
});

describe('undo label (HF5)', () => {
  it('has a text in both languages for the labels the backend sends', () => {
    for (const key of Object.values(HF_UNDO_LABELS)) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((de as Record<string, string>)[key]).toBeTruthy();
    }
    expect(en['headerFooter.set']).toBe(en['hf.undo']);
    expect(en['headerFooter.remove']).toBe(en['hf.undoRemove']);
  });
});
