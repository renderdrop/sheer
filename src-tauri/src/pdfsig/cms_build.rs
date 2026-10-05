//! Building the CMS signature of a PDF (ADR-121 section 1): PAdES B-B, a detached `SignedData` v1 with exactly one `SignerInfo`
//! (`issuerAndSerialNumber`), signed attributes content-type, message-digest (SHA-256) and signing-certificate-v2, no signing time, no
//! unsigned attributes. The `cms` builder adds the first two itself; `ess` adds the third.
//!
//! Algorithms: `ecdsa-with-SHA256` (P-256), `ecdsa-with-SHA384` (P-384) and `sha256WithRSAEncryption` (PKCS#1 v1.5). The message digest
//! is SHA-256 of the signed byte ranges for every key. Bytes in, bytes out: no PDF code here. A key is used for the one call and is
//! never copied (SECURITY I18).

use std::ops::Range;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
use der::asn1::{PrintableStringRef, TeletexStringRef, Utf8StringRef};
use der::Encode;
use p256::ecdsa::signature::{Keypair, Signer};
use p256::ecdsa::DerSignature;
use rsa::traits::PublicKeyParts;
use sha2::{Digest, Sha256};
use spki::{
    AlgorithmIdentifierOwned, DynSignatureAlgorithmIdentifier, ObjectIdentifier,
    SignatureBitStringEncoding,
};
use x509_cert::Certificate;

use super::ess;
use super::material::{SignerKey, SignerMaterial};
use crate::error::{AppError, ErrorCode};
use crate::limits;

/// Bytes the CMS needs on top of the chain and the signature: the attributes, the algorithm identifiers and the DER framing, with room.
const CMS_OVERHEAD: usize = 1536;
/// `/Contents` is sized in steps of this many bytes.
const CONTENTS_STEP: usize = 1024;
/// The longest DER ECDSA signature of P-256 and of P-384.
const P256_SIGNATURE_MAX: usize = 72;
const P384_SIGNATURE_MAX: usize = 104;
/// At most this many characters of a certificate's common name are used.
const NAME_MAX_CHARS: usize = 128;

fn id_data() -> ObjectIdentifier {
    ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.1")
}

fn sha256_id() -> AlgorithmIdentifierOwned {
    AlgorithmIdentifierOwned {
        oid: ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1"),
        parameters: None,
    }
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("cms: {detail}"))
}

/// SHA-256 of the two signed byte ranges: everything but `gap` (the `/Contents` string with its angle brackets).
pub fn digest_ranges(bytes: &[u8], gap: &Range<usize>) -> Result<[u8; 32], AppError> {
    let (head, tail) = match (bytes.get(..gap.start), bytes.get(gap.end..)) {
        (Some(head), Some(tail)) if gap.start <= gap.end => (head, tail),
        _ => return Err(failed("the gap is outside the file")),
    };
    let mut hasher = Sha256::new();
    hasher.update(head);
    hasher.update(tail);
    Ok(hasher.finalize().into())
}

/// The most DER bytes the signature value of `key` takes.
fn signature_max(key: &SignerKey) -> usize {
    match key {
        SignerKey::EcdsaP256(_) => P256_SIGNATURE_MAX,
        SignerKey::EcdsaP384(_) => P384_SIGNATURE_MAX,
        SignerKey::Rsa(key) => key.size(),
    }
}

/// The certificates that go into the signature: the signer's and its issuers, each once (a certificate set holds no duplicates), at
/// most `limits::SIG_CHAIN_MAX`.
fn chain_of(material: &SignerMaterial) -> Vec<&Certificate> {
    let mut seen: Vec<Vec<u8>> = Vec::new();
    let mut chain = Vec::new();
    for certificate in &material.chain {
        let Ok(der) = certificate.to_der() else {
            continue;
        };
        if seen.contains(&der) {
            continue;
        }
        seen.push(der);
        chain.push(certificate);
        if chain.len() == limits::SIG_CHAIN_MAX {
            break;
        }
    }
    chain
}

/// The size in bytes of the zero-filled `/Contents` for a signature made with `material`: `round_up(chain DER + largest signature +
/// 1 536, 1 024)`, at most `limits::SIG_CONTENTS_MAX` (more is `limit_exceeded`, a chain that large is refused, not cut).
pub fn contents_capacity(material: &SignerMaterial) -> Result<usize, AppError> {
    if material.signer_certificate().is_none() {
        return Err(AppError::invalid("identity"));
    }
    let mut chain = 0usize;
    for certificate in chain_of(material) {
        chain = chain.saturating_add(certificate.to_der().map_err(failed)?.len());
    }
    let need = chain
        .saturating_add(signature_max(&material.key))
        .saturating_add(CMS_OVERHEAD);
    let capacity = need.div_ceil(CONTENTS_STEP) * CONTENTS_STEP;
    if capacity > limits::SIG_CONTENTS_MAX {
        return Err(AppError::limit(
            "signature",
            limits::SIG_CONTENTS_MAX as u64,
        ));
    }
    Ok(capacity)
}

