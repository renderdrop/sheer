// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usePanelSlide } from './usePanelSlide';

describe('usePanelSlide (MOTION 4.2)', () => {
  it('slides in from the leading edge by its width and the gutter, and out the same way', () => {
    const { result } = renderHook(() => usePanelSlide('start', 240));
    expect(result.current.initial).toMatchObject({ x: -248, opacity: 0 });
    expect(result.current.animate).toMatchObject({ x: 0, opacity: 1 });
    expect(result.current.exit).toMatchObject({ x: -248, opacity: 0 });
  });

  it('slides in from the trailing edge for the inspector', () => {
    const { result } = renderHook(() => usePanelSlide('end', 288));
    expect(result.current.initial).toMatchObject({ x: 296, opacity: 0 });
  });
});
