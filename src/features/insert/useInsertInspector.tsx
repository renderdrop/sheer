// owned by F1
import type { ReactNode } from 'react';

/**
 * Inspector content of the Add text and Add image tools (DESIGN 3.36). Returns `null` while the mode or tool is not active, so the standard inspector shows; `useInspector`
 * (src/features/inspector/InspectorBody.tsx) asks it first. F1 fills it. It is a hook, so it may use stores and `useT`.
 */
export function useInsertInspector(): { title: string; body: ReactNode; footer?: ReactNode } | null {
  return null;
}
