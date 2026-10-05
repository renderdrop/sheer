import { call } from './call';
import { parseOpenOutcome, SIGNATURE_LOCKS, type OpenOutcome, type SignatureLock } from './documents';
import { toAppError } from './errors';
import { parseSaveResult, type SaveResult } from './save';
import type { SignatureRef } from './signatures';
import { isRecord, isUint, parseRect, type Rect } from './wire';

export { SIGNATURE_LOCKS, type SignatureLock } from './documents';

/**
 * Certificate signatures (ARCHITECTURE section 5 "Certificate signatures (v1.4, ADR-121)";
 * src-tauri/src/commands/{identities,sign,sig_validate,unsigned_copy}.rs, src-tauri/src/pdfsig/types.rs). Private keys, PKCS#12 bytes and
 * paths never cross IPC: the password of an identity file is sent once, to `importSigningIdentity`, and the file itself is picked by
 * a Rust dialog. Every answer goes through a parser here; one that does not have the documented shape is an internal error. Text that
 * came from a certificate or a signature is bounded here again; the UI shows it as text, never as markup.
 */

/** Limits (src-tauri/src/limits.rs). */
export const IDENTITIES_MAX = 8;
export const IDENTITY_NAME_MAX = 64;
export const IDENTITY_ORG_MAX = 64;
export const IDENTITY_EMAIL_MAX = 254;
export const SEAL_REASON_MAX = 128;
export const SEAL_LOCATION_MAX = 64;
export const SIGS_PER_DOC_MAX = 32;
export const SIG_FIELD_NAME_MAX = 512;
export const TRUSTED_SIGNERS_MAX = 256;
/** The smallest seal box on the page, in points (ARCHITECTURE section 5: at least 72 x 24 pt). */
export const SEAL_MIN_WIDTH_PT = 72;
export const SEAL_MIN_HEIGHT_PT = 24;
/** Longest text of a certificate name part that is accepted from the backend. */
const CERT_TEXT_MAX = 128;
const SERIAL_HEX_MAX = 64;
const TIME_MAX = 40;
const CHAIN_MAX = 8;

// --- Types ---------------------------------------------------------------------------------------------------------------

export type KeyKind = { type: 'ecP256' } | { type: 'ecP384' } | { type: 'rsa'; bits: number };

/** A certificate name as the backend filtered it (display-name filter, at most 128 characters each). */
export interface CertName {
  commonName: string;
  organization: string | null;
  email: string | null;
}

export interface CertSummary {
  subject: CertName;
  issuer: CertName;
  selfSigned: boolean;
  /** ISO 8601. */
  notBefore: string;
  notAfter: string;
  /** At most 64 lowercase hex digits. */
  serialHex: string;
  /** SHA-256 of the DER certificate, 64 lowercase hex digits. */
  fingerprintSha256: string;
}

