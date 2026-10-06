import { describe, expect, it } from 'vitest';

import type { SmartLink } from '../../api/smartLinks';
import {
  DRAG_PX,
  MIN_HIT_PX,
  cueRects,
  hitBox,
  hostOf,
  isDrag,
  kindKey,
  linksLive,
  pageLinks,
  pointerHit,
  readingOrder,
  runRects,
  stepFrom,
  toolMakesLinksLive,
  visitKey,
} from './model';

const rect = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h });
const link = (kind: SmartLink['kind'], rects: SmartLink['rects'], extra: Partial<SmartLink> = {}): SmartLink => ({
  kind,
  rects,
  marker: '1',
  target: { pageId: 2 },
  preview: '',
  ...extra,
});

describe('which tools make links live (L9)', () => {
  it('Auswahl, Hand and Textauswahl do; every other tool does not', () => {
    for (const tool of ['select', 'hand', 'textSelect']) expect(toolMakesLinksLive(tool)).toBe(true);
    for (const tool of ['highlight', 'note', 'draw', 'editText', 'crop', 'pages', 'magnifier', 'signature']) {
      expect(toolMakesLinksLive(tool)).toBe(false);
    }
  });

  it('a redaction band, a running tour and a selection drag hide them', () => {
    const base = { tool: 'select', redactMode: false, tourRunning: false, selecting: false };
    expect(linksLive(base)).toBe(true);
    expect(linksLive({ ...base, redactMode: true })).toBe(false);
    expect(linksLive({ ...base, tourRunning: true })).toBe(false);
    expect(linksLive({ ...base, selecting: true })).toBe(false);
    expect(linksLive({ ...base, tool: 'editText' })).toBe(false);
  });
});

describe('hit boxes (L4)', () => {
  it('a box smaller than 24 px is grown symmetrically to 24 x 24; a larger one is left alone', () => {
    expect(hitBox({ left: 100, top: 100, right: 108, bottom: 110 })).toEqual({
      left: 92,
      top: 93,
      right: 116,
      bottom: 117,
    });
    expect(hitBox({ left: 0, top: 0, right: 80, bottom: 30 })).toEqual({ left: 0, top: 0, right: 80, bottom: 30 });
    expect(MIN_HIT_PX).toBe(24);
  });

  it('an empty box (no layout) stays empty and is never hit', () => {
    const empty = { left: 5, top: 5, right: 5, bottom: 5 };
    expect(hitBox(empty)).toEqual(empty);
    expect(pointerHit([empty], 5, 5)).toBe(-1);
  });

  it('the pointer hits the padded area around a small run, not beyond it', () => {
    const run = { left: 100, top: 100, right: 108, bottom: 110 };
    expect(pointerHit([run], 93, 116)).toBe(0);
    expect(pointerHit([run], 91, 105)).toBe(-1);
    expect(pointerHit([run], 105, 117.5)).toBe(-1);
  });

  it('of overlapping boxes the smaller run wins', () => {
    const line = { left: 0, top: 0, right: 200, bottom: 30 };
    const number = { left: 180, top: 5, right: 195, bottom: 25 };
    expect(pointerHit([line, number], 188, 15)).toBe(1);
    expect(pointerHit([line, number], 20, 15)).toBe(0);
  });
});

describe('press versus drag (L4)', () => {
  it('a press that moves 4 px or more is a drag', () => {
    expect(DRAG_PX).toBe(4);
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
  });
});

describe('the links of a page', () => {
  it('a contents line draws its cue under the page number and takes its hit area from the whole line', () => {
    const contents = link('contents', [rect(500, 100, 12, 10), rect(72, 100, 450, 10)]);
    expect(cueRects(contents)).toEqual([rect(500, 100, 12, 10)]);
    expect(runRects(contents)).toEqual([rect(72, 100, 450, 10)]);
    const footnote = link('footnote', [rect(10, 10)]);
    expect(cueRects(footnote)).toEqual(footnote.rects);
    expect(runRects(footnote)).toEqual(footnote.rects);
  });

  it('lists real and smart links together in reading order', () => {
    const items = pageLinks(
      [link('footnote', [rect(300, 50)]), link('reference', [rect(20, 50)]), link('footnote', [rect(20, 10)])],
      [{ index: 0, rect: rect(100, 51), target: { type: 'url', url: 'https://example.org/' } }],
    );
    expect(items.map((item) => item.key)).toEqual(['s2', 's1', 'r0', 's0']);
  });

  it('reads top to bottom and, within one line, left to right', () => {
    expect(readingOrder(rect(300, 10), rect(20, 40))).toBeLessThan(0);
    expect(readingOrder(rect(300, 10.5), rect(20, 10))).toBeGreaterThan(0);
  });

  it('no links at all is an empty list', () => {
    expect(pageLinks(null, null)).toEqual([]);
  });

  it('a link is visited by its kind, text and target, not by where it sits', () => {
    const a = link('footnote', [rect(1, 1)], { marker: '3', target: { pageId: 4, rect: rect(0, 700.4) } });
    const b = link('footnote', [rect(90, 90)], { marker: '3', target: { pageId: 4, rect: rect(0, 700.2) } });
    expect(visitKey(a)).toBe(visitKey(b));
    expect(visitKey(a)).not.toBe(visitKey({ ...a, marker: '4' }));
  });

  it('names the kinds with their catalog keys, and a host from a URL or a mail address', () => {
    expect(kindKey('noteBack')).toBe('smartlinks.kind.noteBack');
    expect(hostOf('https://docs.example.org/a/b?c=d')).toBe('docs.example.org');
    expect(hostOf('mailto:ada@example.org')).toBe('ada@example.org');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('arrow keys inside a page list (L11)', () => {
  it('Down and Right go to the next, Up and Left to the previous; Home and End to the ends', () => {
    expect(stepFrom('ArrowDown', 0, 3)).toEqual({ to: 1 });
    expect(stepFrom('ArrowRight', 1, 3)).toEqual({ to: 2 });
    expect(stepFrom('ArrowUp', 2, 3)).toEqual({ to: 1 });
    expect(stepFrom('ArrowLeft', 1, 3)).toEqual({ to: 0 });
    expect(stepFrom('Home', 2, 3)).toEqual({ to: 0 });
    expect(stepFrom('End', 0, 3)).toEqual({ to: 2 });
  });

  it('past the last link focus goes to the next page, before the first to the previous page', () => {
    expect(stepFrom('ArrowDown', 2, 3)).toEqual({ out: 'next' });
    expect(stepFrom('ArrowUp', 0, 3)).toEqual({ out: 'prev' });
  });

  it('other keys are not navigation', () => {
    expect(stepFrom('a', 0, 3)).toBeNull();
    expect(stepFrom('Tab', 0, 3)).toBeNull();
  });
});
