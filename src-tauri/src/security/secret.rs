//! Passwords that never get a trace (ADR-047 §4, SECURITY D3).
//!
//! A [`Secret`] is made where a command's argument is deserialized, so no plain `String` password exists anywhere else. It has no
//! `Serialize`, its `Debug` is `<secret>`, and its memory is wiped on drop. The pending protection of a document sits in
//! [`SecretSlots`] (`DocState.secrets`) under a [`Ticket`]; the undo history holds the ticket only.

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::protection::PermissionSet;
use crate::pdfwrite::crypt::ProtectionRead;

/// A password: 1..=127 bytes after SASLprep, no NUL or other control character.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Checks `text`, normalizes it with SASLprep (RFC 4013, what R6 hashes) and takes a copy of the result. The length is judged
    /// after the normalization and a longer password is refused, never cut. Nothing of `text` is in the error.
    pub fn new(text: &str) -> Result<Self, AppError> {
        if text.chars().any(char::is_control) {
            return Err(AppError::invalid("password"));
        }
        let prepared = Zeroizing::new(
            stringprep::saslprep(text)
                .map_err(|_| AppError::invalid("password"))?
                .into_owned(),
        );
        let bytes = prepared.len();
        if !(limits::MIN_NEW_PASSWORD_BYTES..=limits::MAX_NEW_PASSWORD_BYTES).contains(&bytes) {
            return Err(AppError::invalid("password"));
        }
        if prepared.chars().any(char::is_control) {
            return Err(AppError::invalid("password"));
        }
        Ok(Self(prepared))
    }

    /// A password nobody knows: 32 random bytes from the OS as 64 hex digits. For the owner password of a file that only has an open
    /// password (or none): the permissions then cannot be lifted by anyone.
    pub fn random() -> Result<Self, AppError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(&mut *bytes)
            .map_err(|_| AppError::logged(ErrorCode::Internal, "no randomness"))?;
        let mut text = Zeroizing::new(String::with_capacity(64));
        for byte in bytes.iter() {
            for nibble in [byte >> 4, byte & 15] {
                text.push(char::from(b"0123456789abcdef"[usize::from(nibble)]));
            }
        }
        Ok(Self(text))
    }

    /// The password text, for the one call that hands it to the cipher.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<secret>")
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Capped;
        impl serde::de::Visitor<'_> for Capped {
            type Value = Secret;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a password")
            }
            // The cap comes before any copy: SASLprep can only shorten a password by dropping characters, and a text this long is
            // never a password. The reason is a fixed word: the text itself must not end up in an error message.
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Secret, E> {
                if text.len() > limits::MAX_PASSWORD_BYTES {
                    return Err(E::custom("invalid password"));
                }
                Secret::new(text).map_err(|_| E::custom("invalid password"))
            }
            fn visit_string<E: serde::de::Error>(self, text: String) -> Result<Secret, E> {
                let text = Zeroizing::new(text);
                self.visit_str(&text)
            }
        }
        deserializer.deserialize_str(Capped)
    }
}

/// What a staged protection change will do at the next save.
#[derive(Debug, Clone)]
pub enum PendingProtection {
    Protect {
        open: Option<Secret>,
        /// A random one if the user gave none (and then discarded).
        owner: Secret,
        allow: PermissionSet,
    },
    Remove,
}

/// The name of a [`PendingProtection`] in the slots: what the history holds instead of the passwords.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ticket(u32);

impl Ticket {
    /// The name of "nothing staged": the inverse of the first change. Never the name of a slot.
    pub const NONE: Self = Self(0);

    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// The secrets of a document's staged protection changes, and what the session knows about how the file is protected. The staged
/// secrets are cleared on save, on close and when a step leaves the history; the session password stays for the document's life.
#[derive(Default)]
pub struct SecretSlots {
    slots: HashMap<Ticket, PendingProtection>,
    next: u32,
    /// The password the file was opened with (none: the file needed none). It is the file's, not subject to the new-password rules.
    session: Option<Zeroizing<String>>,
    /// What reading the file's encryption found, until the file changes (a save).
    facts: Option<ProtectionRead>,
    /// Wrong permissions passwords in a row, and when the last one was.
    wrong: u32,
    last_wrong: Option<Instant>,
}

impl SecretSlots {
    /// Keeps `pending` and returns its ticket.
    pub fn put(&mut self, pending: PendingProtection) -> Ticket {
        self.next = self.next.wrapping_add(1);
        if self.next == Ticket::NONE.get() {
            self.next = 1;
        }
        let ticket = Ticket(self.next);
        self.slots.insert(ticket, pending);
        ticket
    }

    pub fn get(&self, ticket: Ticket) -> Option<&PendingProtection> {
        self.slots.get(&ticket)
    }

    pub fn remove(&mut self, ticket: Ticket) -> Option<PendingProtection> {
        self.slots.remove(&ticket)
    }

    /// Drops every staged secret (they are wiped by their `Drop`) and what was read of the file, which is another file after a save.
    /// The session password stays.
    pub fn clear(&mut self) {
        self.slots.clear();
        self.facts = None;
    }

