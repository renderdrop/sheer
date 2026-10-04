// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { creationKind, familyOf, parseDefaults, toolNameKey, useTools } from './tools';

beforeEach(() => {
  localStorage.clear();
  useTools.setState({ markup: 'highlight', shapes: 'rect' });
});

describe('variants', () => {
  it('cycle through the family and wrap', () => {
    const { cycle } = useTools.getState();
    cycle('highlight');
    expect(useTools.getState().markup).toBe('underline');
    cycle('highlight');
    cycle('highlight');
    expect(useTools.getState().markup).toBe('highlight');
    for (let i = 0; i < 3; i += 1) cycle('shapes');
    expect(useTools.getState().shapes).toBe('arrow');
    cycle('shapes');
    expect(useTools.getState().shapes).toBe('rect');
  });

  it('are remembered', () => {
    useTools.getState().setShapes('ellipse');
    expect(JSON.parse(localStorage.getItem('sheer.toolVariants') ?? '{}')).toMatchObject({ shapes: 'ellipse' });
  });
});

describe('what the active tool makes', () => {
  const tools = { markup: 'strikeout', shapes: 'line' } as const;
  it('follows the variant for Markup and Shapes', () => {
    expect(creationKind('highlight', tools)).toBe('strikeout');
    expect(creationKind('shapes', tools)).toBe('line');
    expect(creationKind('note', tools)).toBe('note');
    expect(creationKind('text', tools)).toBe('freeText');
    expect(creationKind('draw', tools)).toBe('ink');
  });

  it('is nothing for Select and the tools that make no annotation', () => {
    for (const tool of ['select', 'form', 'signature', 'pages'] as const) expect(creationKind(tool, tools)).toBeNull();
  });

  it('names the tool by its variant', () => {
    expect(toolNameKey('highlight', tools)).toBe('tool.strike');
    expect(toolNameKey('shapes', tools)).toBe('tool.line');
    expect(toolNameKey('select', tools)).toBeNull();
    expect(familyOf('highlight')).toBe('highlight');
    expect(familyOf('draw')).toBeNull();
  });
});

describe('the defaults of the next annotation (DESIGN v2 3.3)', () => {
  it('start empty (the first-run values are the kind defaults) and remember the last change per kind', () => {
    useTools.setState({ defaults: {} });
    expect(useTools.getState().defaults).toEqual({});
    useTools.getState().setDefault('ink', { width: 4 });
    useTools.getState().setDefault('ink', { color: [225, 92, 134] });
    expect(useTools.getState().defaults.ink).toEqual({ width: 4, color: [225, 92, 134] });
    expect(JSON.parse(localStorage.getItem('sheer.toolDefaults') ?? 'null')).toMatchObject({ ink: { width: 4 } });
  });

  it('drops stored values that are not valid', () => {
    expect(
      parseDefaults({ ink: { width: 4, color: [300, 0, 0], head: 'spear' }, bogus: { width: 2 }, note: 'x' }),
    ).toEqual({ ink: { width: 4 } });
    expect(parseDefaults(null)).toEqual({});
  });
});
