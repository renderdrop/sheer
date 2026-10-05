//! The seam between the identity store (B1) and the signer (B2), ADR-121: what a signature is made with. B1 builds a
//! [`SignerMaterial`] from a stored identity and hands it to B2 for one signature; nothing of it crosses to the webview, and the
//! key types wipe themselves when dropped.

use x509_cert::Certificate;

/// A private signing key of one of the algorithms ADR-121 allows.
pub enum SignerKey {
    /// ECDSA P-256 with SHA-256 (the self-generated default).
    EcdsaP256(p256::ecdsa::SigningKey),
    /// ECDSA P-384 with SHA-384 (imported certificates).
    EcdsaP384(p384::ecdsa::SigningKey),
    /// RSA PKCS#1 v1.5 with SHA-256 (imported certificates; signing only, never decryption: SECURITY R14).
    Rsa(Box<rsa::RsaPrivateKey>),
}

/// The key and the certificate chain of one signature: `chain[0]` is the signer's certificate, then its issuers as stored.
pub struct SignerMaterial {
    pub key: SignerKey,
    pub chain: Vec<Certificate>,
}

impl SignerMaterial {
    /// The signer's own certificate (`chain[0]`), or `None` for an empty chain, which the signer refuses.
    pub fn signer_certificate(&self) -> Option<&Certificate> {
        self.chain.first()
    }
}