/// Whether the signer's certificate is valid now (`invalid_argument`, `identityExpired` when it is not: expired or not yet valid).
pub fn check_valid_at(material: &SignerMaterial, now: SystemTime) -> Result<(), AppError> {
    let certificate = material
        .signer_certificate()
        .ok_or(AppError::invalid("identity"))?;
    let now = now
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::invalid("identityExpired"))?;
    let validity = &certificate.tbs_certificate.validity;
    let from: Duration = validity.not_before.to_unix_duration();
    let to: Duration = validity.not_after.to_unix_duration();
    if now < from || now > to {
        return Err(AppError::invalid("identityExpired"));
    }
    Ok(())
}

/// The common name of the signer's certificate for display (`seal`, `/Name`): control and bidirectional-override characters removed,
/// at most 128 characters; `None` if the certificate has none.
pub fn signer_name(material: &SignerMaterial) -> Option<String> {
    let certificate = material.signer_certificate()?;
    let cn = ObjectIdentifier::new_unwrap("2.5.4.3");
    for rdn in certificate.tbs_certificate.subject.0.iter() {
        for attribute in rdn.0.iter() {
            if attribute.oid != cn {
                continue;
            }
            let value = &attribute.value;
            let text = value
                .decode_as::<Utf8StringRef<'_>>()
                .map(|s| s.as_str().to_owned())
                .or_else(|_| {
                    value
                        .decode_as::<PrintableStringRef<'_>>()
                        .map(|s| s.as_str().to_owned())
                })
                .or_else(|_| {
                    value
                        .decode_as::<TeletexStringRef<'_>>()
                        .map(|s| s.as_str().to_owned())
                })
                .ok()?;
            let clean: String = text
                .chars()
                .filter(|c| !c.is_control() && !is_bidi_control(*c))
                .take(NAME_MAX_CHARS)
                .collect();
            let clean = clean.trim().to_owned();
            return (!clean.is_empty()).then_some(clean);
        }
    }
    None
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// The DER `ContentInfo` (SignedData) over the content digest `digest`, signed with `material`. The result is at most
/// [`contents_capacity`] bytes, which is checked.
pub fn sign(digest: &[u8; 32], material: &SignerMaterial) -> Result<Vec<u8>, AppError> {
    let capacity = contents_capacity(material)?;
    // The `cms` builder unwraps in places; a panic there is an error here (and the key is dropped on the way out).
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &material.key {
        SignerKey::EcdsaP256(key) => assemble::<_, DerSignature>(key, digest, material),
        SignerKey::EcdsaP384(key) => {
            assemble::<_, p384::ecdsa::DerSignature>(key, digest, material)
        }
        SignerKey::Rsa(key) => {
            let key = rsa::pkcs1v15::SigningKey::<Sha256>::new((**key).clone());
            assemble::<_, rsa::pkcs1v15::Signature>(&key, digest, material)
        }
    }));
    let blob = built.map_err(|_| failed("the builder panicked"))??;
    if blob.len() > capacity {
        return Err(failed("the signature is larger than its placeholder"));
    }
    Ok(blob)
}

