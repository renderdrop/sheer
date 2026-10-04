//! Making and placing signatures (ADR-041 §5, §6, §8, ADR-042). The library of saved signatures is `commands::library`.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `create_drawn_signature` | `role`, `outlines: DrawCmd[][]` (cubic Bézier outlines in pad pixels; `['M',x,y]`, `['L',x,y]`, `['C',x1,y1,x2,y2,x,y]`, `['Z']`) | `SignatureDraft`; validated (at most 64 paths, 20 000 commands), trimmed and scaled to 1 000 units high by Rust, never simplified |
//! | `create_typed_signature` | `role`, `text` (1 to 64 characters, no control characters), `font: "dancingScript" | "greatVibes" | "alexBrush"` | `SignatureDraft`; `invalid_argument` (`glyph`) for a character the font lacks |
//! | `import_signature_image` | `role`, `removeBackground` | `SignatureDraft`, or `null` if the native dialog was cancelled; PNG or JPEG, at most 10 MiB and 4 000 px a side, re-encoded as a PNG without metadata, at most 3 000 px on the long side (never upscaled), near-white fades to transparent |
//! | `save_draft_signature` | `draftId`, `name` | the library's `ItemInfo` of the new entry (the art never crosses IPC for it) |
//! | `discard_signature_draft` | `draftId` | nothing; frees the draft (a draft that is gone already is not an error) |
//! | `get_signature_preview` | `art: SignatureRef`, `maxPx` (16 to 1 024) | an `SHR1` frame (PNG) of raster art |
//! | `use_signature` | `docId`, `art: SignatureRef` | `AssetInfo`: the art is copied into the document's assets; then the UI creates a `signature` annotation with its id |
//!
//! No path crosses IPC: the picture is chosen in a dialog opened here, and art reaches the UI as vector paths or as a frame.

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::library::LibraryState;
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::model::annotation::SignatureRole;
use crate::model::ids::AssetId;
use crate::signatures::{
    convert, preview_frame, raster, typed, vector, Art, DraftId, SignatureArt, SignatureDraft,
};
use crate::signatures::{DrawCmd, Outlines};
use crate::storage::signatures::ItemInfo;

pub use crate::signatures::typed::TypedFont;

/// Where the art of a request is: a draft, a library entry, or an asset of a document.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SignatureRef {
    Draft {
        id: DraftId,
    },
    Library {
        id: String,
    },
    Asset {
        doc_id: DocumentId,
        asset_id: AssetId,
    },
}

/// What `use_signature` answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub asset_id: AssetId,
    /// Width over height.
    pub aspect: f32,
    pub art: SignatureArt,
}

/// The smallest and largest preview side.
pub const PREVIEW_PX: std::ops::RangeInclusive<u16> = 16..=1024;

fn library_id(id: &str) -> Result<&str, AppError> {
    if id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(id)
    } else {
        Err(AppError::invalid("item"))
    }
}

impl AppState {
    pub fn create_drawn_signature(
        &self,
        role: SignatureRole,
        outlines: &[Vec<DrawCmd>],
    ) -> Result<SignatureDraft, AppError> {
        Ok(self.drafts.add(role, vector::normalize(outlines)?))
    }

    pub fn create_typed_signature(
        &self,
        role: SignatureRole,
        text: &str,
        font: TypedFont,
    ) -> Result<SignatureDraft, AppError> {
        Ok(self.drafts.add(role, typed::outlines(text, font)?))
    }

    /// A draft of the picture at `path`, as the dialog gave it.
    pub fn import_signature_file(
        &self,
        role: SignatureRole,
        path: &std::path::Path,
        remove_background: bool,
    ) -> Result<SignatureDraft, AppError> {
        let bytes = raster::read_picked(path)?;
        Ok(self
            .drafts
            .add(role, raster::import(&bytes, remove_background)?))
    }

    /// The art `reference` names. A library entry is read through `library` (a missing one is `not_found`).
    fn signature_art(
        &self,
        reference: &SignatureRef,
        library: Option<&LibraryState>,
    ) -> Result<(Option<SignatureRole>, std::sync::Arc<Art>), AppError> {
        match reference {
            SignatureRef::Draft { id } => {
                let (role, art) = self
                    .drafts
                    .get(*id)
                    .ok_or_else(|| AppError::not_found("draft"))?;
                Ok((Some(role), art))
            }
            SignatureRef::Library { id } => {
                let library = library.ok_or_else(|| AppError::not_found("signature"))?;
                let source = library.source(library_id(id)?)?;
                Ok((
                    Some(convert::role_from_stored(source.role)),
                    std::sync::Arc::new(convert::from_stored(&source.art)?),
                ))
            }
            SignatureRef::Asset { doc_id, asset_id } => {
                let art = self.model(*doc_id, |state| {
                    state
                        .assets()
                        .get(*asset_id)
                        .cloned()
                        .ok_or_else(|| AppError::not_found("asset"))
                })?;
                Ok((None, art))
            }
        }
    }

    /// An `SHR1` frame of the raster art `reference` names, at most `max_px` on its long side.
    pub fn signature_preview(
        &self,
        reference: &SignatureRef,
        max_px: u16,
        library: Option<&LibraryState>,
    ) -> Result<Vec<u8>, AppError> {
        if !PREVIEW_PX.contains(&max_px) {
            return Err(AppError::invalid("maxPx"));
        }
        let (_, art) = self.signature_art(reference, library)?;
        let Art::Raster { png, .. } = &*art else {
            return Err(AppError::invalid("art"));
        };
        let (width, height, png) = raster::preview(png, u32::from(max_px))?;
        Ok(preview_frame(width, height, &png))
    }

