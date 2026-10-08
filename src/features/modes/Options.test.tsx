// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { InsertOptions, RedactOptions } from './Options';

afterEach(() => {
  useUi.setState({ activeTool: 'select' });
});

describe('the options of the Bearbeiten tools in a popover (Q7)', () => {
  it('the text and redact options size to content between the minimum and the popover cap', () => {
    for (const View of [InsertOptions, RedactOptions]) {
      const { container, unmount } = setup(<View />);
      const root = container.firstElementChild;
      expect(root?.className).toContain('w-max');
      expect(root?.className).toContain('max-w-(--options-inner-max)');
      expect(root?.className).not.toContain('p-4');
      unmount();
    }
  });

  it('the font segments keep their whole label and wrap instead of cutting it', () => {
    useUi.setState({ activeTool: 'textBox' });
    setup(<InsertOptions />);
    const group = screen.getByRole('radiogroup', { name: 'Font' });
    expect(group.className).toContain('flex-wrap');
    for (const radio of screen.getAllByRole('radio', { hidden: true }).filter((r) => group.contains(r))) {
      expect(radio.className).toContain('whitespace-nowrap');
      expect(radio.querySelector('.truncate')).toBeNull();
    }
  });
});
