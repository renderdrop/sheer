// @vitest-environment jsdom
import { GalleryVertical, ListTree, MessagesSquare, Search } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setup } from '../test/render';
import { SELECTED_FORCED_COLORS } from './controlStyles';
import { Tab, TabList, TabPanel, Tabs } from './Tabs';

function Demo({
  initial = 'thumbnails',
  disabled,
  onChange,
}: {
  initial?: string;
  disabled?: string;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Tabs
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      >
        <TabList label="Left panel views">
          <Tab value="thumbnails" label="Thumbnails" icon={GalleryVertical} disabled={disabled === 'thumbnails'} />
          <Tab value="outline" label="Outline" icon={ListTree} disabled={disabled === 'outline'} />
          <Tab value="comments" label="Comments" icon={MessagesSquare} disabled={disabled === 'comments'} />
          <Tab value="search" label="Search" icon={Search} shortcut="Ctrl+F" keyShortcuts="Control+F" />
        </TabList>
        <TabPanel value="thumbnails">
          <button type="button">thumb content</button>
        </TabPanel>
        <TabPanel value="outline">outline content</TabPanel>
        <TabPanel value="comments">comments content</TabPanel>
        <TabPanel value="search">search content</TabPanel>
      </Tabs>
      <button type="button">after</button>
    </>
  );
}

const selected = () =>
  Array.from(document.querySelectorAll('[role="tab"]'))
    .filter((tab) => tab.getAttribute('aria-selected') === 'true')
    .map((tab) => tab.getAttribute('aria-label'));

describe('Tabs structure', () => {
  it('is a labelled tablist of tabs, one selected, which is also the only tab stop', () => {
    const { getByRole, getAllByRole } = setup(<Demo />);
    expect(getByRole('tablist', { name: 'Left panel views' }).getAttribute('aria-orientation')).toBe('horizontal');
    const tabs = getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Thumbnails', 'Outline', 'Comments', 'Search']);
    expect(selected()).toEqual(['Thumbnails']);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(getByRole('tab', { name: 'Search' }).getAttribute('aria-keyshortcuts')).toBe('Control+F');
  });

  it('links each tab to its panel in both directions and shows only the selected panel', () => {
    const { getAllByRole, getByRole } = setup(<Demo />);
    for (const tab of getAllByRole('tab')) {
      const panelId = tab.getAttribute('aria-controls');
      const panel = document.getElementById(panelId ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
      expect(panel?.hidden).toBe(tab.getAttribute('aria-selected') !== 'true');
    }
    expect(getByRole('tabpanel', { name: 'Thumbnails' })).not.toBeNull();
  });
});

describe('Tabs keyboard', () => {
  it('selects with ArrowRight and ArrowLeft as focus moves (automatic activation)', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Demo onChange={onChange} />);
    await user.tab();
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Thumbnails' }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Outline' }));
    expect(selected()).toEqual(['Outline']);
    expect(getByRole('tab', { name: 'Outline' }).tabIndex).toBe(0);
    expect(getByRole('tab', { name: 'Thumbnails' }).tabIndex).toBe(-1);
    expect(getByRole('tabpanel').textContent).toBe('outline content');
    await user.keyboard('{ArrowLeft}');
    expect(selected()).toEqual(['Thumbnails']);
    expect(onChange).toHaveBeenNthCalledWith(1, 'outline');
    expect(onChange).toHaveBeenNthCalledWith(2, 'thumbnails');
  });

  it('wraps around at both ends', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Search' }));
    expect(selected()).toEqual(['Search']);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Thumbnails' }));
    expect(selected()).toEqual(['Thumbnails']);
  });

  it('jumps with Home and End', async () => {
    const { user } = setup(<Demo initial="outline" />);
    await user.tab();
    await user.keyboard('{End}');
    expect(selected()).toEqual(['Search']);
    await user.keyboard('{Home}');
    expect(selected()).toEqual(['Thumbnails']);
  });

  it('enters the panel with Tab', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(getByRole('tabpanel'));
    await user.tab();
    expect(document.activeElement).toBe(getByRole('button', { name: 'thumb content' }));
  });

  it('reaches a disabled tab without selecting it', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Demo disabled="outline" onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Outline' }));
    expect(getByRole('tab', { name: 'Outline' }).getAttribute('aria-disabled')).toBe('true');
    expect(selected()).toEqual(['Thumbnails']);
    expect(onChange).not.toHaveBeenCalled();
    await user.click(getByRole('tab', { name: 'Outline' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Tabs pointer', () => {
  it('selects a tab on click', async () => {
    const { user, getByRole } = setup(<Demo />);
    await user.click(getByRole('tab', { name: 'Comments' }));
    expect(selected()).toEqual(['Comments']);
    expect(getByRole('tabpanel').textContent).toBe('comments content');
  });
});

describe('Tabs disabled edge cases', () => {
  it('does not select a focused disabled tab with Enter or Space', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Demo disabled="outline" onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Outline' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onChange).not.toHaveBeenCalled();
    expect(selected()).toEqual(['Thumbnails']);
    expect(getByRole('tabpanel').textContent).toBe('thumb content');
  });

  it('moves on from a disabled tab to the next enabled one and selects that', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Demo disabled="outline" onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Comments' }));
    expect(selected()).toEqual(['Comments']);
    expect(onChange.mock.calls).toEqual([['comments']]);
  });

  it('reaches a disabled first tab with End and Home without selecting it, and keeps one tab stop', async () => {
    const { user, getByRole } = setup(<Demo initial="comments" disabled="thumbnails" />);
    await user.tab();
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Comments' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Thumbnails' }));
    expect(selected()).toEqual(['Comments']);
    const stops = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
      (tab) => tab.tabIndex === 0,
    );
    expect(stops).toEqual([getByRole('tab', { name: 'Comments' })]);
    await user.keyboard('{End}');
    expect(selected()).toEqual(['Search']);
  });

  it('does not select a disabled tab by a click either, and leaves the panel alone', async () => {
    const onChange = vi.fn();
    const { user, getByRole } = setup(<Demo disabled="comments" onChange={onChange} />);
    await user.click(getByRole('tab', { name: 'Comments' }));
    await user.dblClick(getByRole('tab', { name: 'Comments' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(getByRole('tabpanel').textContent).toBe('thumb content');
  });
});

describe('Tabs forced colors', () => {
  it('gives the selected fill a border cue, because its ring is a box-shadow that forced colors drops', () => {
    setup(<Demo />);
    const indicator = document.querySelector('[role="tab"][aria-selected="true"] > span[aria-hidden="true"]');
    expect(indicator).not.toBeNull();
    const classes = (indicator?.className ?? '').split(/\s+/);
    expect(classes).toContain('inset-ring-accent');
    for (const cue of SELECTED_FORCED_COLORS.split(' ')) expect(classes, cue).toContain(cue);
  });
});
