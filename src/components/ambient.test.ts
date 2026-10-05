// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ambientPaused, watchAmbient } from './ambient';
import { phaseOf } from './SolarGlow';

afterEach(() => vi.restoreAllMocks());

describe('ambient glow (MOTION spell 11)', () => {
  it('pauses while the document is hidden or the window unfocused and resumes after', () => {
    let hidden = false;
    let focused = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const release = watchAmbient();
    const root = document.documentElement;
    expect(root.getAttribute('data-ambient')).toBeNull();
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.getAttribute('data-ambient')).toBe('paused');
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.getAttribute('data-ambient')).toBeNull();
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(root.getAttribute('data-ambient')).toBe('paused');
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(root.getAttribute('data-ambient')).toBeNull();
    expect(ambientPaused(document)).toBe(false);
    release();
  });

  it('is reference counted and leaves no attribute behind', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const a = watchAmbient();
    const b = watchAmbient();
    expect(document.documentElement.getAttribute('data-ambient')).toBe('paused');
    a();
    a();
    expect(document.documentElement.getAttribute('data-ambient')).toBe('paused');
    b();
    expect(document.documentElement.getAttribute('data-ambient')).toBeNull();
  });

  it('gives different ids different phases within one loop', () => {
    const phases = [':r1:', ':r2:', ':r3:', ':r4:'].map(phaseOf);
    expect(new Set(phases).size).toBeGreaterThan(1);
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});
