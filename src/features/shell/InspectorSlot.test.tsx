// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { INSPECTOR } from '../../components/tokens';
import { setup } from '../../test/render';
import { useUi } from '../../stores/ui';
import { InspectorSlot } from './InspectorSlot';

const initial = useUi.getState();
afterEach(() => {
  useUi.setState({ ...initial }, true);
});

describe('the inspector splitter (F20.8)', () => {
  it('is on the slot only while it is open', () => {
    const { queryByRole, rerender } = setup(<InspectorSlot open={false} style={{}} />);
    expect(queryByRole('separator')).toBeNull();
    rerender(<InspectorSlot open style={{}} />);
    expect(queryByRole('separator', { name: 'Resize tool inspector' })).not.toBeNull();
  });

  it('resizes with the keys inside 240 to 480 and keeps the width', () => {
    const { getByRole } = setup(<InspectorSlot open style={{}} />);
    const separator = getByRole('separator');
    expect(separator.getAttribute('aria-valuenow')).toBe(String(INSPECTOR.default));
    // The pane is right of the separator: Left widens it, Right narrows it.
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(useUi.getState().inspectorWidth).toBe(INSPECTOR.default + INSPECTOR.step);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(useUi.getState().inspectorWidth).toBe(INSPECTOR.max);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(useUi.getState().inspectorWidth).toBe(INSPECTOR.min);
    fireEvent.keyDown(separator, { key: 'Enter' });
    expect(useUi.getState().inspectorWidth).toBe(INSPECTOR.min);
  });

  it('a double click resets to 300', () => {
    useUi.getState().setInspectorWidth(400);
    const { getByRole } = setup(<InspectorSlot open style={{}} />);
    fireEvent.doubleClick(getByRole('separator'));
    expect(useUi.getState().inspectorWidth).toBe(INSPECTOR.default);
  });
});
