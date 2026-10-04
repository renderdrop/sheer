import { Suspense, lazy, useSyncExternalStore } from 'react';

import { Shell } from './features/shell/Shell';
import { PrintSurface } from './features/print/PrintSurface';

/**
 * Dev-only component page at `/dev/components` (and `#showcase`; src/components/showcase). `import.meta.env.DEV` is a build-time constant,
 * so a production build drops both the branch and the lazy chunk.
 */
const Showcase = import.meta.env.DEV ? lazy(() => import('./components/showcase/Showcase')) : null;

export function isShowcaseLocation(location: Pick<Location, 'pathname' | 'hash'>): boolean {
  return location.pathname.replace(/\/+$/, '') === '/dev/components' || location.hash === '#showcase';
}

function subscribeToLocation(notify: () => void): () => void {
  window.addEventListener('hashchange', notify);
  window.addEventListener('popstate', notify);
  return () => {
    window.removeEventListener('hashchange', notify);
    window.removeEventListener('popstate', notify);
  };
}

export function App() {
  const showcaseRequested = useSyncExternalStore(
    subscribeToLocation,
    () => isShowcaseLocation(window.location),
    () => false,
  );
  if (Showcase !== null && showcaseRequested) {
    return (
      <Suspense fallback={null}>
        <Showcase />
      </Suspense>
    );
  }
  return (
    <>
      <Shell />
      <PrintSurface />
    </>
  );
}
