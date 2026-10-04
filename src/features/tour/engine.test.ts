import { describe, expect, it } from 'vitest';

import type { Annotation } from '../../api/annotations';
import {
  NAVIGATE_SETTLE_MS,
  SIGN_SETTLE_MS,
  highlightCovers,
  isSatisfied,
  precedes,
  settleDelay,
  type StepFacts,
} from './engine';
import { SHIPPED_STEPS, pageIdOfKind, parseSteps, shippedOf, type TourStep } from './steps';

const view = (pageIndex: number, zoom: number) => ({ pageIndex, zoom });

describe('step conditions', () => {
  it('completes Navigate on page 2 or later, and not on page 1', () => {
    expect(isSatisfied('navigate', view(0, 1), { zoom: 1 })).toBe(false);
    expect(isSatisfied('navigate', view(1, 1), { zoom: 1 })).toBe(true);
    expect(isSatisfied('navigate', view(3, 1), { zoom: 1 })).toBe(true);
  });

  it('completes Zoom at any committed zoom above the zoom the step started with', () => {
    expect(isSatisfied('zoom', view(0, 1), { zoom: 1 })).toBe(false);
    expect(isSatisfied('zoom', view(0, 0.9), { zoom: 1 })).toBe(false);
    expect(isSatisfied('zoom', view(0, 1.1), { zoom: 1 })).toBe(true);
    expect(isSatisfied('zoom', view(0, 1.3), { zoom: 1.25 })).toBe(true);
  });

  it('never completes Open or an unknown step by state', () => {
    expect(isSatisfied('open', view(5, 4), { zoom: 1 })).toBe(false);
    expect(isSatisfied('nonsense', view(5, 4), { zoom: 1 })).toBe(false);
  });

  it('lets only Navigate settle', () => {
    expect(settleDelay('navigate')).toBe(NAVIGATE_SETTLE_MS);
    expect(settleDelay('zoom')).toBe(0);
  });
});

describe('the step manifest', () => {
  it('has the steps in order, and nothing unshipped', () => {
    expect(SHIPPED_STEPS.map((step) => step.id).slice(0, 3)).toEqual(['open', 'navigate', 'zoom']);
    expect(SHIPPED_STEPS.every((step) => step.shipped)).toBe(true);
  });

  it('drops steps that are not shipped', () => {
    const step = (id: string, shipped: boolean): TourStep => ({
      id,
      page: 'W',
      ships: 'M1',
      shipped,
      detect: 'auto',
      anchor: { a: 'x' },
    });
    expect(shippedOf([step('a', true), step('b', false), step('c', true)]).map((s) => s.id)).toEqual(['a', 'c']);
  });
});

// --- the steps that read the document (DESIGN 3.46) ---------------------------------------------------------------------------

const common = {
  color: [0, 0, 0],
  opacity: 1,
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  locked: false,
  sync: 'new',
} as const;
const point = (x: number, y: number) => ({ x, y });
const rectQuad = (x: number, y: number, w: number, h: number) =>
  [point(x, y), point(x + w, y), point(x, y + h), point(x + w, y + h)] as const;
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const highlight = (
  id: number,
  pageId: number,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: 'highlight' | 'underline' = 'highlight',
): Annotation => ({
  ...common,
  id,
  pageId,
  rect: box(x, y, w, h),
  kind,
  quads: [rectQuad(x, y, w, h)],
});
const note = (id: number, pageId: number, x: number, y: number, inReplyTo: number | null = null): Annotation => ({
  ...common,
  id,
  pageId,
  inReplyTo,
  rect: box(x, y, 24, 24),
  kind: 'note',
  at: point(x, y),
  icon: 'note',
});
const signature = (id: number, pageId: number, rect: ReturnType<typeof box>): Annotation => ({
  ...common,
  id,
  pageId,
  rect,
  kind: 'signature',
  box: rect,
  role: 'signature',
  art: { type: 'asset', assetId: 1, aspect: 3 },
});

const SENTENCE = box(72, 268, 288, 18);
const facts = (annotations: Annotation[], extra: Partial<StepFacts> = {}): StepFacts => ({
  annotations,
  pageOrder: [0, 1, 2, 3, 4],
  pageId: 2,
  ...extra,
});
const NONE = { pageIndex: 0, zoom: 1 };

