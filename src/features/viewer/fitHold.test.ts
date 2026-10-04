import { describe, expect, it } from 'vitest';

import { armFitHold, consumeFitHold, opensToolInspector } from './fitHold';

const base = { activeTool: 'select', inspector: 'auto', leftPanelCollapsed: false, leftPanelWidth: 240 };

describe('fit hold (ADR-056)', () => {
  it('flags a tool change that opens or closes the tool inspector, not a panel toggle or a tool-to-tool switch', () => {
    expect(opensToolInspector(base, { ...base, activeTool: 'highlight' })).toBe(true);
    expect(opensToolInspector({ ...base, activeTool: 'note' }, base)).toBe(true);
    expect(opensToolInspector({ ...base, activeTool: 'note' }, { ...base, activeTool: 'draw' })).toBe(false);
    expect(opensToolInspector(base, { ...base, activeTool: 'pages' })).toBe(false);
    expect(opensToolInspector(base, { ...base, activeTool: 'note', inspector: 'open' })).toBe(false);
    expect(opensToolInspector(base, { ...base, activeTool: 'note', leftPanelCollapsed: true })).toBe(false);
  });

  it('holds for the next size report only, and times out', () => {
    armFitHold(1000);
    expect(consumeFitHold(1100)).toBe(true);
    expect(consumeFitHold(1200)).toBe(false);
    armFitHold(1000);
    expect(consumeFitHold(5000)).toBe(false);
  });
});
