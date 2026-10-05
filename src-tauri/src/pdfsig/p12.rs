//! PKCS#12 / PFX decode for the identity import (ADR-121 section 3, SECURITY P23). The file is hostile input.
//!
//! The decoding itself is `p12-keystore` (PBES2 AES, legacy PBES1 3DES and RC2-40, HMAC-SHA1/256 MAC). That crate does not bound the
//! iteration counts a file asks for, so this module reads the DER first with a small bounded walker ([`scan_iterations`]) and refuses a
//! file whose MAC or any visible key-derivation asks for more than `limits::P12_ITER_MAX` rounds, before a single round runs. Counts
//! that hide inside encrypted content are not visible before decrypting, and a wrong password never gets that far (the MAC is
//! checked first); the decode therefore also runs on its own thread under `limits::P12_DECODE_BUDGET`.
//!
//! The password is borrowed for the one call and never copied into an error. The decoded key is handed out in a [`Zeroizing`] buffer
//! (the crate's own copy inside its key store cannot be wiped from here).

use std::sync::mpsc;

use p12_keystore::KeyStore;
use zeroize::Zeroizing;

use crate::limits;

/// Why a file did not give an identity. Says nothing about content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum P12Error {
    /// The password does not open the file (MAC or padding check failed).
    WrongPassword,
    /// Not a PKCS#12 file this module can read, a cap was exceeded, or it does not hold exactly one key with its certificate.
    Invalid,
}

/// What a decoded file holds: the leaf certificate first, then the chain as the file has it; the private key as PKCS#8 DER.
pub struct Decoded {
    pub chain: Vec<Vec<u8>>,
    pub key_pkcs8: Zeroizing<Vec<u8>>,
}

/// Most TLV nodes the pre-scan visits, and the deepest nesting it follows.
const SCAN_NODES_MAX: usize = 50_000;
const SCAN_DEPTH_MAX: usize = 24;

/// A DER element with a one-byte tag and a definite length.
struct Tlv<'a> {
    tag: u8,
    content: &'a [u8],
}

impl Tlv<'_> {
    fn constructed(&self) -> bool {
        self.tag & 0x20 != 0
    }
}

/// The element at the start of `data` and what follows it. `None` for a multi-byte tag, an indefinite or oversized length, or a
/// length that runs past `data`.
fn parse_tlv(data: &[u8]) -> Option<(Tlv<'_>, &[u8])> {
    let (&tag, rest) = data.split_first()?;
    if tag & 0x1f == 0x1f {
        return None;
    }
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let (digits, rest) = rest.split_at(count);
        let len = digits
            .iter()
            .fold(0usize, |acc, &b| (acc << 8) | usize::from(b));
        (len, rest)
    };
    if len > rest.len() {
        return None;
    }
    let (content, rest) = rest.split_at(len);
    Some((Tlv { tag, content }, rest))
}

/// Every element of `data` if it is exactly a sequence of elements.
fn parse_all(mut data: &[u8]) -> Option<Vec<Tlv<'_>>> {
    let mut out = Vec::new();
    while !data.is_empty() {
        let (tlv, rest) = parse_tlv(data)?;
        out.push(tlv);
        data = rest;
        if out.len() > SCAN_NODES_MAX {
            return None;
        }
    }
    Some(out)
}

/// A non-negative INTEGER that fits in a `u64`; `None` otherwise.
fn small_integer(tlv: &Tlv<'_>) -> Option<u64> {
    if tlv.tag != 0x02 || tlv.content.is_empty() || tlv.content[0] & 0x80 != 0 {
        return None;
    }
    let digits = match tlv.content {
        [0, rest @ ..] if !rest.is_empty() => rest,
        all => all,
    };
    if digits.len() > 8 {
        return None;
    }
    Some(
        digits
            .iter()
            .fold(0u64, |acc, &b| (acc << 8) | u64::from(b)),
    )
}

/// Whether `oid` (DER content bytes) is a PKCS#5/PKCS#12 password-based scheme whose parameters carry an iteration count: PBKDF2, the
/// PBES1 family of PKCS#5 (`1.2.840.113549.1.5.{1,3,6,10,11}`) and the PKCS#12 PBE family (`1.2.840.113549.1.12.1.*`).
fn is_kdf_oid(oid: &[u8]) -> bool {
    const PREFIX: [u8; 7] = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01];
    let Some(rest) = oid.strip_prefix(&PREFIX) else {
        return false;
    };
    matches!(
        rest,
        [0x05, 0x01 | 0x03 | 0x06 | 0x0a | 0x0b | 0x0c] | [0x0c, 0x01, _]
    )
}

struct Scan {
    nodes: usize,
}

