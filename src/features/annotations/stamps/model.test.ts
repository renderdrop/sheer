import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FIRST_CHOICE,
  STAMP_BORDER_PT,
  STAMP_HEIGHT_DATED_PT,
  STAMP_HEIGHT_PT,
  STAMP_MIN_WIDTH_PT,
  STAMP_PAD_X_PT,
  STAMP_RADIUS_PT,
  boldWidth,
  cleanOwn,
  clickBox,
  defaultSize,
  dragBox,
  faceOf,
  fittedFont,
  formatStampDate,
  ghostStart,
  ghostStep,
  gridTarget,
  parseRecent,
  pushRecent,
  textLayout,
  type RecentText,
} from './model';

const PAGE = [600, 800] as const;
const TODAY = new Date(2026, 9, 7);
const label = (preset: string): string =>
  ({ draft: 'Entwurf', approved: 'Genehmigt', confidential: 'Vertraulich', received: 'Erhalten' })[preset] ?? preset;
const names = (list: readonly RecentText[]): string[] => list.map((r) => `${r.text}${r.date ? '+' : ''}`);

describe('the tokens mirror the model', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  it.each([
    ['--stamp-height', STAMP_HEIGHT_PT],
    ['--stamp-height-dated', STAMP_HEIGHT_DATED_PT],
    ['--stamp-min-width', STAMP_MIN_WIDTH_PT],
    ['--stamp-pad-x', STAMP_PAD_X_PT],
    ['--stamp-border', STAMP_BORDER_PT],
    ['--stamp-radius', STAMP_RADIUS_PT],
  ])('%s', (name, value) => {
    expect(css).toContain(`${name}: ${value}px;`);
  });
});

