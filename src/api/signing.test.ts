import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDocumentInfo } from './documents';
import { rustConstants } from './limits.testutil';
import {
  createSigningIdentity,
  deleteSigningIdentity,
  discardIdentityImport,
  exportSigningCertificate,
  fitsNewIdentity,
  IDENTITIES_MAX,
  IDENTITY_EMAIL_MAX,
  IDENTITY_NAME_MAX,
  IDENTITY_ORG_MAX,
  importSigningIdentity,
  isFingerprint,
  isIdentityId,
  listSigningIdentities,
  listTrustedSigners,
  openSignedRevision,
  parseSignatureInfo,
  parseSignatureReport,
  parseSigningIdentities,
  parseSigningIdentity,
  parseTrustedSigners,
  pickIdentityFile,
  removeTrustedSigner,
  saveUnsignedCopy,
  sealBoxFits,
  SEAL_LOCATION_MAX,
  SEAL_REASON_MAX,
  setSignerTrust,
  signDocument,
  SIGS_PER_DOC_MAX,
  SIG_FIELD_NAME_MAX,
  TRUSTED_SIGNERS_MAX,
  validateSignatures,
  type SignRequest,
} from './signing';
import { catalogs } from '../i18n/catalog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const NOT_YET = {
  code: 'unsupported_feature',
  key: 'error.unsupported_feature',
  retryable: false,
  params: { what: 'notYet' },
};

const ID = 'ab'.repeat(16);
const FP = 'cd'.repeat(32);
const NAME = { commonName: 'Ada Lovelace', organization: null, email: 'ada@example.org' };
const CERT = {
  subject: NAME,
  issuer: NAME,
  selfSigned: true,
  notBefore: '2026-10-05T08:00:00Z',
  notAfter: '2029-10-05T08:05:00Z',
  serialHex: '0a1b2c',
  fingerprintSha256: FP,
};
const IDENTITY = { ...CERT, id: ID, source: 'generated', key: { type: 'ecP256' }, chainLength: 1, expired: false };
const RECT = { x: 10, y: 20, w: 192, h: 64 };
const LATER = { signatures: false, formFill: true, annotations: false, other: false };
const SIGNATURE = {
  index: 0,
  fieldName: 'Signature1',
  kind: { type: 'certification', p: 2 },
  subFilter: 'etsiCadesDetached',
  signer: CERT,
  claimedTime: '2026-10-05T10:15:00+02:00',
  reason: 'I approve',
  location: null,
  cryptographic: 'valid',
  weakAlgorithm: false,
  timestampPresent: false,
  coverage: { type: 'earlierRevision', revision: 1, later: LATER, verdict: 'allowed' },
  certValidAtClaimedTime: true,
  trust: 'ownIdentity',
  widget: { pageId: 0, rect: RECT },
};
const REPORT = { signatures: [SIGNATURE], truncated: false, lock: 'fillAndSign' };

const SAVE_RESULT = {
  rev: 1,
  mode: 'incremental',
  backupCreated: false,
  warnings: [],
  document: { id: 4, pageCount: 2, displayName: 'a (signed).pdf', kind: 'user', signatureLock: 'fillAndSign' },
  changes: {
    rev: 1,
    upserted: [],
    removed: [],
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, dirty: false },
  },
};

