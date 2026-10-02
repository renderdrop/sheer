import { createContext } from 'react';

/**
 * The id of the popover a component is rendered in, `null` outside of one. A surface that React renders inside a popover
 * but that sits elsewhere in the DOM (a submenu, in a portal) takes it as `data-popover-owner`, so the popover's
 * outside-click test counts a click on it as a click inside.
 */
export const PopoverScope = createContext<string | null>(null);

const OWNER_ATTRIBUTE = 'data-popover-owner';

/** The attribute that makes a portaled surface part of the popover `owner` (spread it onto the surface's root element). */
export function ownedBy(owner: string | null): { 'data-popover-owner'?: string } {
  return owner === null ? {} : { [OWNER_ATTRIBUTE]: owner };
}

/** Whether `target` is inside a surface that belongs to the popover `owner` but was portaled out of it. */
export function isInsideOwned(target: Node, owner: string): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return element?.closest(`[${OWNER_ATTRIBUTE}]`)?.getAttribute(OWNER_ATTRIBUTE) === owner;
}
