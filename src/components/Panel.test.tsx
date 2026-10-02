// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { setup } from '../test/render';
import { IconButton } from './IconButton';
import { Panel, PanelSection } from './Panel';

describe('Panel', () => {
  it('is an aside landmark with a name', () => {
    const { getByRole } = setup(<Panel label="Inspector">content</Panel>);
    expect(getByRole('complementary', { name: 'Inspector' }).textContent).toBe('content');
  });

  it('renders title and actions in the header, before the body', () => {
    const { getByRole } = setup(
      <Panel label="Inspector" title="Highlight" actions={<button type="button">Close</button>}>
        body
      </Panel>,
    );
    const heading = getByRole('heading', { name: 'Highlight' });
    expect(heading.tagName).toBe('H2');
    expect(heading.nextElementSibling?.textContent).toBe('Close');
  });

  it('takes a custom header instead of title and actions', () => {
    const { getByRole, queryByRole } = setup(
      <Panel label="Left panel" header={<div role="tablist" aria-label="Views" />}>
        body
      </Panel>,
    );
    expect(getByRole('tablist', { name: 'Views' })).not.toBeNull();
    expect(queryByRole('heading')).toBeNull();
  });

  it('has no header when it has nothing for one', () => {
    const { container } = setup(<Panel label="Plain">body</Panel>);
    expect(container.querySelector('aside')?.children).toHaveLength(1);
  });

  it('is inert while not visible, so it cannot take focus, and takes it back when shown', () => {
    const { getByRole, rerender } = setup(
      <Panel label="Inspector" visible={false}>
        <button type="button">inside</button>
      </Panel>,
    );
    const panel = getByRole('complementary', { hidden: true });
    expect(panel.hasAttribute('inert')).toBe(true);
    rerender(
      <Panel label="Inspector" visible>
        <button type="button">inside</button>
      </Panel>,
    );
    expect(panel.hasAttribute('inert')).toBe(false);
  });

  it('passes other props on, so the shell can add an id for aria-controls', () => {
    const { getByRole } = setup(<Panel label="Left panel" id="left-panel" />);
    expect(getByRole('complementary').id).toBe('left-panel');
  });

  it('holds icon buttons in its header', () => {
    const { getByRole } = setup(<Panel label="P" title="Title" actions={<IconButton label="Sort" size="sm" />} />);
    expect(getByRole('button', { name: 'Sort' })).not.toBeNull();
  });
});

describe('PanelSection', () => {
  it('is a section, named when asked to', () => {
    const { getByRole } = setup(<PanelSection label="Stroke">x</PanelSection>);
    expect(getByRole('region', { name: 'Stroke' }).textContent).toBe('x');
  });
});