export const IDENTITY_SOURCES = ['generated', 'imported'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export interface SigningIdentityInfo extends CertSummary {
  /** 32 lowercase hex digits. */
  id: string;
  source: IdentitySource;
  key: KeyKind;
  chainLength: number;
  expired: boolean;
}

export const STORE_STATUSES = ['ready', 'empty', 'unavailable', 'locked'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export interface SigningIdentities {
  status: StoreStatus;
  items: SigningIdentityInfo[];
}

export interface NewIdentitySpec {
  /** 1..=64 characters. */
  name: string;
  /** At most 254 characters. */
  email: string | null;
  /** At most 64 characters. */
  organization: string | null;
}

/** A picked identity file waiting for its password; `displayName` is the file's name, never a path. */
export interface IdentityImportTicket {
  ticket: number;
  displayName: string;
}

export interface SealPlacement {
  pageId: number;
  /** Page space, at least 72 x 24 pt, inside the CropBox. */
  rect: Rect;
}

/** What the certification signature allows later: DocMDP P=2 or P=1. Only the first signature of a document certifies. */
export type SignLock = 'allowFillAndSign' | 'noChanges';

export interface SignRequest {
  identityId: string;
  /** `null`: an invisible signature. */
  placement: SealPlacement | null;
  art: SignatureRef | null;
  /** At most 128 characters. */
  reason: string | null;
  /** At most 64 characters. */
  location: string | null;
  lock: SignLock;
}

export interface LaterChanges {
  signatures: boolean;
  formFill: boolean;
  annotations: boolean;
  other: boolean;
}

export type SignatureKind = { type: 'certification'; p: 1 | 2 | 3 } | { type: 'approval' } | { type: 'docTimestamp' };

export const SUB_FILTERS = ['etsiCadesDetached', 'adbePkcs7Detached', 'adbePkcs7Sha1', 'etsiRfc3161', 'other'] as const;
export type SubFilter = (typeof SUB_FILTERS)[number];

export const CRYPTOGRAPHIC_STATES = ['valid', 'invalid', 'unsupportedAlgorithm', 'malformed', 'unverifiable'] as const;
export type Cryptographic = (typeof CRYPTOGRAPHIC_STATES)[number];

export type SignatureCoverage =
  | { type: 'wholeFile' }
  | { type: 'earlierRevision'; revision: number; later: LaterChanges; verdict: 'allowed' | 'disallowed' };

export const TRUST_STATES = ['ownIdentity', 'trustedByYou', 'notTrusted'] as const;
export type Trust = (typeof TRUST_STATES)[number];

export interface SignatureInfo {
  index: number;
  fieldName: string;
  kind: SignatureKind;
  subFilter: SubFilter;
  signer: CertSummary | null;
  /** `/M`, else the signing time of the CMS; always "claimed by the signer". ISO 8601. */
  claimedTime: string | null;
  reason: string | null;
  location: string | null;
  cryptographic: Cryptographic;
  weakAlgorithm: boolean;
  timestampPresent: boolean;
  coverage: SignatureCoverage;
  certValidAtClaimedTime: boolean;
  trust: Trust;
  widget: { pageId: number; rect: Rect } | null;
}

export interface SignatureReport {
  signatures: SignatureInfo[];
  /** A cap cut the report short. */
  truncated: boolean;
  lock: SignatureLock;
  /** The number of revisions of the file (at least 1): the "N" of "version n of N". */
  revisionCount: number;
}

export interface TrustedSigner {
  /** 64 lowercase hex digits. */
  fingerprint: string;
  commonName: string;
  /** ISO 8601. */
  added: string;
}

// --- Parsers -------------------------------------------------------------------------------------------------------------

const ID = /^[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SERIAL = /^[0-9a-f]+$/;
/** ISO 8601 with a time and an offset or `Z`: what the backend writes. A shape check, not a calendar. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether `value` is the id of an identity (32 lowercase hex digits). */
export const isIdentityId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
/** Whether `value` is a certificate fingerprint (64 lowercase hex digits). */
export const isFingerprint = (value: unknown): value is string => typeof value === 'string' && FINGERPRINT.test(value);

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= TIME_MAX && TIME.test(value);

function text(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return text(value, max) ? value : undefined;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/** Validates a key kind; `null` if it is not one. */
export function parseKeyKind(value: unknown): KeyKind | null {
  if (!isRecord(value)) return null;
  if (value.type === 'ecP256') return { type: 'ecP256' };
  if (value.type === 'ecP384') return { type: 'ecP384' };
  if (value.type === 'rsa') {
    const { bits } = value;
    return isUint(bits, 16_384) && bits >= 1024 ? { type: 'rsa', bits } : null;
  }
  return null;
}

/** Validates a certificate name; `null` if it is not one. Extra keys are dropped. */
export function parseCertName(value: unknown): CertName | null {
  if (!isRecord(value)) return null;
  const { commonName, organization, email } = value;
  const org = optionalText(organization, CERT_TEXT_MAX);
  const mail = optionalText(email, CERT_TEXT_MAX);
  if (!text(commonName, CERT_TEXT_MAX) || org === undefined || mail === undefined) return null;
  return { commonName, organization: org, email: mail };
}

/** Validates the summary of a certificate; `null` if it is not one. Extra keys are dropped. */
export function parseCertSummary(value: unknown): CertSummary | null {
  if (!isRecord(value)) return null;
  const { selfSigned, notBefore, notAfter, serialHex, fingerprintSha256 } = value;
  const subject = parseCertName(value.subject);
  const issuer = parseCertName(value.issuer);
  if (
    subject === null ||
    issuer === null ||
    typeof selfSigned !== 'boolean' ||
    !isTime(notBefore) ||
    !isTime(notAfter) ||
    !text(serialHex, SERIAL_HEX_MAX, 1) ||
    !SERIAL.test(serialHex) ||
    !isFingerprint(fingerprintSha256)
  ) {
    return null;
  }
  return { subject, issuer, selfSigned, notBefore, notAfter, serialHex, fingerprintSha256 };
}

/** Validates one identity; `null` if it is not one. Extra keys are dropped. */
export function parseSigningIdentity(value: unknown): SigningIdentityInfo | null {
  if (!isRecord(value)) return null;
  const summary = parseCertSummary(value);
  const key = parseKeyKind(value.key);
  const { id, source, chainLength, expired } = value;
  if (
    summary === null ||
    key === null ||
    !isIdentityId(id) ||
    !oneOf(IDENTITY_SOURCES, source) ||
    !isUint(chainLength, CHAIN_MAX) ||
    chainLength < 1 ||
    typeof expired !== 'boolean'
  ) {
    return null;
  }
  return { ...summary, id, source, key, chainLength, expired };
}

/** Validates the answer of `list_signing_identities`; `null` if it is not one (more than 8 items included). */
export function parseSigningIdentities(value: unknown): SigningIdentities | null {
  if (!isRecord(value)) return null;
  const { status, items } = value;
  if (!oneOf(STORE_STATUSES, status) || !Array.isArray(items) || items.length > IDENTITIES_MAX) return null;
  const parsed: SigningIdentityInfo[] = [];
  for (const item of items as unknown[]) {
    const identity = parseSigningIdentity(item);
    if (identity === null) return null;
    parsed.push(identity);
  }
  return { status, items: parsed };
}

/** Validates an import ticket; `null` if it is not one. Extra keys are dropped. */
export function parseIdentityImportTicket(value: unknown): IdentityImportTicket | null {
  if (!isRecord(value)) return null;
  const { ticket, displayName } = value;
  return isUint(ticket) && text(displayName, 255) ? { ticket, displayName } : null;
}

function parseLaterChanges(value: unknown): LaterChanges | null {
  if (!isRecord(value)) return null;
  const { signatures, formFill, annotations, other } = value;
  if (
    typeof signatures !== 'boolean' ||
    typeof formFill !== 'boolean' ||
    typeof annotations !== 'boolean' ||
    typeof other !== 'boolean'
  ) {
    return null;
  }
  return { signatures, formFill, annotations, other };
}

function parseKind(value: unknown): SignatureKind | null {
  if (!isRecord(value)) return null;
  if (value.type === 'approval') return { type: 'approval' };
  if (value.type === 'docTimestamp') return { type: 'docTimestamp' };
  if (value.type === 'certification') {
    const { p } = value;
    return p === 1 || p === 2 || p === 3 ? { type: 'certification', p } : null;
  }
  return null;
}

function parseCoverage(value: unknown): SignatureCoverage | null {
  if (!isRecord(value)) return null;
  if (value.type === 'wholeFile') return { type: 'wholeFile' };
  if (value.type !== 'earlierRevision') return null;
  const { revision, verdict } = value;
  const later = parseLaterChanges(value.later);
  if (!isUint(revision, 64) || later === null || (verdict !== 'allowed' && verdict !== 'disallowed')) return null;
  return { type: 'earlierRevision', revision, later, verdict };
}

/** Validates one validated signature; `null` if it is not one. Extra keys are dropped. */
export function parseSignatureInfo(value: unknown): SignatureInfo | null {
  if (!isRecord(value)) return null;
  const { index, fieldName, subFilter, cryptographic, weakAlgorithm, timestampPresent, certValidAtClaimedTime, trust } =
    value;
  const kind = parseKind(value.kind);
  const coverage = parseCoverage(value.coverage);
  const signer = value.signer === null ? null : parseCertSummary(value.signer);
  const claimedTime = value.claimedTime;
  const reason = optionalText(value.reason, SEAL_REASON_MAX * 2);
  const location = optionalText(value.location, SEAL_LOCATION_MAX * 4);
  let widget: SignatureInfo['widget'] = null;
  if (value.widget !== null) {
    if (!isRecord(value.widget)) return null;
    const rect = parseRect(value.widget.rect);
    const pageId = value.widget.pageId;
    if (rect === null || !isUint(pageId)) return null;
    widget = { pageId, rect };
  }
  if (
    !isUint(index, SIGS_PER_DOC_MAX) ||
    !text(fieldName, SIG_FIELD_NAME_MAX) ||
    kind === null ||
    !oneOf(SUB_FILTERS, subFilter) ||
    (value.signer !== null && signer === null) ||
    !(claimedTime === null || isTime(claimedTime)) ||
    reason === undefined ||
    location === undefined ||
    !oneOf(CRYPTOGRAPHIC_STATES, cryptographic) ||
    typeof weakAlgorithm !== 'boolean' ||
    typeof timestampPresent !== 'boolean' ||
    coverage === null ||
    typeof certValidAtClaimedTime !== 'boolean' ||
    !oneOf(TRUST_STATES, trust)
  ) {
    return null;
  }
  return {
    index,
    fieldName,
    kind,
    subFilter,
    signer,
    claimedTime,
    reason,
    location,
    cryptographic,
    weakAlgorithm,
    timestampPresent,
    coverage,
    certValidAtClaimedTime,
    trust,
    widget,
  };
}

/** Validates a signature report; `null` if it is not one (more than 32 signatures included). */
export function parseSignatureReport(value: unknown): SignatureReport | null {
  if (!isRecord(value)) return null;
  const { signatures, truncated, lock, revisionCount } = value;
  if (!Array.isArray(signatures) || signatures.length > SIGS_PER_DOC_MAX || typeof truncated !== 'boolean') return null;
  if (
    typeof revisionCount !== 'number' ||
    !Number.isInteger(revisionCount) ||
    revisionCount < 0 ||
    revisionCount > 1000
  ) {
    return null;
  }
  if (!oneOf(SIGNATURE_LOCKS, lock)) return null;
  const parsed: SignatureInfo[] = [];
  for (const item of signatures as unknown[]) {
    const info = parseSignatureInfo(item);
    if (info === null) return null;
    parsed.push(info);
  }
  return { signatures: parsed, truncated, lock, revisionCount: Math.max(1, revisionCount) };
}

/** Validates a pinned signer; `null` if it is not one. Extra keys are dropped. */
export function parseTrustedSigner(value: unknown): TrustedSigner | null {
  if (!isRecord(value)) return null;
  const { fingerprint, commonName, added } = value;
  return isFingerprint(fingerprint) && text(commonName, CERT_TEXT_MAX) && isTime(added)
    ? { fingerprint, commonName, added }
    : null;
}

/** Validates the answer of `list_trusted_signers`; `null` if it is not one (more than 256 included). */
export function parseTrustedSigners(value: unknown): TrustedSigner[] | null {
  if (!Array.isArray(value) || value.length > TRUSTED_SIGNERS_MAX) return null;
  const parsed: TrustedSigner[] = [];
  for (const item of value as unknown[]) {
    const signer = parseTrustedSigner(item);
    if (signer === null) return null;
    parsed.push(signer);
  }
  return parsed;
}

function need<T>(parsed: T | null): T {
  if (parsed === null) throw toAppError(null);
  return parsed;
}

// --- Client-side checks (the backend checks again) -----------------------------------------------------------------------

/** Whether a seal box meets the minimum of 72 x 24 pt. */
export function sealBoxFits(rect: Rect): boolean {
  return rect.w >= SEAL_MIN_WIDTH_PT && rect.h >= SEAL_MIN_HEIGHT_PT;
}

/** Whether a new identity's text parts are within the caps (a name of 1 to 64 characters; the rest optional). */
export function fitsNewIdentity(spec: NewIdentitySpec): boolean {
  const name = spec.name.trim();
  return (
    name.length >= 1 &&
    name.length <= IDENTITY_NAME_MAX &&
    (spec.email === null || spec.email.length <= IDENTITY_EMAIL_MAX) &&
    (spec.organization === null || spec.organization.length <= IDENTITY_ORG_MAX)
  );
}

// --- Commands ------------------------------------------------------------------------------------------------------------

/** The signing identities with the state of the store. */
export async function listSigningIdentities(): Promise<SigningIdentities> {
  return need(parseSigningIdentities(await call<unknown>('list_signing_identities')));
}

/** Makes a self-signed ECDSA P-256 identity (valid 3 years). Rejects `keychain_unavailable` or `limit_exceeded` (8 identities). */
export async function createSigningIdentity(spec: NewIdentitySpec): Promise<SigningIdentityInfo> {
  return need(parseSigningIdentity(await call<unknown>('create_signing_identity', { spec })));
}

/** Shows the native open dialog for a `.p12` or `.pfx` file; `null` if the user cancelled. The file waits in the backend under the ticket. */
export async function pickIdentityFile(): Promise<IdentityImportTicket | null> {
  const answer = await call<unknown>('pick_identity_file');
  return answer === null ? null : need(parseIdentityImportTicket(answer));
}

/** Decrypts the picked file with `password` and stores its identity. Rejects `password_incorrect`, `invalid_argument` (`identityFile`), `unsupported_feature` (`signingKey`). */
export async function importSigningIdentity(ticket: number, password: string): Promise<SigningIdentityInfo> {
  return need(parseSigningIdentity(await call<unknown>('import_signing_identity', { ticket, password })));
}

/** Drops a picked file; an unknown ticket is not an error. */
export async function discardIdentityImport(ticket: number): Promise<void> {
  await call<void>('discard_identity_import', { ticket });
}

/** Deletes an identity (32 hex digits); `not_found` if it does not exist. */
export async function deleteSigningIdentity(identityId: string): Promise<void> {
  await call<void>('delete_signing_identity', { identityId });
}

/** Writes the public certificate of an identity (`<CN>.cer`) to a file the user picks; `false` if the dialog was cancelled. */
export async function exportSigningCertificate(identityId: string): Promise<boolean> {
  const answer = await call<unknown>('export_signing_certificate', { identityId });
  if (typeof answer !== 'boolean') throw toAppError(null);
  return answer;
}

/**
 * Signs the document into a file the user picks (PAdES B-B, one appended revision); `null` if the dialog was cancelled. The result is
 * the signed file as the open document, with an empty history. Rejects `unsaved_changes`, `needs_confirmation` (`fileChangedOnDisk`),
 * `unsupported_feature` (`signEncrypted`, `xfa`), `read_only` (`certified`), `invalid_argument` (`identityExpired`).
 */
export async function signDocument(docId: number, request: SignRequest): Promise<SaveResult | null> {
  const answer = await call<unknown>('sign_document', { docId, request });
  return answer === null ? null : need(parseSaveResult(answer));
}

/** Writes a copy without signatures (Full rewrite) to a file the user picks and opens it; `null` if the dialog was cancelled. */
export async function saveUnsignedCopy(docId: number): Promise<OpenOutcome | null> {
  const answer = await call<unknown>('save_unsigned_copy', { docId });
  return answer === null ? null : need(parseOpenOutcome(answer));
}

/** Checks every signature of the document (at most 32, 60 s); the backend caches the report until the document is reloaded. */
export async function validateSignatures(docId: number): Promise<SignatureReport> {
  return need(parseSignatureReport(await call<unknown>('validate_signatures', { docId })));
}

/** Opens the bytes signature `signature` covers as a read-only document (`kind: 'signedRevision'`). */
export async function openSignedRevision(docId: number, signature: number): Promise<OpenOutcome> {
  return need(parseOpenOutcome(await call<unknown>('open_signed_revision', { docId, signature })));
}

/** Pins or unpins the signer certificate of a signature (the backend reads it from the document) and answers the new report. */
export async function setSignerTrust(docId: number, signature: number, trusted: boolean): Promise<SignatureReport> {
  return need(parseSignatureReport(await call<unknown>('set_signer_trust', { docId, signature, trusted })));
}

/** The pinned signer certificates. */
export async function listTrustedSigners(): Promise<TrustedSigner[]> {
  return need(parseTrustedSigners(await call<unknown>('list_trusted_signers')));
}

/** Removes a pin (64 hex digits); `not_found` if there is none. */
export async function removeTrustedSigner(fingerprint: string): Promise<void> {
  await call<void>('remove_trusted_signer', { fingerprint });
}
