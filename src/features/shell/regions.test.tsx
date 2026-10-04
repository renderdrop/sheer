// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useRegionCycling } from './regions';

function Fixture({ dialog = false, inspector = true }: { dialog?: boolean; inspector?: boolean }) {
  useRegionCycling();
  return (
    <div>
      <div role="toolbar" aria-label="Tools">
        <button tabIndex={0}>tool-a</button>
        <button tabIndex={-1}>tool-b</button>
      </div>
      <div data-region="banner">
        <span>nothing to focus</span>
      </div>
      <aside data-region="left">
        <button>left-1</button>
        <button>left-2</button>
      </aside>
      <main data-action-scope="canvas">
        <div role="region" aria-label="Pages" tabIndex={0} />
      </main>
      {inspector && (
        <aside data-region="inspector" inert>
          <button>insp</button>
        </aside>
      )}
      <footer>
        <button>status</button>
      </footer>
      {dialog && <div role="dialog">dlg</div>}
    </div>
  );
}

const f6 = (shift = false) => fireEvent.keyDown(window, { key: 'F6', shiftKey: shift });

describe('F6 region cycling (DESIGN 2.3)', () => {
  it('cycles toolbar, left panel, canvas, status bar, skipping empty and inert regions, and wraps', () => {
    render(<Fixture />);
    f6();
    expect(document.activeElement).toBe(screen.getByText('tool-a'));
    f6();
    expect(document.activeElement).toBe(screen.getByText('left-1'));
    f6();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Pages' }));
    f6();
    expect(document.activeElement).toBe(screen.getByText('status'));
    f6();
    expect(document.activeElement).toBe(screen.getByText('tool-a'));
  });

  it('Shift+F6 goes back, and a region restores its last focus', () => {
    render(<Fixture />);
    f6();
    f6();
    screen.getByText('left-2').focus();
    f6();
    f6(true);
    expect(document.activeElement).toBe(screen.getByText('left-2'));
    f6(true);
    expect(document.activeElement).toBe(screen.getByText('tool-a'));
    f6(true);
    expect(document.activeElement).toBe(screen.getByText('status'));
  });

  it('does nothing while a dialog is open', () => {
    render(<Fixture dialog />);
    f6();
    expect(document.activeElement).toBe(document.body);
  });
});