describe('the date', () => {
  it('is written the way the UI language writes it', () => {
    expect(formatStampDate(TODAY, 'de')).toBe('07.10.2026');
    expect(formatStampDate(TODAY, 'en')).toBe('Oct 7, 2026');
  });
  it('holds only characters WinAnsi has', () => {
    for (const locale of ['de', 'en'] as const) expect(formatStampDate(TODAY, locale)).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('the face of a choice', () => {
  it('writes a predefined label in upper case in the UI language', () => {
    expect(faceOf(FIRST_CHOICE, label, 'de', TODAY)).toEqual({ stamp: 'draft', text: 'ENTWURF', date: null });
    expect(faceOf({ ...FIRST_CHOICE, stamp: 'confidential' }, label, 'de', TODAY)?.text).toBe('VERTRAULICH');
  });
  it('gives Received the day of placing', () => {
    expect(faceOf({ ...FIRST_CHOICE, stamp: 'received' }, label, 'de', TODAY)).toEqual({
      stamp: 'received',
      text: 'ERHALTEN',
      date: '07.10.2026',
    });
    expect(faceOf({ ...FIRST_CHOICE, stamp: 'received' }, (p) => p, 'en', TODAY)?.date).toBe('Oct 7, 2026');
  });
  it('keeps an own text as typed, with the date only when asked', () => {
    const own = { ...FIRST_CHOICE, stamp: 'custom' as const, custom: '  Bezahlt  ' };
    expect(faceOf(own, label, 'de', TODAY)).toEqual({ stamp: 'custom', text: 'Bezahlt', date: null });
    expect(faceOf({ ...own, withDate: true }, label, 'de', TODAY)?.date).toBe('07.10.2026');
  });
  it('has no face for an empty own text', () => {
    expect(faceOf({ ...FIRST_CHOICE, stamp: 'custom', custom: '   ' }, label, 'en', TODAY)).toBeNull();
  });
  it('limits an own text to 32 characters on one line', () => {
    expect(cleanOwn('a'.repeat(40))).toHaveLength(32);
    expect(cleanOwn('one\n two')).toBe('one two');
  });
});

describe('the default size and the click', () => {
  it('is 40 high and at least 96 wide, with a date 56 high', () => {
    expect(defaultSize({ text: 'OK', date: null })).toEqual({ w: STAMP_MIN_WIDTH_PT, h: STAMP_HEIGHT_PT });
    expect(defaultSize({ text: 'OK', date: '07.10.2026' }).h).toBe(STAMP_HEIGHT_DATED_PT);
  });
  it('is the text width plus 2 x 12 for a long text', () => {
    const size = defaultSize({ text: 'VERTRAULICH', date: null });
    expect(size.w).toBeCloseTo(boldWidth('VERTRAULICH', 18) + 24, 5);
    expect(size.w).toBeGreaterThan(STAMP_MIN_WIDTH_PT);
  });
  it('centres on the click', () => {
    expect(clickBox({ x: 300, y: 400 }, { w: 100, h: 40 }, PAGE)).toEqual({ x: 250, y: 380, w: 100, h: 40 });
  });
  it('is held inside the page', () => {
    expect(clickBox({ x: 5, y: 5 }, { w: 100, h: 40 }, PAGE)).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(clickBox({ x: 599, y: 799 }, { w: 100, h: 40 }, PAGE)).toEqual({ x: 500, y: 760, w: 100, h: 40 });
  });
});

describe('the drag', () => {
  const size = { w: 120, h: 40 };
  it('fills the box with the aspect kept, the smaller fit winning', () => {
    expect(dragBox({ x: 100, y: 100 }, { x: 340, y: 180 }, size, PAGE)).toEqual({ x: 100, y: 100, w: 240, h: 80 });
    const tall = dragBox({ x: 100, y: 100 }, { x: 160, y: 300 }, size, PAGE);
    expect(tall.w / tall.h).toBeCloseTo(3, 5);
    expect(tall.w).toBeCloseTo(60, 5);
  });
  it('works from any corner', () => {
    expect(dragBox({ x: 340, y: 180 }, { x: 100, y: 100 }, size, PAGE)).toMatchObject({ x: 100, y: 100 });
  });
  it('is at least 20 high', () => {
    expect(dragBox({ x: 100, y: 100 }, { x: 110, y: 104 }, size, PAGE).h).toBe(20);
  });
});

describe('the recent own texts', () => {
  it('lists the newest first, without duplicates, at most three', () => {
    let list = pushRecent([], { text: 'a', date: false });
    list = pushRecent(list, { text: 'b', date: false });
    list = pushRecent(list, { text: 'a', date: true });
    expect(names(list)).toEqual(['a+', 'b', 'a']);
    list = pushRecent(list, { text: 'a', date: false });
    expect(names(list)).toEqual(['a', 'a+', 'b']);
  });
  it('a fourth text drops the oldest', () => {
    const list = ['1', '2', '3', '4'].reduce<RecentText[]>((all, text) => pushRecent(all, { text, date: false }), []);
    expect(names(list)).toEqual(['4', '3', '2']);
  });
  it('reads storage defensively', () => {
    expect(parseRecent('x')).toEqual([]);
    expect(
      parseRecent([{ text: 'ok', date: true }, { text: 5, date: true }, null, { text: ' ', date: false }]),
    ).toEqual([{ text: 'ok', date: true }]);
  });
});

describe('the keyboard', () => {
  it('moves in a two by two grid without wrapping rows', () => {
    expect(gridTarget('ArrowRight', 0, 4, 2)).toBe(1);
    expect(gridTarget('ArrowRight', 1, 4, 2)).toBeNull();
    expect(gridTarget('ArrowDown', 0, 4, 2)).toBe(2);
    expect(gridTarget('ArrowUp', 1, 4, 2)).toBeNull();
    expect(gridTarget('ArrowLeft', 2, 4, 2)).toBeNull();
    expect(gridTarget('Enter', 0, 4, 2)).toBeNull();
  });
  it('steps the ghost by arrows and starts in the visible centre', () => {
    expect(ghostStep('ArrowLeft')).toEqual({ x: -1, y: 0 });
    expect(ghostStep('a')).toBeNull();
    expect(ghostStart({ x: 0, y: 100, w: 600, h: 400 }, PAGE)).toEqual({ x: 300, y: 300 });
    expect(ghostStart(null, PAGE)).toEqual({ x: 300, y: 400 });
  });
});

describe('the text fit', () => {
  it('fits the height of a short text and the width of a long one', () => {
    expect(fittedFont('OK', null, 96, 40)).toBeCloseTo(24, 5);
    expect(fittedFont('VERTRAULICH VERTRAULICH', null, 96, 40)).toBeLessThan(24);
    expect(fittedFont('X', null, 4, 4)).toBe(6);
  });
  it('puts a dated stamp on two baselines inside the box', () => {
    const l = textLayout('PAID', '07.10.2026', 120, 56);
    expect(l.baseline).toBeLessThan(l.dateBaseline);
    expect(l.dateBaseline).toBeLessThan(56);
    expect(l.dateSize).toBeCloseTo(l.size * 0.6, 5);
  });
});
