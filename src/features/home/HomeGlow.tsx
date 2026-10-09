import { useLayoutEffect, useRef } from 'react';

/** Writes the surface size in px into the layer's CSS variables, so the gradient geometry (tokens.css `--glow-home`) is repainted in full. */
export function applyGlowSize(layer: HTMLElement, width: number, height: number): void {
  layer.style.setProperty('--glow-w', `${Math.round(width)}px`);
  layer.style.setProperty('--glow-h', `${Math.round(height)}px`);
}

/**
 * The home glow (F21.1): a static layer of its own, absolute inside the home main surface. A ResizeObserver on that surface
 * feeds its size in px to the gradient, so every size change (window resize or move) paints the glow completely again.
 * Keeps `data-home-glow` (the acceptance gate compares its rect with the surface's).
 */
export function HomeGlow() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = ref.current;
    const surface = layer?.parentElement;
    if (!layer || !surface) return;
    applyGlowSize(layer, surface.clientWidth, surface.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) applyGlowSize(layer, box.width, box.height);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} aria-hidden="true" data-home-glow="" className="home-glow" />;
}
