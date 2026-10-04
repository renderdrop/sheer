import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';

import { cx } from './cx';

/** Which surface mode (DESIGN v2 section 5) a subtree is in; `null` outside both. */
export type SurfaceMode = 'brand' | 'work' | null;

export const SurfaceContext = createContext<SurfaceMode>(null);

/** The surface mode of the nearest `BrandSurface` or `WorkSurface`. */
export const useSurfaceMode = (): SurfaceMode => useContext(SurfaceContext);

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** Home, empty state, splash and Welcome: the only places a `SolarGlow` may render. */
export function BrandSurface({ className, children, ...rest }: SurfaceProps) {
  return (
    <SurfaceContext.Provider value="brand">
      <div data-surface="brand" className={cx(className)} {...rest}>
        {children}
      </div>
    </SurfaceContext.Provider>
  );
}

/** The whole editor: renders no glow. A `SolarGlow` inside it throws in dev and renders nothing in production. */
export function WorkSurface({ className, children, ...rest }: SurfaceProps) {
  return (
    <SurfaceContext.Provider value="work">
      <div data-surface="work" className={cx(className)} {...rest}>
        {children}
      </div>
    </SurfaceContext.Provider>
  );
}
