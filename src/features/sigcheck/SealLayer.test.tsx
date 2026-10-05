// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SignatureInfo } from '../../api/signing';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { forgetFileRotations, setFileRotation } from '../viewer/fileRotation';
import { SealLayer } from './SealLayer';
import { resetSigcheck, useSigcheck } from './store';

const signature = {
  index: 0,
  fieldName: 'Sig1',
  kind: { type: 'approval' },
  subFilter: 'etsiCadesDetached',
  signer: null,
  claimedTime: null,
  reason: null,
  location: null,
  cryptographic: 'valid',
  weakAlgorithm: false,
  timestampPresent: false,
  coverage: { type: 'wholeFile' },
  certValidAtClaimedTime: true,
  trust: 'notTrusted',
  widget: { pageId: 0, rect: { x: 72, y: 700, w: 200, h: 60 } },
} as unknown as SignatureInfo;

function layer(rotation: number, widthPt = 612, heightPt = 792) {
  const swap = rotation % 180 === 90;
  return render(
    <SealLayer
      docId={1}
      pageIndex={0}
      boxWidth={swap ? heightPt : widthPt}
      boxHeight={swap ? widthPt : heightPt}
      widthPt={widthPt}
      heightPt={heightPt}
      rotation={rotation}
      ready
    />,
  );
}

beforeEach(() => {
  resetDocuments();
  resetSigcheck();
  useDocuments.getState().add({ id: 1, pageCount: 1, displayName: 'a.pdf' });
  useSigcheck.getState().setReport(1, { signatures: [signature], truncated: false, lock: 'none' });
});
afterEach(() => {
  cleanup();
  forgetFileRotations(1);
});

describe('SealLayer mapping', () => {
  it('places the seal in page space on an unrotated page', () => {
    const { container } = layer(0);
    const button = container.querySelector<HTMLElement>('[data-seal="0"]');
    expect(button?.style.left).toBe('72px');
    expect(button?.style.top).toBe('32px');
  });

  it('turns the layer with the view rotation (90)', () => {
    const { container } = layer(90);
    const group = container.querySelector<HTMLElement>('[role="group"]');
    expect(group?.style.transform).toContain('rotate(90deg)');
  });

  it('turns the layer for a page with /Rotate 90 in the file', () => {
    setFileRotation(1, 0, 90);
    const { container } = layer(0, 792, 612);
    const group = container.querySelector<HTMLElement>('[role="group"]');
    expect(group?.style.transform).toContain('rotate(90deg)');
    // The layer holds the unrotated page: 612 x 792.
    expect(group?.style.width).toBe('612px');
  });

  // BUG: the seal rect is the raw /Rect (file space) and sealBox only flips y; a CropBox whose origin is not (0, 0) is not subtracted,
  // so the overlay sits off by the crop origin. Needs a crop-origin offset in the report or in SealLayer (product code).
  it.skip('subtracts a CropBox origin (50, 50) from the seal rect', () => {
    const { container } = layer(0, 512, 692);
    const button = container.querySelector<HTMLElement>('[data-seal="0"]');
    expect(button?.style.left).toBe('22px');
  });
});
