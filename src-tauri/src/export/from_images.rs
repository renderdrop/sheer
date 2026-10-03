// owned by package B
//! Images to PDF (ADR-049 §3): options, the open dialog or a dropped batch, geometry and the job.

use std::sync::Arc;

use serde::Deserialize;
use tauri::WebviewWindow;

use crate::commands::jobs::{EventSink, JobId};
use crate::commands::AppState;
use crate::error::AppError;

/// The page size of every page: the image's own (`fit`), A4 or Letter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaperSize {
    Fit,
    A4,
    Letter,
}

/// Page orientation: by the image's aspect (`auto`) or fixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

/// Where the images come from: the Rust open dialog, or a batch held from a drop (`AppEvent::ImagesDropped`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ImageSource {
    Dialog,
    Batch { batch: u32 },
}

/// What `images_to_pdf` takes. `margin_pt` is 0..=72.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImagesToPdfOptions {
    pub source: ImageSource,
    pub paper: PaperSize,
    pub orientation: Orientation,
    pub margin_pt: f32,
}

/// Picks or takes the images, asks for the target and starts the job; `None` when a dialog was cancelled. Stub (package B): `not_yet`.
pub fn start(
    _state: &AppState,
    _window: &WebviewWindow,
    _opts: &ImagesToPdfOptions,
    _sink: Arc<dyn EventSink>,
) -> Result<Option<JobId>, AppError> {
    Err(AppError::not_yet())
}

/// Lets go of a dropped batch; an unknown id is not an error. Stub (package B): `not_yet`.
pub fn release_batch(_state: &AppState, _batch: u32) -> Result<(), AppError> {
    Err(AppError::not_yet())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_parse_from_the_wire() {
        let opts: ImagesToPdfOptions = serde_json::from_str(
            r#"{"source":{"type":"batch","batch":3},"paper":"letter","orientation":"auto","marginPt":34}"#,
        )
        .unwrap();
        assert_eq!(opts.source, ImageSource::Batch { batch: 3 });
        assert_eq!(opts.paper, PaperSize::Letter);
        let dialog: ImagesToPdfOptions = serde_json::from_str(
            r#"{"source":{"type":"dialog"},"paper":"fit","orientation":"landscape","marginPt":0}"#,
        )
        .unwrap();
        assert_eq!(dialog.source, ImageSource::Dialog);
        assert!(serde_json::from_str::<ImagesToPdfOptions>(
            r#"{"source":{"type":"dialog"},"paper":"a3","orientation":"auto","marginPt":0}"#
        )
        .is_err());
    }
}
