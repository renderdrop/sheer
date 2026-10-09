// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeGlow, applyGlowSize } from './HomeGlow';

afterEach(() => vi.restoreAllMocks());

describe('HomeGlow (F22.1)', () => {
  it('writes surface size and window width in px', () => {
    const layer = document.createElement('div');
    applyGlowSize(layer, 800.4, 600.6, 1280);
    expect(layer.style.getPropertyValue('--glow-w')).toBe('800px');
    expect(layer.style.getPropertyValue('--glow-h')).toBe('601px');
    expect(layer.style.getPropertyValue('--glow-win-w')).toBe('1280px');
  });

  it('sets --glow-win-w on mount, follows window resize, and removes the listener', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    window.innerWidth = 1280;
    const { container, unmount } = render(
      <div>
        <HomeGlow />
      </div>,
    );
    const layer = container.querySelector('[data-home-glow]') as HTMLElement;
    expect(layer.style.getPropertyValue('--glow-win-w')).toBe('1280px');
    window.innerWidth = 1920;
    window.dispatchEvent(new Event('resize'));
    expect(layer.style.getPropertyValue('--glow-win-w')).toBe('1920px');
    expect(add).toHaveBeenCalledWith('resize', expect.any(Function));
    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
