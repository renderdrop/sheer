import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextPreview } from '../../api/textPreview';
import { createPreviewScheduler, inkSpan, previewScale, scaleXFor } from './preview';

const preview = (generation: number): TextPreview => ({
  generation,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  pxPerPt: 2,
  overflowPt: 0,
  fallback: null,
  png: new Uint8Array(),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPreviewScheduler', () => {
  it('asks 60 ms after the last keystroke', () => {
    const run = vi.fn(() => new Promise<TextPreview>(() => undefined));
    const s = createPreviewScheduler({ run, onPreview: vi.fn() });
    s.schedule();
    vi.advanceTimersByTime(40);
    s.schedule();
    vi.advanceTimersByTime(59);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('waits 100 ms while a preview still runs', () => {
    const run = vi.fn(() => new Promise<TextPreview>(() => undefined));
    const s = createPreviewScheduler({ run, onPreview: vi.fn() });
    s.schedule();
    vi.advanceTimersByTime(60);
    s.schedule();
    vi.advanceTimersByTime(99);
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits 100 ms after a slow preview', async () => {
    let t = 0;
    const run = vi.fn((g: number) => {
      t += 80;
      return Promise.resolve(preview(g));
    });
    const s = createPreviewScheduler({ run, onPreview: vi.fn(), now: () => t });
    s.schedule();
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    await Promise.resolve();
    s.schedule();
    vi.advanceTimersByTime(99);
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps only the newest generation', async () => {
    const pending: { g: number; resolve: (p: TextPreview) => void }[] = [];
    const run = (g: number) =>
      new Promise<TextPreview>((resolve) => {
        pending.push({ g, resolve });
      });
    const onPreview = vi.fn();
    const s = createPreviewScheduler({ run, onPreview });
    s.schedule();
    vi.advanceTimersByTime(60);
    s.schedule();
    vi.advanceTimersByTime(100);
    expect(pending).toHaveLength(2);
    const [old, newest] = pending;
    old?.resolve(preview(old.g));
    await Promise.resolve();
    expect(onPreview).not.toHaveBeenCalled();
    newest?.resolve(preview(newest.g));
    await Promise.resolve();
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it('drops a cancelled answer and a late one after dispose', async () => {
    const onPreview = vi.fn();
    const s = createPreviewScheduler({ run: () => Promise.reject(new Error('cancelled')), onPreview });
    s.schedule();
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    expect(onPreview).not.toHaveBeenCalled();
    let settle: () => void = () => undefined;
    const late = createPreviewScheduler({
      run: (g) =>
        new Promise<TextPreview>((resolve) => {
          settle = () => resolve(preview(g));
        }),
      onPreview,
    });
    late.schedule();
    vi.advanceTimersByTime(60);
    late.dispose();
    settle();
    await Promise.resolve();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('reports a refused draft but not a cancelled one', async () => {
    const onFailure = vi.fn();
    const refused = createPreviewScheduler({
      run: () => Promise.reject({ code: 'unsupported_feature' }),
      onPreview: vi.fn(),
      onFailure,
    });
    refused.schedule();
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledOnce();
    const cancelled = createPreviewScheduler({
      run: () => Promise.reject({ code: 'cancelled' }),
      onPreview: vi.fn(),
      onFailure,
    });
    cancelled.schedule();
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

describe('helpers', () => {
  it('clamps the scale to what the backend takes', () => {
    expect(previewScale(0.1, 1)).toBe(0.5);
    expect(previewScale(5, 2)).toBe(8);
    expect(previewScale(1.5, 2)).toBe(3);
  });
  it('finds the ink columns', () => {
    const w = 6;
    const data = new Uint8ClampedArray(w * 2 * 4).fill(255);
    const dark = (x: number) => data.fill(0, (w + x) * 4, (w + x) * 4 + 3);
    dark(2);
    dark(4);
    expect(inkSpan(data, w, 2)).toEqual({ left: 2, right: 5 });
    expect(inkSpan(new Uint8ClampedArray(w * 2 * 4).fill(255), w, 2)).toBeNull();
  });
  it('scales the CSS text to the picture', () => {
    expect(scaleXFor(110, 100)).toBeCloseTo(1.1);
    expect(scaleXFor(100.05, 100)).toBe(1);
    expect(scaleXFor(0, 100)).toBe(1);
  });
});
