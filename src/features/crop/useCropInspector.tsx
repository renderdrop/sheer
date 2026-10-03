// owned by F2
import type { ReactNode } from 'react';

/**
 * Inspector content of the crop mode (DESIGN 3.37). Returns `null` while the mode or tool is not active, so the standard inspector shows; `useInspector`
 * (src/features/inspector/InspectorBody.tsx) asks it first. F2 fills it. It is a hook, so it may use stores and `useT`.
 */
export function useCropInspector(): { title: string; body: ReactNode; footer?: ReactNode } | null {
  return null;
}