impl Scan {
    fn walk(&mut self, items: &[Tlv<'_>], depth: usize) -> Result<(), P12Error> {
        if depth > SCAN_DEPTH_MAX {
            return Err(P12Error::Invalid);
        }
        for item in items {
            self.nodes += 1;
            if self.nodes > SCAN_NODES_MAX {
                return Err(P12Error::Invalid);
            }
            if item.tag == 0x30 {
                if let Some(children) = parse_all(item.content) {
                    check_algorithm(&children)?;
                    self.walk(&children, depth + 1)?;
                }
            } else if item.constructed() {
                if let Some(children) = parse_all(item.content) {
                    self.walk(&children, depth + 1)?;
                }
            } else if item.tag == 0x04 && item.content.first() == Some(&0x30) {
                // The content of a ContentInfo is an OCTET STRING that holds more DER.
                if let Some(children) = parse_all(item.content) {
                    self.walk(&children, depth + 1)?;
                }
            }
        }
        Ok(())
    }
}

/// `children` is the content of a SEQUENCE: if it is `AlgorithmIdentifier { kdf-oid, SEQUENCE { .. INTEGER iterations .. } }`, the
/// count must be within the cap.
fn check_algorithm(children: &[Tlv<'_>]) -> Result<(), P12Error> {
    let [oid, params, ..] = children else {
        return Ok(());
    };
    if oid.tag != 0x06 || params.tag != 0x30 || !is_kdf_oid(oid.content) {
        return Ok(());
    }
    let Some(inner) = parse_all(params.content) else {
        return Err(P12Error::Invalid);
    };
    for item in &inner {
        if item.tag == 0x02 {
            return match small_integer(item) {
                Some(n) if (1..=limits::P12_ITER_MAX).contains(&n) => Ok(()),
                _ => Err(P12Error::Invalid),
            };
        }
    }
    Err(P12Error::Invalid)
}

/// Reads the DER of a PKCS#12 file and refuses it if the MAC or a visible key derivation asks for more than `limits::P12_ITER_MAX`
/// iterations, or if the structure is not a PFX at all. Nothing is decrypted.
pub fn scan_iterations(file: &[u8]) -> Result<(), P12Error> {
    let (pfx, rest) = parse_tlv(file).ok_or(P12Error::Invalid)?;
    if pfx.tag != 0x30 || !rest.is_empty() {
        return Err(P12Error::Invalid);
    }
    let top = parse_all(pfx.content).ok_or(P12Error::Invalid)?;
    // Pfx ::= SEQUENCE { version INTEGER, authSafe ContentInfo, macData MacData OPTIONAL }
    if top.len() < 2 || top.len() > 3 || top[0].tag != 0x02 || top[1].tag != 0x30 {
        return Err(P12Error::Invalid);
    }
    if let Some(mac) = top.get(2) {
        // MacData ::= SEQUENCE { mac DigestInfo, macSalt OCTET STRING, iterations INTEGER DEFAULT 1 }
        let fields = parse_all(mac.content).ok_or(P12Error::Invalid)?;
        if mac.tag != 0x30 || fields.len() < 2 {
            return Err(P12Error::Invalid);
        }
        if let Some(iterations) = fields.get(2) {
            match small_integer(iterations) {
                Some(n) if (1..=limits::P12_ITER_MAX).contains(&n) => {}
                _ => return Err(P12Error::Invalid),
            }
        }
    }
    Scan { nodes: 0 }.walk(&top, 0)
}

/// Decodes `file` with `password`: exactly one private key with the certificate that belongs to it. `scan_iterations` runs first, then
/// the decode under the time budget.
pub fn decode(file: &[u8], password: &str) -> Result<Decoded, P12Error> {
    scan_iterations(file)?;
    let file = file.to_vec();
    let password = Zeroizing::new(password.to_owned());
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("sheer-p12".into())
        .spawn(move || {
            // A panic in the decoder drops the sender: the receiver then reports a disconnect.
            let _ = sender.send(decode_now(&file, &password));
        })
        .map_err(|_| P12Error::Invalid)?;
    receiver
        .recv_timeout(limits::P12_DECODE_BUDGET)
        .unwrap_or(Err(P12Error::Invalid))
}

fn decode_now(file: &[u8], password: &str) -> Result<Decoded, P12Error> {
    let store = KeyStore::from_pkcs12(file, password).map_err(|error| {
        use p12_keystore::error::Error;
        match error {
            // The MAC did not verify, or the padding of the decrypted data is wrong: both mean "not this password".
            Error::MacError(_) | Error::UnpadError | Error::Pkcs5Error(_) => {
                P12Error::WrongPassword
            }
            _ => P12Error::Invalid,
        }
    })?;
    let mut keys = store.entries().filter_map(|(_, entry)| match entry {
        p12_keystore::KeyStoreEntry::PrivateKeyChain(chain) => Some(chain),
        _ => None,
    });
    let (Some(chain), None) = (keys.next(), keys.next()) else {
        return Err(P12Error::Invalid);
    };
    if chain.chain().is_empty() {
        return Err(P12Error::Invalid);
    }
    Ok(Decoded {
        chain: chain
            .chain()
            .iter()
            .take(limits::SIG_CHAIN_MAX)
            .map(|cert| cert.as_der().to_vec())
            .collect(),
        key_pkcs8: Zeroizing::new(chain.key().to_vec()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        if content.len() < 0x80 {
            out.push(content.len() as u8);
        } else {
            out.push(0x82);
            out.extend_from_slice(&(content.len() as u16).to_be_bytes());
        }
        out.extend_from_slice(content);
        out
    }

    fn int(n: u64) -> Vec<u8> {
        let mut bytes: Vec<u8> = n
            .to_be_bytes()
            .into_iter()
            .skip_while(|&b| b == 0)
            .collect();
        if bytes.first().is_none_or(|b| b & 0x80 != 0) {
            bytes.insert(0, 0);
        }
        tlv(0x02, &bytes)
    }

    const PBKDF2: [u8; 9] = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c];

    /// A PFX shell: version, an empty `data` authSafe, and a MAC with `mac_iterations`.
    fn pfx(mac_iterations: u64, extra: &[u8]) -> Vec<u8> {
        let content_info = tlv(
            0x30,
            &[
                tlv(
                    0x06,
                    &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01],
                ),
                tlv(0xa0, &tlv(0x04, extra)),
            ]
            .concat(),
        );
        let mac = tlv(
            0x30,
            &[
                tlv(
                    0x30,
                    &[
                        tlv(0x30, &tlv(0x06, &[0x2b, 0x0e, 0x03, 0x02, 0x1a])),
                        tlv(0x04, &[0; 20]),
                    ]
                    .concat(),
                ),
                tlv(0x04, &[1; 8]),
                int(mac_iterations),
            ]
            .concat(),
        );
        tlv(0x30, &[int(3), content_info, mac].concat())
    }

    fn kdf(iterations: u64) -> Vec<u8> {
        tlv(
            0x30,
            &[
                tlv(0x06, &PBKDF2),
                tlv(0x30, &[tlv(0x04, &[7; 8]), int(iterations)].concat()),
            ]
            .concat(),
        )
    }

    #[test]
    fn the_mac_iteration_cap_is_enforced_before_any_work() {
        assert!(scan_iterations(&pfx(2048, &[])).is_ok());
        assert!(scan_iterations(&pfx(limits::P12_ITER_MAX, &[])).is_ok());
        assert_eq!(
            scan_iterations(&pfx(limits::P12_ITER_MAX + 1, &[])),
            Err(P12Error::Invalid)
        );
        assert_eq!(scan_iterations(&pfx(0, &[])), Err(P12Error::Invalid));
        assert_eq!(
            scan_iterations(&pfx(u64::MAX >> 1, &[])),
            Err(P12Error::Invalid)
        );
    }

    #[test]
    fn a_visible_key_derivation_is_capped_too_also_inside_an_octet_string() {
        let wrapped = tlv(0x30, &kdf(1_000));
        assert!(scan_iterations(&pfx(1, &wrapped)).is_ok());
        let hostile = tlv(0x30, &kdf(4_000_000_000));
        assert_eq!(scan_iterations(&pfx(1, &hostile)), Err(P12Error::Invalid));
        // An integer too long for a u64 is refused, not wrapped.
        let huge = tlv(
            0x30,
            &tlv(
                0x30,
                &[
                    tlv(0x06, &PBKDF2),
                    tlv(0x30, &[tlv(0x04, &[7; 8]), tlv(0x02, &[0x01; 12])].concat()),
                ]
                .concat(),
            ),
        );
        assert_eq!(scan_iterations(&pfx(1, &huge)), Err(P12Error::Invalid));
    }

    #[test]
    fn nesting_and_garbage_are_bounded() {
        let mut deep = tlv(0x30, &[]);
        for _ in 0..(SCAN_DEPTH_MAX + 8) {
            deep = tlv(0x30, &deep);
        }
        assert_eq!(scan_iterations(&pfx(1, &deep)), Err(P12Error::Invalid));
        for bad in [
            &b""[..],
            b"\x30",
            b"\x30\x80\x00\x00",
            b"not a pfx at all",
            &[0x30, 0x84, 0xff, 0xff, 0xff, 0xff],
        ] {
            assert_eq!(scan_iterations(bad), Err(P12Error::Invalid));
        }
        // Trailing bytes after the PFX.
        let mut trailing = pfx(1, &[]);
        trailing.push(0);
        assert_eq!(scan_iterations(&trailing), Err(P12Error::Invalid));
    }

    #[test]
    fn decoding_garbage_is_invalid_not_a_panic() {
        assert_eq!(decode(b"junk", "pw").err(), Some(P12Error::Invalid));
        // A well-formed shell with a MAC that cannot verify is "not this password", never an identity.
        assert!(decode(&pfx(1, &[]), "pw").is_err());
    }
}
