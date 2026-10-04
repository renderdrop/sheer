// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BrandSurface, SolarGlow, WorkSurface } from '.';

describe('SolarGlow', () => {
  it.each(['hero', 'empty', 'card', 'drop', 'splash'] as const)('renders the %s layer in a BrandSurface', (variant) => {
    const { container } = render(
      <BrandSurface>
        <SolarGlow variant={variant} />
      </BrandSurface>,
    );
    const glow = container.querySelector('[data-glow]') as HTMLElement;
    expect(glow.dataset.glow).toBe(variant);
    expect(glow.getAttribute('aria-hidden')).toBe('true');
    expect(glow.style.inset).toBe('-10%');
    expect(glow.style.pointerEvents).toBe('none');
    expect(glow.style.willChange).toBe('transform');
    expect(glow.getAttribute('style')).toContain(`--glow-${variant}`);
  });

  it('throws inside a WorkSurface in dev', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <WorkSurface>
          <SolarGlow variant="hero" />
        </WorkSurface>,
      ),
    ).toThrow(/WorkSurface/);
    spy.mockRestore();
  });

  it('renders nothing inside a WorkSurface in production', () => {
    vi.stubEnv('DEV', false);
    const { container } = render(
      <WorkSurface>
        <SolarGlow variant="hero" />
      </WorkSurface>,
    );
    vi.unstubAllEnvs();
    expect(container.querySelector('[data-glow]')).toBeNull();
    expect(container.querySelector('[data-surface="work"]')).not.toBeNull();
  });
});
