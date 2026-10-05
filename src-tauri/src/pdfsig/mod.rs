//! Certificate signatures (ADR-121): identities, PKCS#12, CMS building and verification, the revision diff.
//!
//! The only module that names the crypto crates (`der`, `spki`, `pkcs8`, `x509_cert`, `cms`, `rsa`, `p256`, `p384`, `sha1`,
//! `p12_keystore`; a CI grep keeps it so, SECURITY S7) and it holds no engine and no lopdf code: bytes in, bytes and typed values out.
//! `pdfwrite/{sigread,sign,seal,unsign}` read and write the PDF side. Private keys, PKCS#12 bytes and passwords never cross IPC
//! (SECURITY I16 to I18).
//!
//! Package W0 holds [`types`] only; the other modules join with the packages B1 to B3.

pub mod material;
pub mod types;

#[cfg(test)]
mod crypto_seam {
    //! The stable RustCrypto line has every API the packages need (ADR-121 addendum): a self-signed P-256 certificate through the
    //! `x509-cert` builder, a detached CMS SignedData with an externally computed digest and an ESS `signing-certificate-v2` attribute
    //! made with `der` derive, ECDSA verification, and the type-level presence of the RSA signer and the PKCS#12 decoder.

    use std::str::FromStr;
    use std::time::Duration;

    use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
    use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
    use cms::content_info::ContentInfo;
    use cms::signed_data::{EncapsulatedContentInfo, SignedData, SignerIdentifier};
    use der::asn1::{Any, OctetString, SetOfVec};
    use der::{Decode, Encode, Sequence};
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::{DerSignature, SigningKey};
    use sha2::{Digest, Sha256};
    use spki::{AlgorithmIdentifierOwned, ObjectIdentifier, SubjectPublicKeyInfoOwned};
    use x509_cert::attr::Attribute;
    use x509_cert::builder::{Builder, CertificateBuilder, Profile};
    use x509_cert::name::Name;
    use x509_cert::serial_number::SerialNumber;
    use x509_cert::time::Validity;
    use x509_cert::Certificate;

    type Res<T> = Result<T, Box<dyn std::error::Error>>;

    /// RFC 5035 `ESSCertIDv2` with the SHA-256 default left out, as PAdES writes it.
    #[derive(Sequence)]
    struct EssCertIdV2 {
        cert_hash: OctetString,
    }

    #[derive(Sequence)]
    struct SigningCertificateV2 {
        certs: Vec<EssCertIdV2>,
    }

    fn id_data() -> ObjectIdentifier {
        ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.1")
    }

    fn self_signed(key: &SigningKey) -> Res<Certificate> {
        let subject = Name::from_str("CN=Seam Test")?;
        let spki = SubjectPublicKeyInfoOwned::from_key(*key.verifying_key())?;
        let builder = CertificateBuilder::new(
            Profile::Manual { issuer: None },
            SerialNumber::from(1u32),
            Validity::from_now(Duration::from_secs(3 * 365 * 86_400))?,
            subject,
            spki,
            key,
        )?;
        Ok(builder.build::<DerSignature>()?)
    }

    #[test]
    fn a_detached_ecdsa_signeddata_with_ess_v2_builds_and_verifies() -> Res<()> {
        let key = SigningKey::from_slice(&[7u8; 32])?;
        let cert = self_signed(&key)?;
        let content_digest = Sha256::digest(b"the signed byte ranges");

        let eci = EncapsulatedContentInfo {
            econtent_type: id_data(),
            econtent: None,
        };
        let sha256 = AlgorithmIdentifierOwned {
            oid: ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1"),
            parameters: None,
        };
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: cert.tbs_certificate.issuer.clone(),
            serial_number: cert.tbs_certificate.serial_number.clone(),
        });
        let mut signer =
            SignerInfoBuilder::new(&key, sid, sha256.clone(), &eci, Some(&content_digest))
                .map_err(|e| e.to_string())?;
        // The builder adds content-type and message-digest itself (a second copy is refused); only signing-certificate-v2 is ours.
        let ess = SigningCertificateV2 {
            certs: vec![EssCertIdV2 {
                cert_hash: OctetString::new(Sha256::digest(cert.to_der()?).to_vec())?,
            }],
        };
        let mut values = SetOfVec::new();
        values.insert(Any::from_der(&ess.to_der()?)?)?;
        signer
            .add_signed_attribute(Attribute {
                oid: ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.16.2.47"),
                values,
            })
            .map_err(|e| e.to_string())?;

        let mut builder = SignedDataBuilder::new(&eci);
        builder
            .add_digest_algorithm(sha256)
            .map_err(|e| e.to_string())?;
        builder
            .add_certificate(CertificateChoices::Certificate(cert))
            .map_err(|e| e.to_string())?;
        builder
            .add_signer_info::<SigningKey, DerSignature>(signer)
            .map_err(|e| e.to_string())?;
        let blob = builder.build().map_err(|e| e.to_string())?.to_der()?;

        let info = ContentInfo::from_der(&blob)?;
        let signed: SignedData = info.content.decode_as()?;
        assert_eq!(signed.signer_infos.0.len(), 1);
        let signer_info = signed.signer_infos.0.iter().next().ok_or("one signer")?;
        let attrs = signer_info
            .signed_attrs
            .as_ref()
            .ok_or("signed attributes")?;
        assert_eq!(
            attrs.len(),
            3,
            "content-type, message-digest, signing-certificate-v2 and no signing-time"
        );
        // The signature covers the DER SET OF signed attributes.
        let signature = DerSignature::from_bytes(signer_info.signature.as_bytes())?;
        key.verifying_key().verify(&attrs.to_der()?, &signature)?;
        Ok(())
    }

    #[test]
    fn the_rsa_signer_and_the_pkcs12_decoder_exist() {
        // Type-level only: no RSA key generation in tests (slow in debug builds).
        fn needs_signer<S: p256::ecdsa::signature::Signer<rsa::pkcs1v15::Signature>>() {}
        needs_signer::<rsa::pkcs1v15::SigningKey<Sha256>>();
        let _ = p12_keystore::KeyStore::from_pkcs12;
        let _ = sha1::Sha1::new();
        let _ = p384::ecdsa::VerifyingKey::from_sec1_bytes;
    }
}
