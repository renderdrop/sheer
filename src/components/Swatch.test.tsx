// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { Dropzone } from './Dropzone';
import { Skeleton } from './Skeleton';
import { Swatch } from './Swatch';

describe('Swatch', () => {
  it('is a 24 px round radio, named, with a check that only shows while chosen', async () => {
    const onClick = vi.fn();
    const { user, getByRole } = setup(<Swatch label="Blue" checked fillClass="bg-stroke-sky" onClick={onClick} />);
    const swatch = getByRole('radio', { name: 'Blue' });
    expect(swatch.getAttribute('aria-checked')).toBe('true');
    expect(swatch.hasAttribute('data-swatch')).toBe(true);
    expect(swatch.className).toContain('size-swatch');
    expect(swatch.className).toContain('rounded-pill');
    expect(swatch.querySelector('svg')?.getAttribute('class')).toContain('group-aria-checked:visible');
    await user.click(swatch);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Skeleton', () => {
  it('is a static Sand block hidden from assistive technology', () => {
    const { container } = setup(<Skeleton shape="line" className="w-24" />);
    const block = container.firstElementChild;
    expect(block?.getAttribute('aria-hidden')).toBe('true');
    expect(block?.className).toContain('bg-subtle');
    expect(block?.className).toContain('rounded-sm');
  });
});

describe('Dropzone', () => {
  it('marks a drag over and hands dropped files to the caller', () => {
    const onDropFiles = vi.fn();
    const { getByText } = setup(<Dropzone onDropFiles={onDropFiles}>Drop a PDF here</Dropzone>);
    const zone = getByText('Drop a PDF here');
    expect(zone.className).toContain('border-dashed');
    const file = new File(['x'], 'a.pdf');
    zone.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    zone.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: { files: [file] } }),
    );
    expect(onDropFiles).toHaveBeenCalledWith([file]);
  });
});
