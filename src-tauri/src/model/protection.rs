//! Password protection and permissions as the model has them (ADR-047 §4). owned by package D.
//!
//! The UI stages a change (`stage_protection`, `stage_unprotection`); it becomes [`DocCommand::SetProtection`] holding a
//! [`Ticket`], and the passwords stay in `DocState.secrets`. The next save writes it (`pdfwrite::crypt`).

use serde::{Deserialize, Serialize};

use super::command::DocCommand;
use super::doc_state::{Delta, DocState};
use crate::error::AppError;
use crate::security::secret::{Secret, Ticket};

/// What a restricted document may still do for an honest reader (DESIGN §3.39).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Print,
    Copy,
    Edit,
}

impl Permission {
    const fn bit(self) -> u8 {
        match self {
            Self::Print => 1,
            Self::Copy => 2,
            Self::Edit => 4,
        }
    }
}

/// A set of [`Permission`]s. Serialized as the list of its members.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PermissionSet(u8);

impl PermissionSet {
    pub const NONE: Self = Self(0);
    pub const ALL: Self = Self(1 | 2 | 4);

    pub fn from_list(list: &[Permission]) -> Self {
        Self(list.iter().fold(0, |bits, p| bits | p.bit()))
    }

    pub const fn contains(self, permission: Permission) -> bool {
        self.0 & permission.bit() != 0
    }

    pub fn to_list(self) -> Vec<Permission> {
        [Permission::Print, Permission::Copy, Permission::Edit]
            .into_iter()
            .filter(|p| self.contains(*p))
            .collect()
    }
}

impl Serialize for PermissionSet {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_list().serialize(serializer)
    }
}

/// The arguments of `stage_protection`. The passwords are [`Secret`]s from the moment they are deserialized.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectOptions {
    pub open_password: Option<Secret>,
    pub permissions_password: Option<Secret>,
    pub allow: Vec<Permission>,
}

/// How a file is encrypted, as far as it can be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtectionMethod {
    None,
    Rc4,
    Aes128,
    Aes256,
    Unknown,
}

/// What is staged for the next save.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PendingKind {
    None,
    Protect,
    Remove,
}

/// The answer of `get_protection`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionInfo {
    pub encrypted: bool,
    pub method: ProtectionMethod,
    pub owner_rights: bool,
    pub allow: Vec<Permission>,
    pub pending: PendingKind,
}

/// Runs [`DocCommand::SetProtection`]: makes the staged change (named by `ticket`) the document's pending one and returns the
/// command that puts the previous one back. Package D.
pub(crate) fn run_set_protection(
    _state: &mut DocState,
    _ticket: Ticket,
    _delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    Err(AppError::not_yet())
}

/// The first half of `stage_protection` and `stage_unprotection`: checks the options against the document and files the secrets in
/// `state.secrets`. Package D.
pub(crate) fn stage(
    _state: &mut DocState,
    _protect: Option<&ProtectOptions>,
    _remove_with: Option<&Secret>,
) -> Result<Ticket, AppError> {
    Err(AppError::not_yet())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_sets_serialize_as_lists() {
        let set = PermissionSet::from_list(&[Permission::Edit, Permission::Print]);
        assert_eq!(serde_json::to_string(&set).unwrap(), r#"["print","edit"]"#);
        assert!(!set.contains(Permission::Copy));
        assert_eq!(PermissionSet::ALL.to_list().len(), 3);
        assert_eq!(PermissionSet::NONE.to_list(), Vec::<Permission>::new());
    }

    #[test]
    fn protect_options_take_passwords_as_secrets() {
        let ok: ProtectOptions = serde_json::from_str(
            r#"{"openPassword":"abc","permissionsPassword":null,"allow":["print"]}"#,
        )
        .unwrap();
        assert!(ok.open_password.is_some() && ok.permissions_password.is_none());
        assert!(serde_json::from_str::<ProtectOptions>(
            r#"{"openPassword":"","permissionsPassword":null,"allow":[]}"#
        )
        .is_err());
        assert_eq!(format!("{ok:?}").matches("abc").count(), 0);
    }
}
