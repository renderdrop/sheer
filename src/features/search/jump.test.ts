// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Quad } from '../../api/wire';
import { clearTextCache } from '../textlayer/cache';
import { forgetFileRotations, setFileRotation } from '../viewer/fileRotation';
import { useViewer } from '../viewer/useViewer';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { hitTopInView, jumpToHit } from './jump';
import type { Hit } from './store';

const textApi = vi.hoisted(() => ({ getTextLayer: vi.fn() }));
vi.mock('../../api/text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/text')>()),
  getTextLayer: textApi.getTextLayer,
}));

/** A hit at x 10 to 40, y 20 to 32 of a page that is 100 x 200 pt before its own /Rotate 90, so it is drawn 200 x 100. */
const quad: Quad = [
  { x: 10, y: 20 },
  { x: 40, y: 20 },
  { x: 10, y: 32 },
  { x: 40, y: 32 },
];
const hit: Hit = { index: 0, page: 0, quads: [quad] };

beforeEach(() => {
  forgetFileRotations(1);
  clearTextCache();
  showDocument({ id: 1, pageCount: 1, displayName: 'a.pdf' }, { sizes: [[200, 100]] });
  textApi.getTextLayer.mockReset();
});
afterEach(() => {
  clearTextCache();
  resetViewer();
});

describe('where a hit is in the view', () => {
  it('follows the page rotation: the top of a hit on a /Rotate 90 page is its x, not its y', () => {
    expect(hitTopInView(1, hit)).toBe(20);
    setFileRotation(1, 0, 90);
    expect(hitTopInView(1, hit)).toBe(10);
  });

  it('waits for the rotation of a page it does not know yet, then scrolls to the right line', async () => {
    const goToPoint = vi.fn();
    useViewer.setState({ goToPoint });
    textApi.getTextLayer.mockResolvedValue({ text: '', boxes: new Float32Array(0), truncated: false, rotation: 90 });
    jumpToHit(1, hit);
    expect(goToPoint).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(goToPoint).toHaveBeenCalledWith(0, 10));
    // Known now: the next jump goes at once.
    jumpToHit(1, hit);
    expect(goToPoint).toHaveBeenCalledTimes(2);
  });

  it('only the newest jump scrolls when the rotation arrives late', async () => {
    const goToPoint = vi.fn();
    useViewer.setState({ goToPoint });
    let release: (value: unknown) => void = () => undefined;
    textApi.getTextLayer.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    jumpToHit(1, hit);
    jumpToHit(1, hit);
    release({ text: '', boxes: new Float32Array(0), truncated: false, rotation: 0 });
    await vi.waitFor(() => expect(goToPoint).toHaveBeenCalled());
    expect(goToPoint).toHaveBeenCalledTimes(1);
  });
});
