import type { Quad } from '../../api/wire';
import type { SignatureInfo, SignatureReport } from '../../api/signing';

/** What a signature says about the content, in the words of DESIGN v1.4 S6. */
export type SigState = 'intact' | 'later' | 'changed' | 'unknown';

const ORDER: readonly SigState[] = ['intact', 'later', 'changed', 'unknown'];

/** The state of one signature: the cryptography first, then what was added after it. */
export function stateOf(sig: SignatureInfo): SigState {
  if (sig.cryptographic === 'invalid') return 'changed';
  if (sig.cryptographic !== 'valid') return 'unknown';
  if (sig.coverage.type === 'wholeFile') return 'intact';
  return sig.coverage.verdict === 'disallowed' ? 'changed' : 'later';
}

/** The worst state of all signatures (an empty list is intact: the caller shows nothing for it). */
export function worstOf(sigs: readonly SignatureInfo[]): SigState {
  let worst = 0;
  for (const sig of sigs) worst = Math.max(worst, ORDER.indexOf(stateOf(sig)));
  return ORDER[worst] ?? 'intact';
}

/** Whether a state is one the user must not miss: it also gets the danger outline and colour. */
export const isBad = (state: SigState): boolean => state === 'changed' || state === 'unknown';

// eslint-disable-next-line no-control-regex -- the point is to remove them
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const TEXT_MAX = 128;

/** Text from a certificate or a signature, made safe to show: no control or direction characters, 128 characters at most. */
export function clean(value: string): string {
  const text = value.replace(UNSAFE, '').trim();
  const chars = Array.from(text);
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : text;
}

/** The name of whoever signed: the common name of the certificate, else the field's name. */
export function signerName(sig: SignatureInfo): string {
  const name = sig.signer === null ? '' : clean(sig.signer.subject.commonName);
  return name !== '' ? name : clean(sig.fieldName);
}

/** The signatures a report lists that count as signed (a document timestamp is not somebody's signature, but is still checked). */
export const signaturesOf = (report: SignatureReport | undefined): readonly SignatureInfo[] => report?.signatures ?? [];

/** Whether the identity of any signer is unchecked, so the banner says so. */
export const identityUnchecked = (sigs: readonly SignatureInfo[]): boolean =>
  sigs.some((sig) => sig.signer !== null && sig.trust === 'notTrusted');

/**
 * A widget rectangle as the file writes it (`[llx lly urx ury]`: origin bottom left, y up) as a box of page space (origin top left,
 * y down), for the unrotated page `pageHeight` points high.
 */
export function sealBox(
  rect: { x: number; y: number; w: number; h: number },
  pageHeight: number,
): { x: number; y: number; w: number; h: number } {
  return { x: rect.x, y: pageHeight - rect.y - rect.h, w: rect.w, h: rect.h };
}

/** The seal as a quad for the viewer's jump (page space, y down). */
export function rectQuad(rect: { x: number; y: number; w: number; h: number }): Quad {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ];
}

/** Which later changes a signature's report lists, as keys of `sigcheck.later.*` catalog keys. */
export function laterKeys(sig: SignatureInfo): ('signatures' | 'formFill' | 'annotations' | 'other')[] {
  if (sig.coverage.type !== 'earlierRevision') return [];
  const later = sig.coverage.later;
  const keys: ('signatures' | 'formFill' | 'annotations' | 'other')[] = [];
  if (later.signatures) keys.push('signatures');
  if (later.formFill) keys.push('formFill');
  if (later.annotations) keys.push('annotations');
  if (later.other) keys.push('other');
  return keys;
}
