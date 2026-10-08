import { describe, expect, it } from 'vitest';

// @ts-expect-error plain .mjs without types
import * as v from './accept/v20-pure.mjs';

describe('frame statistics', () => {
  it('computes quantiles like cdp.mjs fps', () => {
    expect(v.quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(v.quantile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(v.quantile([], 0.5)).toBeNaN();
  });

  it('judges a steady 60 Hz run as inside the budget', () => {
    const s = v.frameStats(Array.from({ length: 120 }, () => 16.67));
    expect(s.avgFps).toBeGreaterThan(59.9);
    expect(v.judgeFrames(s).ok).toBe(true);
  });

  it('flags slow frames and too few frames', () => {
    const slow = v.frameStats([...Array.from({ length: 90 }, () => 16.6), ...Array.from({ length: 10 }, () => 40)]);
    const j = v.judgeFrames(slow);
    expect(j.ok).toBe(false);
    expect(j.why).toContain('p95');
    expect(v.judgeFrames(v.frameStats([16, 16])).ok).toBe(false);
  });

  it('formats a table with verdicts', () => {
    const t = v.formatPerfTable([
      { name: 'open', value: '420 ms', budget: '< 1000 ms', ok: true },
      { name: 'zoom', value: 'p95 31 ms', budget: '<= 20 ms', ok: false, why: 'p95' },
    ]);
    expect(t).toContain('PASS');
    expect(t).toContain('FAIL (p95)');
  });
});

describe('image-only pdf builder', () => {
  const fakePdf = (n: number) => {
    // Mimics make_scan_fixtures output: image dictionary with Length, then the stream.
    let s = '%PDF-1.7\n1 0 obj\n<</Type/Pages/Kids[]/Count 0>>\nendobj\n';
    for (let i = 0; i < n; i++)
      s += `${2 + i} 0 obj\n<</Type/XObject/Subtype/Image/Width 2/Height 2/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode/Length 4>>stream\nAB${i}\n\nendstream\nendobj\n`;
    return Buffer.from(s, 'latin1');
  };

  it('extracts the image streams only', () => {
    const imgs = v.extractImageStreams(fakePdf(3));
    expect(imgs).toHaveLength(3);
    expect(imgs[1].data.toString('latin1')).toBe('AB1\n');
    expect(imgs[0].dict).toContain('/Subtype/Image');
    expect(imgs[0].dict).not.toContain('/Length');
  });

  it('builds N pages cycling the images with a consistent xref', () => {
    const imgs = v.extractImageStreams(fakePdf(3));
    const pdf: Buffer = v.buildImageOnlyPdf(imgs, 10);
    const text = pdf.toString('latin1');
    expect(text).toContain('/Count 10');
    expect(text.match(/\/Type\/Page\//g)).toHaveLength(10);
    const start = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    // every xref offset points at "<n> 0 obj"
    const rows = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    rows.forEach((off, i) => expect(text.slice(off, off + 10)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(() => v.buildImageOnlyPdf([], 3)).toThrow();
  });
});

const node = (
  role: string,
  name: string,
  props: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  nodeId: `${role}-${name}`,
  ignored: false,
  role: { value: role },
  name: { value: name },
  properties: Object.entries(props).map(([k, val]) => ({ name: k, value: { value: val } })),
  ...extra,
});

describe('AX tree audit', () => {
  it('passes a well-formed tree', () => {
    const nodes = [
      node('RootWebArea', ''),
      node('button', 'Zoom in', { focusable: true }),
      node('tab', 'Read', { focusable: true, selected: true }),
      node('checkbox', 'Bold', { focusable: true, checked: 'false' }),
      node('button', 'More', { focusable: true, hasPopup: 'menu', expanded: false }),
      node('dialog', 'Settings', { modal: true }),
      node('status', ''),
    ];
    expect(v.auditAxNodes(nodes)).toEqual([]);
  });

  it('reports missing names, roles and states', () => {
    const rules = v
      .auditAxNodes([
        node('button', '', { focusable: true }),
        node('generic', '', { focusable: true }),
        node('switch', 'Dark', { focusable: true }),
        node('button', 'Menu', { focusable: true, hasPopup: 'menu' }),
        node('tab', 'Edit', { focusable: true }),
        node('dialog', '', {}),
      ])
      .map((x: { rule: string }) => x.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'name',
        'focusable-role',
        'checked',
        'expanded',
        'selected',
        'dialog-name',
        'dialog-modal',
      ]),
    );
  });

  it('skips ignored nodes, disabled popup triggers and the modal rule on request', () => {
    const ignored = { ...node('button', '', { focusable: true }), ignored: true };
    expect(v.auditAxNodes([ignored])).toEqual([]);
    expect(v.auditAxNodes([node('button', 'X', { hasPopup: 'menu', disabled: true })])).toEqual([]);
    expect(v.auditAxNodes([node('dialog', 'A', {})], { skipModal: true })).toEqual([]);
  });
});

describe('keyboard helpers', () => {
  it('detects a focus indicator', () => {
    expect(v.hasFocusIndicator({ outlineStyle: 'solid', outlineWidth: '2px', boxShadow: 'none' })).toBe(true);
    expect(
      v.hasFocusIndicator({ outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'rgb(1,2,3) 0px 0px 0px 2px' }),
    ).toBe(true);
    expect(v.hasFocusIndicator({ outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'none' })).toBe(false);
    expect(v.hasFocusIndicator({ outlineStyle: 'solid', outlineWidth: '0px', boxShadow: '' })).toBe(false);
  });

  it('accepts roving members when a sibling was reached', () => {
    const controls = [
      { name: 'a', seen: true, composite: 'bar' },
      { name: 'b', seen: false, composite: 'bar' },
      { name: 'c', seen: false, composite: null },
      { name: 'd', seen: false, composite: 'other' },
    ];
    expect(v.unreachable(controls)).toEqual(['c', 'd']);
  });

  it('skips destructive menu items', () => {
    expect(v.SKIP_ITEM.test('Dokument schließen')).toBe(true);
    expect(v.SKIP_ITEM.test('Print…')).toBe(true);
    expect(v.SKIP_ITEM.test('Einstellungen…')).toBe(false);
  });

  it('summarises axe results and rolls up screens', () => {
    const s = v.summariseAxe({
      violations: [{ id: 'color-contrast', impact: 'serious', help: 'h', nodes: [{ target: ['#a', 'span'] }] }],
      incomplete: [{}, {}],
    });
    expect(s.violations[0]).toMatchObject({ id: 'color-contrast', nodes: 1, targets: ['#a span'] });
    expect(s.incomplete).toBe(2);
    expect(v.rollUp([{ violations: [{ rule: 'name' }, { rule: 'name' }] }, { violations: [] }])).toEqual({
      screens: 2,
      violations: 2,
      byRule: { name: 2 },
    });
  });
});
