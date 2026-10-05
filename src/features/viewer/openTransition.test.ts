import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DROP_WINDOW_MS,
  SOURCE_MAX_AGE_MS,
  beginOpening,
  entranceFor,
  forgetOpening,
  isFresh,
  launchJump,
  noteHoverEnded,
  noteOpenedFromApp,
  registerDropCard,
  resetTransition,
  resolveFresh,
  useTransition,
  type OpenSource,
} from './openTransition';
import { consumeJump, markJump } from './scrollBridge';

const CARD: OpenSource = { kind: 'card', rect: { left: 10, top: 20, width: 160, height: 208 } };

afterEach(() => {
  vi.useRealTimers();
  resetTransition();
});

describe('a dropped file', () => {
  it('the card falls and becomes the first page: its rect is taken when the document opens right after the drag left', () => {
    registerDropCard(() => CARD);
    noteHoverEnded();
    noteOpenedFromApp();
    expect(useTransition.getState().dropAccepted).toBe(1);
    beginOpening(7);
    expect(useTransition.getState().active).toMatchObject({ kind: 'open', docId: 7, page: 0, source: CARD });
    expect(entranceFor(7)).toBe('fade');
    expect(isFresh(7)).toBe(true);
    resolveFresh(7);
    expect(isFresh(7)).toBe(false);
  });

  it('is not a drop when the document opens long after the drag, or without one', () => {
    vi.useFakeTimers();
    registerDropCard(() => CARD);
    noteOpenedFromApp();
    noteHoverEnded();
    vi.advanceTimersByTime(DROP_WINDOW_MS + 1);
    noteOpenedFromApp();
    expect(useTransition.getState().dropAccepted).toBe(0);
    beginOpening(1);
    expect(useTransition.getState().active).toBeNull();
    // No source: the first page scales in.
    expect(entranceFor(1)).toBe('rise');
  });

  it('forgets a source that nobody used', () => {
    vi.useFakeTimers();
    registerDropCard(() => CARD);
    noteHoverEnded();
    noteOpenedFromApp();
    vi.advanceTimersByTime(SOURCE_MAX_AGE_MS + 1);
    beginOpening(2);
    expect(useTransition.getState().active).toBeNull();
  });
});

describe('entrance', () => {
  it('only a document that has just opened has one', () => {
    expect(entranceFor(5)).toBeUndefined();
  });
});

describe('a jump from a thumbnail', () => {
  it('flies a clone to the page', () => {
    launchJump(3, 41, { kind: 'image', src: 'blob:1', rect: CARD.rect });
    expect(useTransition.getState().active).toMatchObject({ kind: 'jump', docId: 3, page: 41 });
  });
});

describe('the jump mark', () => {
  it('is taken once, and expires', () => {
    vi.useFakeTimers();
    expect(consumeJump()).toBe(false);
    markJump();
    expect(consumeJump()).toBe(true);
    expect(consumeJump()).toBe(false);
    markJump();
    vi.advanceTimersByTime(600);
    expect(consumeJump()).toBe(false);
  });
});

describe('closing a document', () => {
  it('forgets that it was opening', () => {
    beginOpening(9);
    forgetOpening(9);
    expect(isFresh(9)).toBe(false);
    expect(entranceFor(9)).toBeUndefined();
  });
});
