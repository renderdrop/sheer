import { useEffect } from 'react';
import { create } from 'zustand';

import { isTextEntry } from '../../lib/textEntry';
import { useUi, type ToolId } from '../../stores/ui';

/**
 * The keys that act as a tool while they are held (Lesen mode, ADR-102): Space is the hand in every tool, Z is the magnifier.
 * Neither works where the user types.
 */
interface LesenState {
  spaceHand: boolean;
  zHeld: boolean;
}

export const useLesen = create<LesenState>(() => ({ spaceHand: false, zHeld: false }));

/** The tool the canvas behaves as: the hand while Space is held, else the active tool. */
export function effectiveTool(tool: ToolId, spaceHand: boolean): ToolId {
  return spaceHand ? 'hand' : tool;
}

export function useEffectiveTool(): ToolId {
  const tool = useUi((state) => state.activeTool);
  const space = useLesen((state) => state.spaceHand);
  return effectiveTool(tool, space);
}

/** Whether the pointer selects text: the Select and Text select tools, never while the hand is (temporarily) active. */
export function textPointer(tool: ToolId): boolean {
  return tool === 'select' || tool === 'textSelect';
}

/** A control that Space presses (a button, a link): the key is its own. */
function isPressable(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('button, a[href], summary, [role="button"], [role="tab"]') !== null
  );
}

/** Space and Z held: listens on the window while the canvas is mounted. Focus loss releases both. */
export function useLesenKeys(): void {
  useEffect(() => {
    const release = () => useLesen.setState({ spaceHand: false, zHeld: false });
    const onDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === ' ') {
        if (isTextEntry(event.target) || isPressable(event.target) || event.isComposing) return;
        // The canvas's own Space would scroll a page; with the hand it is the pan gesture.
        event.preventDefault();
        if (!useLesen.getState().spaceHand) useLesen.setState({ spaceHand: true });
      } else if (event.key === 'z' || event.key === 'Z') {
        if (isTextEntry(event.target) || event.isComposing) return;
        if (!useLesen.getState().zHeld) useLesen.setState({ zHeld: true });
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key === ' ' && useLesen.getState().spaceHand) useLesen.setState({ spaceHand: false });
      else if ((event.key === 'z' || event.key === 'Z') && useLesen.getState().zHeld)
        useLesen.setState({ zHeld: false });
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);
}
