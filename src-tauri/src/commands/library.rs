//! The signature library commands (ADR-041 section 7, ADR-042 section 5): the saved signatures and initials, encrypted at rest.
//! Thin wrappers over [`Library`] (`storage::signatures`), which holds the logic. Every call runs on the blocking pool (the
//! keychain may take a moment, and macOS may ask the user for access).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_signatures` | none | `{ status: "ready" \| "unavailable" \| "locked", items: ItemInfo[] }`: metadata and a small vector preview, never the full art |
//! | `save_library_signature` | `role`, `name`, `art` | the new `ItemInfo`; at most 8 per role (`limit_exceeded`, `signatures`); `locked` is `invalid_argument` (`library`); without a keychain the entry lives for the session |
//! | `rename_signature` | `itemId`, `name` | nothing; unknown id is `not_found` |
//! | `delete_signature` | `itemId` | nothing; unknown id is `not_found` |
//! | `get_library_signature` | `itemId` | `{ id, role, art }`: the entry as a source to place |
//! | `clear_signature_library` | none | nothing; deletes the file and the key (the way out of `locked`) |
//!
//! `art` is `{ vector: { w, h, paths } }` or `{ raster: { w, h, png } }` (`png` is base64), at most 512 KiB.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::error::{AppError, UiError};
use crate::storage::signatures::{Art, ItemInfo, Library, Listing, Role, Source};

/// The library, shared by the commands (managed by Tauri, created in `lib.rs`).
pub type LibraryState = Arc<Library>;

/// An id as the UI sends it: 32 lowercase hex characters. Anything else is refused before the library is read.
fn checked_id(id: &str) -> Result<&str, AppError> {
    if id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(id)
    } else {
        Err(AppError::invalid("item"))
    }
}

/// The saved signatures and initials with the state of the library.
#[tauri::command]
pub async fn list_signatures(library: State<'_, LibraryState>) -> Result<Listing, UiError> {
    let library = Arc::clone(library.inner());
    blocking(move || Ok(library.list()?)).await
}

/// Saves a signature or initials.
#[tauri::command]
pub async fn save_library_signature(
    library: State<'_, LibraryState>,
    role: Role,
    name: String,
    art: Art,
) -> Result<ItemInfo, UiError> {
    let library = Arc::clone(library.inner());
    blocking(move || Ok(library.save(role, &name, art)?)).await
}

/// Renames an entry.
#[tauri::command]
pub async fn rename_signature(
    library: State<'_, LibraryState>,
    item_id: String,
    name: String,
) -> Result<(), UiError> {
    let library = Arc::clone(library.inner());
    blocking(move || Ok(library.rename(checked_id(&item_id)?, &name)?)).await
}

/// Deletes an entry.
#[tauri::command]
pub async fn delete_signature(
    library: State<'_, LibraryState>,
    item_id: String,
) -> Result<(), UiError> {
    let library = Arc::clone(library.inner());
    blocking(move || Ok(library.delete(checked_id(&item_id)?)?)).await
}

/// The entry as the source of a placement.
#[tauri::command]
pub async fn get_library_signature(
    library: State<'_, LibraryState>,
    item_id: String,
) -> Result<Source, UiError> {
    let library = Arc::clone(library.inner());
    blocking(move || Ok(library.source(checked_id(&item_id)?)?)).await
}

/// Forgets everything: the file, the key and the entries of this session.
#[tauri::command]
pub async fn clear_signature_library(library: State<'_, LibraryState>) -> Result<(), UiError> {
    let library = Arc::clone(library.inner());
    blocking(move || Ok(library.forget_all()?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_must_be_32_lowercase_hex() {
        assert!(checked_id(&"a".repeat(32)).is_ok());
        for bad in [
            "",
            "abc",
            &"A".repeat(32),
            &"g".repeat(32),
            &"a".repeat(33),
            "../../x",
        ] {
            assert!(checked_id(bad).is_err(), "{bad}");
        }
    }
}
