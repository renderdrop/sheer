// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { runAction } from '../../actions/dispatch';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { TopBar } from './TopBar';

beforeEach(() => {
  resetDocuments();
  useView.setState({ byDoc: {} });
  useDocuments.getState().add({ id: 1, pageCount: 3, displayName: 'A.pdf' });
  useView.getState().open(1, 3);
  useUi.setState({ leftPanelCollapsed: false, view: 'editor' });
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
});

describe('the sidebar toggle (DESIGN 3.5 B2)', () => {
  it('sits after Back, is pressed while the sidebar is open and follows the remembered state', async () => {
    const { user } = setup(<TopBar trafficLightInset={false} />);
    const toggle = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('page-sidebar');
    expect(toggle.previousElementSibling ?? toggle.parentElement?.previousElementSibling).not.toBeNull();
    await user.click(toggle);
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
    const shown = screen.getByRole('button', { name: 'Show sidebar' });
    expect(shown.getAttribute('aria-pressed')).toBe('false');
    // View > Sidebar (the same action) and the key bring it back, and the button follows.
    act(() => void runAction('toggle-left-panel'));
    expect(useUi.getState().leftPanelCollapsed).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide sidebar' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(useUi.getState().leftPanelCollapsed).toBe(true);
  });
});
