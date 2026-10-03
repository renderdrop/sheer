//! Document metadata as the model has it (ADR-047 §5). owned by package D.
//!
//! `get_metadata` reads the file once; a [`DocCommand::SetMetadata`] or [`DocCommand::RemoveMetadata`] changes what the model holds
//! ([`MetadataState`]), and the next save writes it (`pdfwrite::metadata`).

use serde::{Deserialize, Serialize};

use super::command::DocCommand;
use super::doc_state::{Delta, DocState};
use crate::error::AppError;

/// `Some(None)` for an explicit `null` (clear the field), `None` for a missing key (leave it).
fn nullable<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

/// The fields the UI may edit (`MetadataPatch`): at most 1 000 characters each, controls stripped (checked by [`set`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataPatch {
    #[serde(default, deserialize_with = "nullable")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub author: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub subject: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub keywords: Option<Option<String>>,
}

/// The values that go into `/Info` (and the regenerated XMP).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetadataValues {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
}

/// What `DocState` holds of the metadata: the values as the file has them and as the session has them (both `None` until read), and
/// whether a removal is staged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetadataState {
    pub clean: Option<MetadataValues>,
    pub current: Option<MetadataValues>,
    pub strip: bool,
    /// The file has an XMP packet (a save regenerates it from the values).
    pub had_xmp: bool,
}

impl MetadataState {
    /// Something is staged for the next save.
    pub fn is_pending(&self) -> bool {
        self.strip || self.current != self.clean
    }

    /// What a save writes of the metadata: a removal, or the session's values if they differ from the file's.
    pub fn change(&self) -> Option<MetadataChange> {
        if self.strip {
            return Some(MetadataChange::Strip);
        }
        match (&self.current, &self.clean) {
            (Some(values), clean) if Some(values) != clean.as_ref() => Some(MetadataChange::Set {
                values: values.clone(),
                had_xmp: self.had_xmp,
            }),
            _ => None,
        }
    }
}

/// What a save writes of the metadata (`SavePlan.metadata`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataChange {
    /// A new `/Info` (and a regenerated XMP packet if the file had one).
    Set {
        values: MetadataValues,
        had_xmp: bool,
    },
    /// No `/Info`, no `/Metadata`, no `/PieceInfo`; a Full save.
    Strip,
}

/// Whether the XMP packet is there and how large (never parsed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct XmpInfo {
    pub present: bool,
    pub bytes: u64,
}

/// What a metadata edit is staged as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataPending {
    None,
    Edited,
    Remove,
}

/// The answer of `get_metadata`. Strings come from the file and passed the display-name filter; dates are ISO 8601 or `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub pdf_version: String,
    pub file_bytes: u64,
    pub xmp: XmpInfo,
    pub truncated: bool,
    pub pending: MetadataPending,
}

/// Runs [`DocCommand::SetMetadata`]: applies `patch` to the session's values and returns the command that puts the old ones back.
/// Package D.
pub(crate) fn set(
    _state: &mut DocState,
    _patch: &MetadataPatch,
    _delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    Err(AppError::not_yet())
}

/// Runs [`DocCommand::RemoveMetadata`]: stages the removal and returns its inverse. Package D.
pub(crate) fn remove(_state: &mut DocState, _delta: &mut Delta) -> Result<DocCommand, AppError> {
    Err(AppError::not_yet())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_tells_null_from_missing() {
        let patch: MetadataPatch = serde_json::from_str(r#"{"title":null,"author":"A"}"#).unwrap();
        assert_eq!(patch.title, Some(None));
        assert_eq!(patch.author, Some(Some("A".to_owned())));
        assert_eq!(patch.subject, None);
        assert!(serde_json::from_str::<MetadataPatch>(r#"{"creator":"x"}"#).is_err());
    }

    #[test]
    fn pending_means_staged_or_different() {
        let mut state = MetadataState::default();
        assert!(!state.is_pending());
        state.strip = true;
        assert!(state.is_pending());
        assert_eq!(state.change(), Some(MetadataChange::Strip));
        state.strip = false;
        assert_eq!(state.change(), None);
        state.clean = Some(MetadataValues::default());
        state.current = Some(MetadataValues {
            title: Some("T".to_owned()),
            ..MetadataValues::default()
        });
        assert!(matches!(state.change(), Some(MetadataChange::Set { .. })));
    }
}
