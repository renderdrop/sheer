//! Password protection and permissions as the model has them (ADR-047 §4). owned by package D.
//!
//! The UI stages a change (`stage_protection`, `stage_unprotection`); it becomes [`DocCommand::SetProtection`] holding a
//! [`Ticket`], and the passwords stay in `DocState.secrets`. The next save writes it (`pdfwrite::crypt`).

use serde::{Deserialize, Serialize};

use super::command::DocCommand;
use super::doc_state::{Delta, DocPart, DocState};
use crate::error::AppError;
use crate::security::secret::{PendingProtection, Secret, Ticket};

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

impl<'de> serde::Deserialize<'de> for PermissionSet {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<Permission>::deserialize(deserializer).map(|list| Self::from_list(&list))
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
/// command that puts the previous one back. [`Ticket::NONE`] is "nothing staged".
pub(crate) fn run_set_protection(
    state: &mut DocState,
    ticket: Ticket,
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    if ticket != Ticket::NONE && state.secrets().get(ticket).is_none() {
        return Err(AppError::invalid("protection"));
    }
    let previous = state.pending_protection.unwrap_or(Ticket::NONE);
    state.set_pending_protection((ticket != Ticket::NONE).then_some(ticket));
    delta.doc.insert(DocPart::Protection);
    // The secrets of steps that are gone (pushed out of the history, or redo steps a new step dropped) are wiped now. The two tickets
    // of this step are kept: the new one is pending and the previous one is in the inverse that is recorded next.
    let mut keep = state.history.protection_tickets();
    keep.extend([ticket, previous]);
    state.secrets_mut().retain(|slot| keep.contains(&slot));
    Ok(DocCommand::SetProtection { ticket: previous })
}

/// What `stage_protection` makes of its options: the checks of ADR-047 §4 and the secrets filed in `state.secrets`. A restriction needs a
/// permissions password that differs from the open password; without any restriction and without a permissions password a random one is
/// made and nobody knows it. Passwords alone (all allowed) are a protection too; nothing at all is not.
pub(crate) fn stage_protect(
    state: &mut DocState,
    options: &ProtectOptions,
) -> Result<Ticket, AppError> {
    let allow = PermissionSet::from_list(&options.allow);
    let restricted = allow != PermissionSet::ALL;
    let open = options.open_password.clone();
    if open.is_none() && options.permissions_password.is_none() && !restricted {
        return Err(AppError::invalid("password"));
    }
    let owner = match &options.permissions_password {
        Some(owner) => {
            let same = open
                .as_ref()
                .is_some_and(|open| open.expose() == owner.expose());
            if restricted && same {
                return Err(AppError::invalid("ownerPassword"));
            }
            owner.clone()
        }
        None if restricted => return Err(AppError::invalid("ownerPassword")),
        None => Secret::random()?,
    };
    Ok(state
        .secrets_mut()
        .put(PendingProtection::Protect { open, owner, allow }))
}

/// What `stage_unprotection` stages once the caller has checked the owner rights: the removal of the file's protection, or (for a file
/// that has none, with a protection staged) nothing staged again. A file with neither has nothing to remove.
pub(crate) fn stage_remove(state: &mut DocState, encrypted: bool) -> Result<Ticket, AppError> {
    if encrypted {
        return Ok(state.secrets_mut().put(PendingProtection::Remove));
    }
    match state.pending_protection() {
        Some((_, PendingProtection::Protect { .. })) => Ok(Ticket::NONE),
        _ => Err(AppError::invalid("protection")),
    }
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

    fn state() -> DocState {
        DocState::new(1)
    }

    fn stamp() -> crate::model::doc_state::Stamp {
        crate::model::doc_state::Stamp {
            now_ms: 0,
            modified: "t".to_owned(),
        }
    }

    fn options(open: Option<&str>, owner: Option<&str>, allow: &[Permission]) -> ProtectOptions {
        ProtectOptions {
            open_password: open.map(|p| Secret::new(p).unwrap()),
            permissions_password: owner.map(|p| Secret::new(p).unwrap()),
            allow: allow.to_vec(),
        }
    }

    #[test]
    fn a_restriction_needs_another_permissions_password() {
        let mut state = state();
        let print = [Permission::Print];
        for bad in [
            options(Some("a"), None, &print),
            options(Some("a"), Some("a"), &print),
            options(None, None, &print),
        ] {
            let error = stage_protect(&mut state, &bad).unwrap_err();
            assert_eq!(error.code(), crate::error::ErrorCode::InvalidArgument);
        }
        let nothing = options(
            None,
            None,
            &[Permission::Print, Permission::Copy, Permission::Edit],
        );
        assert!(stage_protect(&mut state, &nothing).is_err());
        assert!(state.secrets().is_empty(), "a refused option files nothing");
        // Passwords alone are a protection; an open password alone gets a random owner password.
        let all = [Permission::Print, Permission::Copy, Permission::Edit];
        let ticket = stage_protect(&mut state, &options(Some("a"), None, &all)).unwrap();
        let Some(PendingProtection::Protect { owner, .. }) = state.secrets().get(ticket) else {
            panic!("filed");
        };
        assert_eq!(owner.expose().len(), 64);
    }

    #[test]
    fn staging_is_one_undo_step_and_old_secrets_are_dropped() {
        let mut state = state();
        let first = stage_protect(
            &mut state,
            &options(
                Some("one"),
                None,
                &[Permission::Print, Permission::Copy, Permission::Edit],
            ),
        )
        .unwrap();
        state
            .execute(DocCommand::SetProtection { ticket: first }, &stamp())
            .unwrap();
        assert!(state.pending_protection().is_some());
        state.undo(&stamp()).unwrap();
        assert!(state.pending_protection().is_none());
        state.redo(&stamp()).unwrap();
        assert_eq!(state.pending_protection().map(|(t, _)| t), Some(first));
        // A new step drops the redo stack; the next staging wipes what only that held.
        state.undo(&stamp()).unwrap();
        let second = stage_protect(
            &mut state,
            &options(
                Some("two"),
                None,
                &[Permission::Print, Permission::Copy, Permission::Edit],
            ),
        )
        .unwrap();
        state
            .execute(DocCommand::SetProtection { ticket: second }, &stamp())
            .unwrap();
        assert!(
            state.secrets().get(first).is_some(),
            "the redo step is dropped only when the next step is recorded"
        );
        let third = stage_protect(
            &mut state,
            &options(
                Some("three"),
                None,
                &[Permission::Print, Permission::Copy, Permission::Edit],
            ),
        )
        .unwrap();
        state
            .execute(DocCommand::SetProtection { ticket: third }, &stamp())
            .unwrap();
        assert!(
            state.secrets().get(first).is_none(),
            "wiped once no step holds it"
        );
        assert!(state.secrets().get(second).is_some() && state.secrets().get(third).is_some());
        // A ticket nobody filed is refused.
        let missing = DocCommand::SetProtection {
            ticket: Ticket::new(999),
        };
        assert!(state.execute(missing, &stamp()).is_err());
    }

    #[test]
    fn a_removal_of_nothing_is_refused() {
        let mut state = state();
        assert!(stage_remove(&mut state, false).is_err());
        assert!(stage_remove(&mut state, true).is_ok());
    }
}