describe('identities', () => {
  it('reads an identity and drops unknown keys', () => {
    expect(parseSigningIdentity({ ...IDENTITY, privateKey: 'x' })).toEqual(IDENTITY);
    expect(parseSigningIdentity({ ...IDENTITY, key: { type: 'rsa', bits: 3072 }, source: 'imported' })).toMatchObject({
      key: { type: 'rsa', bits: 3072 },
      source: 'imported',
    });
  });

  it('refuses a malformed identity', () => {
    for (const bad of [
      { ...IDENTITY, id: 'AB'.repeat(16) },
      { ...IDENTITY, id: 'ab' },
      { ...IDENTITY, source: 'cloud' },
      { ...IDENTITY, key: { type: 'rsa' } },
      { ...IDENTITY, key: { type: 'dsa' } },
      { ...IDENTITY, chainLength: 0 },
      { ...IDENTITY, chainLength: 9 },
      { ...IDENTITY, expired: 'no' },
      { ...IDENTITY, notAfter: 'tomorrow' },
      { ...IDENTITY, fingerprintSha256: 'abc' },
      { ...IDENTITY, serialHex: '' },
      { ...IDENTITY, serialHex: 'xyz' },
      { ...IDENTITY, subject: { ...NAME, commonName: 'x'.repeat(129) } },
      { ...IDENTITY, issuer: null },
      null,
      [],
    ]) {
      expect(parseSigningIdentity(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads the store and refuses more than eight items or an unknown status', () => {
    expect(parseSigningIdentities({ status: 'ready', items: [IDENTITY] })?.items).toHaveLength(1);
    expect(parseSigningIdentities({ status: 'empty', items: [] })).toEqual({ status: 'empty', items: [] });
    expect(parseSigningIdentities({ status: 'locked', items: [] })?.status).toBe('locked');
    expect(
      parseSigningIdentities({ status: 'ready', items: Array.from({ length: IDENTITIES_MAX + 1 }, () => IDENTITY) }),
    ).toBeNull();
    expect(parseSigningIdentities({ status: 'broken', items: [] })).toBeNull();
    expect(parseSigningIdentities({ status: 'ready', items: [{ ...IDENTITY, id: 1 }] })).toBeNull();
  });

  it('calls the commands with the documented arguments', async () => {
    invokeMock.mockResolvedValueOnce({ status: 'ready', items: [IDENTITY] });
    await expect(listSigningIdentities()).resolves.toMatchObject({ status: 'ready' });
    expect(invokeMock).toHaveBeenLastCalledWith('list_signing_identities', undefined);

    invokeMock.mockResolvedValueOnce(IDENTITY);
    const spec = { name: 'Ada', email: null, organization: null };
    await expect(createSigningIdentity(spec)).resolves.toEqual(IDENTITY);
    expect(invokeMock).toHaveBeenLastCalledWith('create_signing_identity', { spec });

    invokeMock.mockResolvedValueOnce(IDENTITY);
    await importSigningIdentity(7, 'secret');
    expect(invokeMock).toHaveBeenLastCalledWith('import_signing_identity', { ticket: 7, password: 'secret' });

    invokeMock.mockResolvedValueOnce(undefined);
    await discardIdentityImport(7);
    expect(invokeMock).toHaveBeenLastCalledWith('discard_identity_import', { ticket: 7 });

    invokeMock.mockResolvedValueOnce(undefined);
    await deleteSigningIdentity(ID);
    expect(invokeMock).toHaveBeenLastCalledWith('delete_signing_identity', { identityId: ID });

    invokeMock.mockResolvedValueOnce(false);
    await expect(exportSigningCertificate(ID)).resolves.toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith('export_signing_certificate', { identityId: ID });
  });

  it('picks a file: a ticket or null, and nothing path-like is asked for', async () => {
    invokeMock.mockResolvedValueOnce({ ticket: 3, displayName: 'me.p12' });
    await expect(pickIdentityFile()).resolves.toEqual({ ticket: 3, displayName: 'me.p12' });
    invokeMock.mockResolvedValueOnce(null);
    await expect(pickIdentityFile()).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce({ ticket: -1, displayName: 'me.p12' });
    await expect(pickIdentityFile()).rejects.toMatchObject({ code: 'internal' });
  });

  it('turns a malformed answer into an internal error and a rejection into an AppError', async () => {
    invokeMock.mockResolvedValueOnce({ status: 'ready', items: 'no' });
    await expect(listSigningIdentities()).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockResolvedValueOnce('yes');
    await expect(exportSigningCertificate(ID)).rejects.toMatchObject({ code: 'internal' });
    invokeMock.mockRejectedValueOnce(NOT_YET);
    await expect(listSigningIdentities()).rejects.toMatchObject({
      code: 'unsupported_feature',
      params: { what: 'notYet' },
    });
  });

  it('checks ids, fingerprints, new identities and seal boxes', () => {
    expect(isIdentityId(ID)).toBe(true);
    expect(isIdentityId('ABCD')).toBe(false);
    expect(isFingerprint(FP)).toBe(true);
    expect(isFingerprint(ID)).toBe(false);
    expect(fitsNewIdentity({ name: 'Ada', email: null, organization: null })).toBe(true);
    expect(fitsNewIdentity({ name: '  ', email: null, organization: null })).toBe(false);
    expect(fitsNewIdentity({ name: 'x'.repeat(IDENTITY_NAME_MAX + 1), email: null, organization: null })).toBe(false);
    expect(fitsNewIdentity({ name: 'a', email: 'x'.repeat(IDENTITY_EMAIL_MAX + 1), organization: null })).toBe(false);
    expect(fitsNewIdentity({ name: 'a', email: null, organization: 'x'.repeat(IDENTITY_ORG_MAX + 1) })).toBe(false);
    expect(sealBoxFits({ x: 0, y: 0, w: 72, h: 24 })).toBe(true);
    expect(sealBoxFits({ x: 0, y: 0, w: 71, h: 24 })).toBe(false);
    expect(sealBoxFits({ x: 0, y: 0, w: 72, h: 23 })).toBe(false);
  });
});

describe('signatures', () => {
  it('reads a signature and a report', () => {
    expect(parseSignatureInfo(SIGNATURE)).toEqual(SIGNATURE);
    expect(parseSignatureReport(REPORT)).toEqual(REPORT);
    expect(
      parseSignatureInfo({
        ...SIGNATURE,
        kind: { type: 'approval' },
        signer: null,
        claimedTime: null,
        reason: null,
        coverage: { type: 'wholeFile' },
        widget: null,
        cryptographic: 'malformed',
        trust: 'notTrusted',
      }),
    ).toMatchObject({ kind: { type: 'approval' }, signer: null, widget: null, coverage: { type: 'wholeFile' } });
  });

  it('refuses a malformed signature', () => {
    for (const bad of [
      { ...SIGNATURE, kind: { type: 'certification', p: 4 } },
      { ...SIGNATURE, kind: { type: 'qualified' } },
      { ...SIGNATURE, subFilter: 'x' },
      { ...SIGNATURE, cryptographic: 'maybe' },
      { ...SIGNATURE, trust: 'trusted' },
      { ...SIGNATURE, index: SIGS_PER_DOC_MAX + 1 },
      { ...SIGNATURE, fieldName: 'x'.repeat(SIG_FIELD_NAME_MAX + 1) },
      { ...SIGNATURE, claimedTime: 'yesterday' },
      { ...SIGNATURE, signer: { ...CERT, selfSigned: 1 } },
      {
        ...SIGNATURE,
        coverage: { type: 'earlierRevision', revision: 1, later: { ...LATER, other: 0 }, verdict: 'allowed' },
      },
      { ...SIGNATURE, coverage: { type: 'earlierRevision', revision: 1, later: LATER, verdict: 'fine' } },
      { ...SIGNATURE, coverage: { type: 'partial' } },
      { ...SIGNATURE, widget: { pageId: 0, rect: { x: 0, y: 0, w: -1, h: 1 } } },
      { ...SIGNATURE, weakAlgorithm: undefined },
      { ...SIGNATURE, reason: 5 },
    ]) {
      expect(parseSignatureInfo(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses a report with an unknown lock or too many signatures', () => {
    expect(parseSignatureReport({ ...REPORT, lock: 'sealed' })).toBeNull();
    expect(parseSignatureReport({ ...REPORT, truncated: 'no' })).toBeNull();
    expect(
      parseSignatureReport({
        ...REPORT,
        signatures: Array.from({ length: SIGS_PER_DOC_MAX + 1 }, () => SIGNATURE),
      }),
    ).toBeNull();
    expect(parseSignatureReport({ signatures: [{}], truncated: false, lock: 'none' })).toBeNull();
  });

  it('reads the trusted signers and refuses more than 256', () => {
    const signer = { fingerprint: FP, commonName: 'Ada', added: '2026-10-05T08:00:00Z' };
    expect(parseTrustedSigners([signer])).toEqual([signer]);
    expect(parseTrustedSigners([{ ...signer, fingerprint: 'abc' }])).toBeNull();
    expect(parseTrustedSigners(Array.from({ length: TRUSTED_SIGNERS_MAX + 1 }, () => signer))).toBeNull();
    expect(parseTrustedSigners({})).toBeNull();
  });

  it('calls the validation and trust commands', async () => {
    invokeMock.mockResolvedValueOnce(REPORT);
    await expect(validateSignatures(4)).resolves.toEqual(REPORT);
    expect(invokeMock).toHaveBeenLastCalledWith('validate_signatures', { docId: 4 });

    invokeMock.mockResolvedValueOnce(REPORT);
    await setSignerTrust(4, 0, true);
    expect(invokeMock).toHaveBeenLastCalledWith('set_signer_trust', { docId: 4, signature: 0, trusted: true });

    invokeMock.mockResolvedValueOnce([]);
    await expect(listTrustedSigners()).resolves.toEqual([]);

    invokeMock.mockResolvedValueOnce(undefined);
    await removeTrustedSigner(FP);
    expect(invokeMock).toHaveBeenLastCalledWith('remove_trusted_signer', { fingerprint: FP });

    invokeMock.mockResolvedValueOnce({
      type: 'opened',
      document: { id: 9, pageCount: 1, displayName: 'x.pdf', kind: 'signedRevision' },
    });
    await expect(openSignedRevision(4, 0)).resolves.toMatchObject({
      type: 'opened',
      document: { kind: 'signedRevision' },
    });
    invokeMock.mockResolvedValueOnce({
      type: 'openFailed',
      code: 'damaged_file',
      key: 'error.damaged_file',
      retryable: false,
    });
    await expect(openSignedRevision(4, 0)).resolves.toMatchObject({
      type: 'openFailed',
      error: { code: 'damaged_file' },
    });
    invokeMock.mockResolvedValueOnce({ type: 'weird' });
    await expect(openSignedRevision(4, 0)).rejects.toMatchObject({ code: 'internal' });

    invokeMock.mockRejectedValueOnce(NOT_YET);
    await expect(validateSignatures(4)).rejects.toMatchObject({ params: { what: 'notYet' } });
  });
});

describe('signing a document', () => {
  const request: SignRequest = {
    identityId: ID,
    placement: { pageId: 0, rect: RECT },
    art: null,
    reason: 'I approve',
    location: null,
    lock: 'allowFillAndSign',
  };

  it('sends the request as it is and reads the save result, or null when cancelled', async () => {
    invokeMock.mockResolvedValueOnce(SAVE_RESULT);
    const result = await signDocument(4, request);
    expect(invokeMock).toHaveBeenLastCalledWith('sign_document', { docId: 4, request });
    expect(result?.document.signatureLock).toBe('fillAndSign');
    invokeMock.mockResolvedValueOnce(null);
    await expect(signDocument(4, request)).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce({ rev: 'x' });
    await expect(signDocument(4, request)).rejects.toMatchObject({ code: 'internal' });
  });

  it('saves an unsigned copy: an open outcome or null', async () => {
    invokeMock.mockResolvedValueOnce({
      type: 'opened',
      document: { id: 5, pageCount: 2, displayName: 'a – editable.pdf' },
    });
    await expect(saveUnsignedCopy(4)).resolves.toMatchObject({ type: 'opened' });
    invokeMock.mockResolvedValueOnce(null);
    await expect(saveUnsignedCopy(4)).resolves.toBeNull();
    invokeMock.mockRejectedValueOnce(NOT_YET);
    await expect(saveUnsignedCopy(4)).rejects.toMatchObject({ code: 'unsupported_feature' });
  });
});

describe('the document info', () => {
  it('reads signatureLock and the signedRevision kind, and refuses unknown ones', () => {
    const base = { id: 1, pageCount: 1, displayName: 'a.pdf' };
    expect(parseDocumentInfo({ ...base, kind: 'signedRevision', signatureLock: 'locked' })).toMatchObject({
      kind: 'signedRevision',
      signatureLock: 'locked',
    });
    expect(parseDocumentInfo(base)?.signatureLock).toBeUndefined();
    expect(parseDocumentInfo({ ...base, signatureLock: 'sealed' })).toBeNull();
    expect(parseDocumentInfo({ ...base, kind: 'signedrevision' })).toBeNull();
  });
});

describe('mirrors of the backend', () => {
  it('has the limits of src-tauri/src/limits.rs', () => {
    const rust = rustConstants();
    expect(rust.get('IDENTITIES_MAX')).toBe(IDENTITIES_MAX);
    expect(rust.get('IDENTITY_NAME_MAX')).toBe(IDENTITY_NAME_MAX);
    expect(rust.get('IDENTITY_ORG_MAX')).toBe(IDENTITY_ORG_MAX);
    expect(rust.get('IDENTITY_EMAIL_MAX')).toBe(IDENTITY_EMAIL_MAX);
    expect(rust.get('SEAL_REASON_MAX')).toBe(SEAL_REASON_MAX);
    expect(rust.get('SEAL_LOCATION_MAX')).toBe(SEAL_LOCATION_MAX);
    expect(rust.get('SIGS_PER_DOC_MAX')).toBe(SIGS_PER_DOC_MAX);
    expect(rust.get('SIG_FIELD_NAME_MAX')).toBe(SIG_FIELD_NAME_MAX);
    expect(rust.get('TRUSTED_SIGNERS_MAX')).toBe(TRUSTED_SIGNERS_MAX);
  });

  it('has the strings of DESIGN 3.8 in both languages, and one for each new error', () => {
    for (const locale of ['en', 'de'] as const) {
      const catalog = catalogs[locale];
      for (const key of [
        'cert.tool',
        'cert.errPassword',
        'cert.deleteConfirm',
        'lib.tab.certificates',
        'sign.cert.title',
        'sign.cert.notQualified',
        'seal.signed',
        'seal.reason',
        'save.status.signed',
        'sigs.title',
        'sigs.banner.single',
        'sigs.banner.multiple',
        'sigs.aria',
        'error.unsupported_feature.signEncrypted',
        'error.unsupported_feature.signingKey',
        'error.read_only.certified',
        'error.read_only.signed',
        'error.invalid_argument.identityFile',
        'error.invalid_argument.identityExpired',
        'error.limit_exceeded.identities',
      ]) {
        expect(Object.keys(catalog), `${locale} ${key}`).toContain(key);
      }
    }
  });
});