fn assemble<S, Sig>(
    key: &S,
    digest: &[u8; 32],
    material: &SignerMaterial,
) -> Result<Vec<u8>, AppError>
where
    S: Keypair + DynSignatureAlgorithmIdentifier + Signer<Sig>,
    Sig: SignatureBitStringEncoding,
{
    let signer = material
        .signer_certificate()
        .ok_or(AppError::invalid("identity"))?;
    let eci = EncapsulatedContentInfo {
        econtent_type: id_data(),
        econtent: None,
    };
    let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
        issuer: signer.tbs_certificate.issuer.clone(),
        serial_number: signer.tbs_certificate.serial_number.clone(),
    });
    let mut info = SignerInfoBuilder::new(key, sid, sha256_id(), &eci, Some(digest.as_slice()))
        .map_err(failed)?;
    info.add_signed_attribute(ess::signing_certificate_v2(signer)?)
        .map_err(failed)?;
    let mut builder = SignedDataBuilder::new(&eci);
    builder.add_digest_algorithm(sha256_id()).map_err(failed)?;
    for certificate in chain_of(material) {
        builder
            .add_certificate(CertificateChoices::Certificate(certificate.clone()))
            .map_err(failed)?;
    }
    builder.add_signer_info::<S, Sig>(info).map_err(failed)?;
    builder.build().map_err(failed)?.to_der().map_err(failed)
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Keys and certificates for the tests of the signer, here and in `tests/sign_roundtrip.rs` (through `sheer_lib`).

    use std::str::FromStr;
    use std::time::Duration;

    use p256::ecdsa::signature::Keypair;
    use x509_cert::builder::{Builder, CertificateBuilder, Profile};
    use x509_cert::name::Name;
    use x509_cert::serial_number::SerialNumber;
    use x509_cert::time::Validity;

    use super::*;

    pub type Res<T> = Result<T, Box<dyn std::error::Error>>;

    /// A self-signed certificate for `key`, valid for `days` from now.
    pub fn self_signed<K>(key: &K, name: &str, days: u64) -> Res<Certificate>
    where
        K: Keypair + DynSignatureAlgorithmIdentifier + Signer<DerSignature>,
        K::VerifyingKey: spki::EncodePublicKey,
    {
        let subject = Name::from_str(&format!("CN={name}"))?;
        let spki = spki::SubjectPublicKeyInfoOwned::from_key(key.verifying_key())?;
        let builder = CertificateBuilder::new(
            Profile::Manual { issuer: None },
            SerialNumber::from(7u32),
            Validity::from_now(Duration::from_secs(days * 86_400))?,
            subject,
            spki,
            key,
        )?;
        Ok(builder.build::<DerSignature>()?)
    }

    pub fn p256_material(name: &str) -> Res<SignerMaterial> {
        let key = p256::ecdsa::SigningKey::from_slice(&[7u8; 32])?;
        let cert = self_signed(&key, name, 365)?;
        Ok(SignerMaterial {
            key: SignerKey::EcdsaP256(key),
            chain: vec![cert],
        })
    }
}

#[cfg(test)]
mod tests {
    use cms::content_info::ContentInfo;
    use cms::signed_data::SignedData;
    use der::Decode;
    use p256::ecdsa::signature::Verifier;

    use super::testkit::*;
    use super::*;

    fn signer_info(blob: &[u8]) -> Res<cms::signed_data::SignerInfo> {
        let info = ContentInfo::from_der(blob)?;
        let signed: SignedData = info.content.decode_as()?;
        assert_eq!(signed.signer_infos.0.len(), 1);
        Ok(signed
            .signer_infos
            .0
            .iter()
            .next()
            .ok_or("one signer")?
            .clone())
    }

    #[test]
    fn a_p256_signature_has_the_three_attributes_and_verifies() -> Res<()> {
        let material = p256_material("Ada")?;
        let digest = [9u8; 32];
        let blob = sign(&digest, &material)?;
        assert!(blob.len() <= contents_capacity(&material)?);
        let info = signer_info(&blob)?;
        let attrs = info.signed_attrs.as_ref().ok_or("signed attributes")?;
        let oids: Vec<String> = attrs.iter().map(|a| a.oid.to_string()).collect();
        assert_eq!(attrs.len(), 3, "{oids:?}: no signing time");
        assert!(oids.contains(&ess::ID_AA_SIGNING_CERTIFICATE_V2.to_string()));
        let SignerKey::EcdsaP256(key) = &material.key else {
            return Err("p256".into());
        };
        let signature = DerSignature::from_bytes(info.signature.as_bytes())?;
        key.verifying_key().verify(&attrs.to_der()?, &signature)?;
        Ok(())
    }

    #[test]
    fn a_p384_signature_uses_ecdsa_with_sha384() -> Res<()> {
        let key = p384::ecdsa::SigningKey::from_slice(&[5u8; 48])?;
        let cert = {
            use std::str::FromStr;
            use x509_cert::builder::{Builder, CertificateBuilder, Profile};
            let spki = spki::SubjectPublicKeyInfoOwned::from_key(*key.verifying_key())?;
            CertificateBuilder::new(
                Profile::Manual { issuer: None },
                x509_cert::serial_number::SerialNumber::from(3u32),
                x509_cert::time::Validity::from_now(Duration::from_secs(86_400))?,
                x509_cert::name::Name::from_str("CN=Grace")?,
                spki,
                &key,
            )?
            .build::<p384::ecdsa::DerSignature>()?
        };
        let material = SignerMaterial {
            key: SignerKey::EcdsaP384(key),
            chain: vec![cert],
        };
        let blob = sign(&[1u8; 32], &material)?;
        let info = signer_info(&blob)?;
        assert_eq!(
            info.signature_algorithm.oid.to_string(),
            "1.2.840.10045.4.3.3"
        );
        Ok(())
    }

