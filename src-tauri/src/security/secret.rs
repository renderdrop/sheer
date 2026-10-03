//! Passwords that never get a trace (ADR-047 §4, SECURITY D3). owned by package D.
//!
//! A [`Secret`] is made where a command's argument is deserialized, so no plain `String` password exists anywhere else. It has no
//! `Serialize`, its `Debug` is `<secret>`, and its memory is wiped on drop. The pending protection of a document sits in
//! [`SecretSlots`] (`DocState.secrets`) under a [`Ticket`]; the undo history holds the ticket only.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use zeroize::Zeroizing;

use crate::error::AppError;
use crate::limits;
use crate::model::protection::PermissionSet;

/// A password: 1..=127 bytes, no NUL or other control character.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Checks `text` and takes a copy of it. Package D: the SASLprep normalization of R6 (`stringprep`) belongs here, and the length
    /// is judged after it.
    pub fn new(text: &str) -> Result<Self, AppError> {
        let bytes = text.len();
        if !(limits::MIN_NEW_PASSWORD_BYTES..=limits::MAX_NEW_PASSWORD_BYTES).contains(&bytes) {
            return Err(AppError::invalid("password"));
        }
        if text.chars().any(char::is_control) {
            return Err(AppError::invalid("password"));
        }
        Ok(Self(Zeroizing::new(text.to_owned())))
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
        let text = Zeroizing::new(String::deserialize(deserializer)?);
        // The reason is a fixed word: the text itself must not end up in an error message.
        Self::new(&text).map_err(|_| serde::de::Error::custom("invalid password"))
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
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// The secrets of a document's staged protection changes. Cleared on save, on close and when a step leaves the history.
#[derive(Default)]
pub struct SecretSlots {
    slots: HashMap<Ticket, PendingProtection>,
    next: u32,
}

impl SecretSlots {
    /// Keeps `pending` and returns its ticket.
    pub fn put(&mut self, pending: PendingProtection) -> Ticket {
        self.next = self.next.wrapping_add(1);
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

    /// Drops every secret (they are wiped by their `Drop`).
    pub fn clear(&mut self) {
        self.slots.clear();
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
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
    fn slots_hand_out_tickets_and_forget_them() {
        let mut slots = SecretSlots::default();
        let a = slots.put(PendingProtection::Remove);
        let b = slots.put(PendingProtection::Remove);
        assert_ne!(a, b);
        assert!(slots.get(a).is_some());
        assert!(slots.remove(a).is_some());
        assert!(slots.get(a).is_none());
        slots.clear();
        assert!(slots.is_empty());
        assert_eq!(format!("{slots:?}"), "SecretSlots(0 slots)");
    }
}
