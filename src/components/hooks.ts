import { useCallback, useState } from 'react';

/**
 * State that the parent may own. With `value` the component is controlled and `onChange` is the only way to change it;
 * without, it keeps `defaultValue` itself and still reports changes.
 */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [controlled ? value : inner, set];
}

/** Whether the element is a keyboard focus target right now (`:focus-visible`); true where the engine cannot tell. */
export function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}