    /// Copies the art into the assets of document `doc_id`.
    pub fn use_signature(
        &self,
        doc_id: DocumentId,
        reference: &SignatureRef,
        library: Option<&LibraryState>,
    ) -> Result<AssetInfo, AppError> {
        let (_, art) = self.signature_art(reference, library)?;
        let asset_id = self.model(doc_id, |state| state.assets_mut().add(&art))?;
        Ok(AssetInfo {
            asset_id,
            aspect: art.aspect(),
            art: art.wire(),
        })
    }

    /// Forgets a draft. Idempotent: a draft that is gone is not an error.
    pub fn discard_signature_draft(&self, draft: DraftId) {
        self.drafts.discard(draft);
    }

    /// Saves a draft in the library under `name`.
    pub fn save_draft_signature(
        &self,
        library: &LibraryState,
        draft: DraftId,
        name: &str,
    ) -> Result<ItemInfo, AppError> {
        let (role, art) = self
            .drafts
            .get(draft)
            .ok_or_else(|| AppError::not_found("draft"))?;
        Ok(library.save(
            convert::role_to_stored(role),
            name,
            convert::to_stored(&art),
        )?)
    }
}

/// A drawn signature or initials.
#[tauri::command]
pub async fn create_drawn_signature(
    state: State<'_, AppState>,
    role: SignatureRole,
    outlines: Outlines,
) -> Result<SignatureDraft, UiError> {
    let state = state.inner().clone();
    blocking(move || state.create_drawn_signature(role, &outlines.0)).await
}

/// A typed signature or initials.
#[tauri::command]
pub async fn create_typed_signature(
    state: State<'_, AppState>,
    role: SignatureRole,
    text: String,
    font: TypedFont,
) -> Result<SignatureDraft, UiError> {
    let state = state.inner().clone();
    blocking(move || state.create_typed_signature(role, &text, font)).await
}

/// Asks for a picture in a native dialog and makes a signature of it; `null` if the dialog was cancelled.
#[tauri::command]
pub async fn import_signature_image(
    window: WebviewWindow,
    state: State<'_, AppState>,
    role: SignatureRole,
    remove_background: bool,
) -> Result<Option<SignatureDraft>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Image", &["png", "jpg", "jpeg"])
            .blocking_pick_file();
        let Some(file) = picked else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        state
            .import_signature_file(role, &path, remove_background)
            .map(Some)
    })
    .await
}

/// Saves a draft in the library.
#[tauri::command]
pub async fn save_draft_signature(
    state: State<'_, AppState>,
    library: State<'_, LibraryState>,
    draft_id: DraftId,
    name: String,
) -> Result<ItemInfo, UiError> {
    let state = state.inner().clone();
    let library = std::sync::Arc::clone(library.inner());
    blocking(move || state.save_draft_signature(&library, draft_id, &name)).await
}

/// Frees a draft the UI will not use any more (the sheet closed, or the text it made one of changed).
#[tauri::command]
pub async fn discard_signature_draft(
    state: State<'_, AppState>,
    draft_id: DraftId,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || {
        state.discard_signature_draft(draft_id);
        Ok(())
    })
    .await
}

/// A frame of raster art.
#[tauri::command]
pub async fn get_signature_preview(
    state: State<'_, AppState>,
    library: State<'_, LibraryState>,
    art: SignatureRef,
    max_px: u16,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    let library = std::sync::Arc::clone(library.inner());
    blocking(move || state.signature_preview(&art, max_px, Some(&library)))
        .await
        .map(Response::new)
}

/// Copies art into a document's assets.
#[tauri::command]
pub async fn use_signature(
    state: State<'_, AppState>,
    library: State<'_, LibraryState>,
    doc_id: DocumentId,
    art: SignatureRef,
) -> Result<AssetInfo, UiError> {
    let state = state.inner().clone();
    let library = std::sync::Arc::clone(library.inner());
    blocking(move || state.use_signature(doc_id, &art, Some(&library))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refs_parse_by_type_and_refuse_extra_keys() {
        let draft: SignatureRef =
            serde_json::from_value(json!({"type": "draft", "id": 3})).unwrap();
        assert_eq!(draft, SignatureRef::Draft { id: DraftId(3) });
        let asset: SignatureRef =
            serde_json::from_value(json!({"type": "asset", "docId": 1, "assetId": 2})).unwrap();
        assert!(matches!(asset, SignatureRef::Asset { .. }));
        assert!(serde_json::from_value::<SignatureRef>(
            json!({"type": "draft", "id": 3, "path": "x"})
        )
        .is_err());
        assert!(serde_json::from_value::<SignatureRef>(json!({"type": "file"})).is_err());
    }

    #[test]
    fn a_discarded_draft_is_gone_and_discarding_twice_is_fine() {
        let drafts = crate::signatures::DraftStore::default();
        let art = Art::Vector {
            w: 10.0,
            h: 10.0,
            paths: vec![vec![
                DrawCmd::M(0.0, 0.0),
                DrawCmd::L(1.0, 0.0),
                DrawCmd::L(1.0, 1.0),
                DrawCmd::Z,
            ]],
        };
        let one = drafts.add(SignatureRole::Signature, art.clone());
        let two = drafts.add(SignatureRole::Initials, art);
        assert!(drafts.discard(one.id));
        assert!(drafts.get(one.id).is_none());
        assert!(!drafts.discard(one.id));
        assert!(drafts.get(two.id).is_some(), "the others stay");
    }

    #[test]
    fn library_ids_are_32_lowercase_hex() {
        assert!(library_id(&"0".repeat(32)).is_ok());
        assert!(library_id("../x").is_err());
        assert!(library_id(&"F".repeat(32)).is_err());
    }
}
