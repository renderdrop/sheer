// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dropzone } from './Dropzone';

describe('Dropzone', () => {
  const zone = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it('marks itself while a drag is over and clears it when the drag leaves (nested enters balance)', () => {
    const { container } = render(
      <Dropzone>
        <span>inside</span>
      </Dropzone>,
    );
    fireEvent.dragEnter(zone(container));
    fireEvent.dragEnter(zone(container));
    expect(zone(container).hasAttribute('data-dragover')).toBe(true);
    expect(zone(container).className).toContain('border-control-border');
    fireEvent.dragLeave(zone(container));
    expect(zone(container).hasAttribute('data-dragover')).toBe(true);
    fireEvent.dragLeave(zone(container));
    expect(zone(container).hasAttribute('data-dragover')).toBe(false);
    expect(zone(container).className).toContain('border-divider');
  });

  it('hands the dropped files to the caller and resets', () => {
    const onDropFiles = vi.fn();
    const { container } = render(<Dropzone onDropFiles={onDropFiles}>x</Dropzone>);
    const file = new File(['a'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.dragEnter(zone(container));
    fireEvent.drop(zone(container), { dataTransfer: { files: [file] } });
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(zone(container).hasAttribute('data-dragover')).toBe(false);
  });
});
