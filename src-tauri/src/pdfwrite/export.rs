// owned by package C
//! Export a copy (ADR-049 §5): the options and the annotation stripping.

use lopdf::Document;
use serde::Deserialize;

use crate::error::AppError;

/// What happens to the annotations of the copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationsMode {
    Keep,
    Flatten,
    Remove,
}

/// What `export_pdf` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfExportOptions {
    pub annotations: AnnotationsMode,
    pub remove_metadata: bool,
}

/// Drops every `/Annots` entry except `/Link` and `/Widget` (and orphaned `/Popup`s); answers how many were removed. Stub
/// (package C): `not_yet`.
pub fn strip_annotations(_doc: &mut Document) -> Result<u32, AppError> {
    Err(AppError::not_yet())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_parse_from_the_wire() {
        let opts: PdfExportOptions =
            serde_json::from_str(r#"{"annotations":"flatten","removeMetadata":true}"#).unwrap();
        assert_eq!(opts.annotations, AnnotationsMode::Flatten);
        assert!(opts.remove_metadata);
        assert!(serde_json::from_str::<PdfExportOptions>(
            r#"{"annotations":"hide","removeMetadata":true}"#
        )
        .is_err());
    }
}