    #[test]
    fn the_capacity_follows_the_chain_in_steps_and_is_capped() -> Res<()> {
        let mut material = p256_material("Ada")?;
        let one = contents_capacity(&material)?;
        assert_eq!(one % CONTENTS_STEP, 0);
        assert!(one >= 1536 + 72);
        let key = p256::ecdsa::SigningKey::from_slice(&[7u8; 32])?;
        // Distinct issuers add to the size; the same certificate again does not (a certificate set has no duplicates, and the
        // builder would refuse one), and signing still works.
        for n in 0..7 {
            material
                .chain
                .push(self_signed(&key, &format!("Issuer {n}"), 30)?);
        }
        assert!(contents_capacity(&material)? > one);
        let before = contents_capacity(&material)?;
        let again = material.chain[0].clone();
        material.chain.extend(std::iter::repeat_n(again, 5));
        assert_eq!(contents_capacity(&material)?, before);
        assert!(sign(&[0u8; 32], &material).is_ok());
        // More than the chain maximum is not looked at.
        for n in 0..20 {
            material
                .chain
                .push(self_signed(&key, &format!("Extra {n}"), 30)?);
        }
        assert!(contents_capacity(&material)? <= limits::SIG_CONTENTS_MAX);
        assert_eq!(chain_of(&material).len(), limits::SIG_CHAIN_MAX);
        material.chain.clear();
        assert_eq!(
            contents_capacity(&material).err().map(|e| e.code()),
            Some(ErrorCode::InvalidArgument)
        );
        Ok(())
    }

    #[test]
    fn validity_and_the_display_name_are_read_from_the_certificate() -> Res<()> {
        let material = p256_material("Ada \u{202E}Lovelace")?;
        assert!(check_valid_at(&material, SystemTime::now()).is_ok());
        let later = SystemTime::now() + Duration::from_secs(400 * 86_400);
        assert_eq!(
            check_valid_at(&material, later).err().map(|e| e.code()),
            Some(ErrorCode::InvalidArgument)
        );
        let early = SystemTime::now() - Duration::from_secs(86_400);
        assert!(check_valid_at(&material, early).is_err());
        assert_eq!(signer_name(&material).as_deref(), Some("Ada Lovelace"));
        Ok(())
    }

    #[test]
    fn the_ranges_are_hashed_without_the_gap() -> Res<()> {
        let bytes = b"0123456789";
        let digest = digest_ranges(bytes, &(2..5))?;
        assert_eq!(digest.as_slice(), Sha256::digest(b"0156789").as_slice());
        assert!(digest_ranges(bytes, &(5..20)).is_err());
        let reversed = Range { start: 6, end: 5 };
        assert!(digest_ranges(bytes, &reversed).is_err());
        Ok(())
    }

    /// A deterministic generator for the one RSA key of the tests (`rsa` has no OS randomness here).
    struct Lcg(u64);
    impl rsa::rand_core::RngCore for Lcg {
        fn next_u32(&mut self) -> u32 {
            (self.next_u64() >> 32) as u32
        }
        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            for chunk in dest.chunks_mut(8) {
                let bytes = self.next_u64().to_le_bytes();
                chunk.copy_from_slice(&bytes[..chunk.len()]);
            }
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rsa::rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }
    impl rsa::rand_core::CryptoRng for Lcg {}

    #[test]
    fn an_rsa_signature_is_sha256_with_rsa_and_verifies() -> Res<()> {
        use rsa::pkcs1v15::{Signature, SigningKey, VerifyingKey};
        let key = rsa::RsaPrivateKey::new(&mut Lcg(42), 1024)?;
        let signing = SigningKey::<Sha256>::new(key.clone());
        let cert = {
            use std::str::FromStr;
            use x509_cert::builder::{Builder, CertificateBuilder, Profile};
            let spki = spki::SubjectPublicKeyInfoOwned::from_key(signing.verifying_key())?;
            CertificateBuilder::new(
                Profile::Manual { issuer: None },
                x509_cert::serial_number::SerialNumber::from(5u32),
                x509_cert::time::Validity::from_now(Duration::from_secs(86_400))?,
                x509_cert::name::Name::from_str("CN=Rsa")?,
                spki,
                &signing,
            )?
            .build::<Signature>()?
        };
        let material = SignerMaterial {
            key: SignerKey::Rsa(Box::new(key)),
            chain: vec![cert],
        };
        let blob = sign(&[3u8; 32], &material)?;
        let info = signer_info(&blob)?;
        assert_eq!(
            info.signature_algorithm.oid.to_string(),
            "1.2.840.113549.1.1.11"
        );
        let attrs = info.signed_attrs.as_ref().ok_or("attrs")?;
        let signature = Signature::try_from(info.signature.as_bytes())?;
        let verifying: VerifyingKey<Sha256> = signing.verifying_key();
        verifying.verify(&attrs.to_der()?, &signature)?;
        Ok(())
    }
}
