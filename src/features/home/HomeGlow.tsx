import { useLayoutEffect, useRef } from 'react';

/**
 * Writes the surface size and the window width in px into the layer's CSS variables, so the gradient geometry
 * (tokens.css `--glow-home`: radius max(0.6 × `--glow-win-w`, 0.75 × `--glow-w`)) is repainted in full.
 */
export function applyGlowSize(
  layer: HTMLElement,
  width: number,
  height: number,
  windowWidth: number = window.innerWidth,
): void {
  layer.style.setProperty('--glow-w', `${Math.round(width)}px`);
  layer.style.setProperty('--glow-h', `${Math.round(height)}px`);
  layer.style.setProperty('--glow-win-w', `${Math.round(windowWidth)}px`);
}

/**
 * The home glow (F21.1, F22.1): a static layer of its own, absolute inside the home main surface. A ResizeObserver on that surface
 * (and the window `resize` event) feeds its size and the window width in px to the gradient, so every size change paints the glow completely again.
 * Keeps `data-home-glow` (the acceptance gate compares its rect with the surface's).
 */
export function HomeGlow() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = ref.current;
    const surface = layer?.parentElement;
    if (!layer || !surface) return;
    applyGlowSize(layer, surface.clientWidth, surface.clientHeight);
    const onResize = () => applyGlowSize(layer, surface.clientWidth, surface.clientHeight);
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', onResize);
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) applyGlowSize(layer, box.width, box.height);
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return <div ref={ref} aria-hidden="true" data-home-glow="" className="home-glow" />;
}
