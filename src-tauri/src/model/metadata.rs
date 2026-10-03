//! Document metadata as the model has it (ADR-047 §5). owned by package D.
//!
//! `get_metadata` reads the file once; a [`DocCommand::SetMetadata`] or [`DocCommand::RemoveMetadata`] changes what the model holds
//! ([`MetadataState`]), and the next save writes it (`pdfwrite::metadata`).

use serde::{Deserialize, Serialize};

use super::command::DocCommand;
use super::doc_state::{Delta, DocPart, DocState};
use crate::documents::sanitize_text;
use crate::error::AppError;
use crate::limits;

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
    /// What `get_metadata` shows besides the values; `None` until the file is read.
    pub file: Option<FileMeta>,
}

/// What the file says about itself besides the editable values (read once with them).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileMeta {
    pub created: Option<String>,
    pub modified: Option<String>,
    pub pdf_version: String,
    pub file_bytes: u64,
    pub xmp_bytes: u64,
    pub truncated: bool,
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

impl MetadataPatch {
    fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.author.is_none()
            && self.subject.is_none()
            && self.keywords.is_none()
    }

    /// The patch that sets exactly the editable fields of `values`: the inverse of whatever changed them.
    fn restoring(values: &MetadataValues) -> Self {
        Self {
            title: Some(values.title.clone()),
            author: Some(values.author.clone()),
            subject: Some(values.subject.clone()),
            keywords: Some(values.keywords.clone()),
        }
    }

    /// Checks the sizes the UI sent (`invalid_argument` for a control or format character, `limit_exceeded` for more than
    /// `MAX_METADATA_FIELD_CHARS` characters), before anything runs.
    pub fn check(&self) -> Result<(), AppError> {
        for text in [&self.title, &self.author, &self.subject, &self.keywords]
            .into_iter()
            .flatten()
            .flatten()
        {
            if text.chars().count() > limits::MAX_METADATA_FIELD_CHARS {
                return Err(AppError::limit(
                    "metadata",
                    limits::MAX_METADATA_FIELD_CHARS as u64,
                ));
            }
            if sanitize_text(text, usize::MAX) != *text {
                return Err(AppError::invalid("metadata"));
            }
        }
        Ok(())
    }
}

/// An empty text is no text.
fn some_or_none(text: &Option<String>) -> Option<String> {
    text.clone().filter(|text| !text.is_empty())
}

/// Runs [`DocCommand::SetMetadata`]: applies `patch` to the session's values and returns the command that puts the old ones back. A set
/// ends a staged removal (the removal blanked the values; undoing this step stages it again). The values must have been read
/// (`get_metadata`) unless the patch is empty.
pub(crate) fn set(
    state: &mut DocState,
    patch: &MetadataPatch,
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    patch.check()?;
    let meta = state.metadata_mut();
    let inverse = if meta.strip {
        DocCommand::RemoveMetadata
    } else {
        match &meta.current {
            Some(current) => DocCommand::SetMetadata {
                patch: MetadataPatch::restoring(current),
            },
            None => DocCommand::SetMetadata {
                patch: MetadataPatch::default(),
            },
        }
    };
    if !patch.is_empty() && meta.current.is_none() {
        return Err(AppError::invalid("metadata"));
    }
    meta.strip = false;
    if let Some(current) = &mut meta.current {
        if let Some(value) = &patch.title {
            current.title = some_or_none(value);
        }
        if let Some(value) = &patch.author {
            current.author = some_or_none(value);
        }
        if let Some(value) = &patch.subject {
            current.subject = some_or_none(value);
        }
        if let Some(value) = &patch.keywords {
            current.keywords = some_or_none(value);
        }
    }
    delta.doc.insert(DocPart::Metadata);
    Ok(inverse)
}

/// Runs [`DocCommand::RemoveMetadata`]: stages the removal (the editable values are blank from now on) and returns its inverse.
pub(crate) fn remove(state: &mut DocState, delta: &mut Delta) -> Result<DocCommand, AppError> {
    let meta = state.metadata_mut();
    let inverse = if meta.strip {
        DocCommand::RemoveMetadata
    } else {
        DocCommand::SetMetadata {
            patch: meta
                .current
                .as_ref()
                .map(MetadataPatch::restoring)
                .unwrap_or_default(),
        }
    };
    meta.strip = true;
    if let Some(current) = &mut meta.current {
        current.title = None;
        current.author = None;
        current.subject = None;
        current.keywords = None;
    }
    delta.doc.insert(DocPart::Metadata);
    Ok(inverse)
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