    /// Drops the staged secrets that `keep` does not name.
    pub fn retain(&mut self, mut keep: impl FnMut(Ticket) -> bool) {
        self.slots.retain(|ticket, _| keep(*ticket));
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Remembers the password the document was opened with.
    pub fn set_session(&mut self, password: Option<Zeroizing<String>>) {
        self.session = password;
    }

    /// The password the document was opened with, if one was needed.
    pub fn session(&self) -> Option<&str> {
        self.session.as_ref().map(|password| password.as_str())
    }

    pub fn facts(&self) -> Option<&ProtectionRead> {
        self.facts.as_ref()
    }

    pub fn set_facts(&mut self, facts: ProtectionRead) {
        self.facts = Some(facts);
    }

    /// How long a permissions password attempt made at `now` has to wait: nothing for the first `FREE_PASSWORD_ATTEMPTS` wrong ones,
    /// then `PASSWORD_RETRY_DELAY` after the last (ADR-026).
    pub fn wait(&self, now: Instant) -> Duration {
        match self.last_wrong {
            Some(last) if self.wrong >= limits::FREE_PASSWORD_ATTEMPTS => {
                (last + limits::PASSWORD_RETRY_DELAY).saturating_duration_since(now)
            }
            _ => Duration::ZERO,
        }
    }

    pub fn note_wrong(&mut self, now: Instant) {
        self.wrong = self.wrong.saturating_add(1);
        self.last_wrong = Some(now);
    }

    pub fn note_right(&mut self) {
        self.wrong = 0;
        self.last_wrong = None;
    }
}

impl fmt::Debug for SecretSlots {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretSlots({} slots)", self.slots.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_shows_in_debug_and_is_checked() {
        let secret = Secret::new("hunter2").unwrap();
        assert_eq!(format!("{secret:?}"), "<secret>");
        assert!(Secret::new("").is_err());
        assert!(Secret::new(&"a".repeat(128)).is_err());
        assert!(Secret::new("a\0b").is_err());
        assert!(Secret::new(&"a".repeat(127)).is_ok());
        let parsed: Result<Secret, _> = serde_json::from_str(r#""bad\u0007""#);
        assert!(parsed.is_err());
    }

    #[test]
    fn the_length_is_judged_after_saslprep_and_never_cut() {
        // 64 two-byte letters are 128 bytes: one too many. 63 are 126.
        assert!(Secret::new(&"\u{e9}".repeat(64)).is_err());
        assert!(Secret::new(&"\u{e9}".repeat(63)).is_ok());
        // U+00A0 maps to a space and U+00AD to nothing: what is left is what counts.
        assert_eq!(Secret::new("a\u{a0}b\u{ad}").unwrap().expose(), "a b");
        assert!(Secret::new("\u{ad}").is_err());
        // The compatibility form is normalized (NFKC): the ligature becomes two letters.
        assert_eq!(Secret::new("\u{fb01}x").unwrap().expose(), "fix");
        // A password that stringprep prohibits is refused, with nothing of it in the error.
        let error = Secret::new("Q\u{200e}Z").unwrap_err();
        assert!(!format!("{error:?}{error}").contains(['Q', 'Z']));
    }

    #[test]
    fn a_random_secret_is_64_hex_digits_and_different_each_time() {
        let (a, b) = (Secret::random().unwrap(), Secret::random().unwrap());
        assert_eq!(a.expose().len(), 64);
        assert!(a.expose().bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a.expose(), b.expose());
    }

    #[test]
    fn slots_hand_out_tickets_and_forget_them() {
        let mut slots = SecretSlots::default();
        let a = slots.put(PendingProtection::Remove);
        let b = slots.put(PendingProtection::Remove);
        assert_ne!(a, b);
        assert_ne!(a, Ticket::NONE);
        assert!(slots.get(a).is_some());
        assert!(slots.remove(a).is_some());
        assert!(slots.get(a).is_none());
        slots.retain(|ticket| ticket == a);
        assert!(slots.is_empty());
        slots.put(PendingProtection::Remove);
        slots.clear();
        assert!(slots.is_empty());
        assert_eq!(format!("{slots:?}"), "SecretSlots(0 slots)");
    }

    #[test]
    fn clearing_keeps_the_session_password_and_nothing_else() {
        let mut slots = SecretSlots::default();
        slots.set_session(Some(Zeroizing::new("pw".to_owned())));
        slots.put(PendingProtection::Remove);
        slots.clear();
        assert_eq!(slots.session(), Some("pw"));
        assert!(slots.is_empty() && slots.facts().is_none());
    }

    #[test]
    fn the_third_wrong_permissions_password_makes_the_next_wait() {
        let mut slots = SecretSlots::default();
        let start = Instant::now();
        for _ in 0..limits::FREE_PASSWORD_ATTEMPTS {
            assert_eq!(slots.wait(start), Duration::ZERO);
            slots.note_wrong(start);
        }
        assert_eq!(slots.wait(start), limits::PASSWORD_RETRY_DELAY);
        assert_eq!(
            slots.wait(start + limits::PASSWORD_RETRY_DELAY),
            Duration::ZERO
        );
        slots.note_right();
        assert_eq!(slots.wait(start), Duration::ZERO);
    }
}
