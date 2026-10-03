// owned by F3
import type { ReactNode } from 'react';

/**
 * Inspector content of the redact mode (DESIGN 3.38). Returns `null` while the mode or tool is not active, so the standard inspector shows; `useInspector`
 * (src/features/inspector/InspectorBody.tsx) asks it first. F3 fills it. It is a hook, so it may use stores and `useT`.
 */
export function useRedactInspector(): { title: string; body: ReactNode; footer?: ReactNode } | null {
  return null;
}
