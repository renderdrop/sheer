import { Suspense, lazy, useSyncExternalStore } from 'react';

import { Shell } from './features/shell/Shell';

/**
 * Dev-only component showcase at `#showcase` (src/components/showcase). `import.meta.env.DEV` is a build-time constant,
 * so a production build drops both the branch and the lazy chunk.
 */
const Showcase = import.meta.env.DEV ? lazy(() => import('./components/showcase/Showcase')) : null;

function subscribeToHash(notify: () => void): () => void {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

export function App() {
  const showcaseRequested = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash === '#showcase',
    () => false,
  );
  if (Showcase !== null && showcaseRequested) {
    return (
      <Suspense fallback={null}>
        <Showcase />
      </Suspense>
    );
  }
  return <Shell />;
}