describe('Highlight and Note', () => {
  it('needs a highlight over at least half of the sentence, on its page and line', () => {
    expect(highlightCovers([], 2, SENTENCE)).toBe(false);
    expect(highlightCovers([highlight(1, 2, 72, 268, 288, 18)], 2, SENTENCE)).toBe(true);
    expect(highlightCovers([highlight(1, 2, 72, 268, 144, 18)], 2, SENTENCE)).toBe(true);
    expect(highlightCovers([highlight(1, 2, 72, 268, 100, 18)], 2, SENTENCE)).toBe(false);
    // Two pieces add up, a piece twice over counts once.
    expect(highlightCovers([highlight(1, 2, 72, 268, 80, 18), highlight(2, 2, 150, 268, 80, 18)], 2, SENTENCE)).toBe(
      true,
    );
    expect(highlightCovers([highlight(1, 2, 72, 268, 100, 18), highlight(2, 2, 72, 268, 100, 18)], 2, SENTENCE)).toBe(
      false,
    );
    // Another page, another line, or another kind of mark does not count.
    expect(highlightCovers([highlight(1, 3, 72, 268, 288, 18)], 2, SENTENCE)).toBe(false);
    expect(highlightCovers([highlight(1, 2, 72, 320, 288, 18)], 2, SENTENCE)).toBe(false);
    expect(highlightCovers([highlight(1, 2, 72, 268, 288, 18, 'underline')], 2, SENTENCE)).toBe(false);
  });

  it('completes Highlight from the document facts', () => {
    expect(isSatisfied('highlight', NONE, { zoom: 1 })).toBe(false);
    const quad = SENTENCE;
    expect(isSatisfied('highlight', NONE, { zoom: 1 }, facts([highlight(1, 2, 72, 268, 288, 18)], { quad }))).toBe(
      true,
    );
    expect(isSatisfied('highlight', NONE, { zoom: 1 }, facts([], { quad }))).toBe(false);
  });

  it('completes Note for a note within 24 pt of the spot centre, not for a reply or a note elsewhere', () => {
    const target = box(468, 380, 24, 24);
    const near = (annotations: Annotation[]) =>
      isSatisfied('comment', NONE, { zoom: 1 }, facts(annotations, { target }));
    expect(near([note(1, 2, 480, 392)])).toBe(true);
    expect(near([note(1, 2, 500, 400)])).toBe(true);
    expect(near([note(1, 2, 520, 392)])).toBe(false);
    expect(near([note(1, 3, 480, 392)])).toBe(false);
    expect(near([note(1, 2, 480, 392, 7)])).toBe(false);
  });
});

describe('Sign', () => {
  const frame = box(48, 248, 288, 96);
  const signed = (annotations: Annotation[]) =>
    isSatisfied('sign', NONE, { zoom: 1 }, facts(annotations, { pageId: 3, target: frame }));

  it('completes when a signature has its centre in the frame, placed there or dragged there', () => {
    expect(signed([])).toBe(false);
    expect(signed([signature(1, 3, box(100, 260, 120, 40))])).toBe(true);
    // Placed outside, then dragged inside: the annotation changes, the same check holds.
    expect(signed([signature(1, 3, box(400, 500, 120, 40))])).toBe(false);
    expect(signed([signature(1, 3, box(60, 270, 120, 40))])).toBe(true);
    // The centre decides, not the overlap.
    expect(signed([signature(1, 3, box(300, 260, 120, 40))])).toBe(false);
    expect(signed([signature(1, 2, box(100, 260, 120, 40))])).toBe(false);
  });

  it('lets a keyboard nudge settle before it counts', () => {
    expect(settleDelay('sign')).toBe(SIGN_SETTLE_MS);
  });
});

describe('Reorder', () => {
  it('is satisfied when page S precedes page M, whichever input moved it', () => {
    expect(precedes([0, 1, 2, 3, 4], 3, 2)).toBe(false);
    expect(precedes([0, 1, 3, 2, 4], 3, 2)).toBe(true);
    expect(precedes([3, 0, 1, 2, 4], 3, 2)).toBe(true);
    expect(precedes([0, 1, 2, 4], 3, 2)).toBe(false);
    const reorder = (pageOrder: number[]) =>
      isSatisfied('reorder', NONE, { zoom: 1 }, facts([], { pageOrder, moves: 3, above: 2 }));
    expect(reorder([0, 1, 2, 3, 4])).toBe(false);
    expect(reorder([0, 1, 3, 2, 4])).toBe(true);
  });
});

describe('the shipped manifest', () => {
  it('ships all seven steps, with from/to for Reorder and a sentence box for Highlight', () => {
    expect(SHIPPED_STEPS.map((step) => step.id)).toEqual([
      'open',
      'navigate',
      'zoom',
      'highlight',
      'comment',
      'sign',
      'reorder',
    ]);
    const reorder = SHIPPED_STEPS.find((step) => step.id === 'reorder');
    expect([reorder?.from, reorder?.to]).toEqual([4, 3]);
    expect(SHIPPED_STEPS.find((step) => step.id === 'highlight')?.quad).toBeDefined();
  });

  it('finds the page ids of the five-page edition', () => {
    expect(['W', 'Z', 'M', 'S'].map((kind) => pageIdOfKind(SHIPPED_STEPS, kind))).toEqual([0, 1, 2, 3]);
    expect(pageIdOfKind(SHIPPED_STEPS, 'X')).toBeNull();
    // The M1 edition has Navigate after Welcome.
    const m1 = shippedOf(
      parseSteps({ steps: ['W', 'Z'].map((page, i) => ({ id: `s${i}`, page, shipped: true, anchor: { a: 'x' } })) }),
    );
    expect(pageIdOfKind(m1, 'Z')).toBe(2);
  });
});
