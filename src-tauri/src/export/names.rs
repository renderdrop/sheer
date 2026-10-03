// owned by package A
//! File names of exported images (ADR-049 §2): `{stem}-p{NNN}.{png|jpg}`, built from the sanitised display name only.

/// The image format of an export, for the file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageExt {
    Png,
    Jpeg,
}

impl ImageExt {
    /// `png` or `jpg`.
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
        }
    }
}

/// The names for the pages at 1-based `positions` of a document of `total` pages: `NNN` is zero-padded to the width of `total`.
/// Stub (package A): answers no names.
pub fn image_names(_stem: &str, _positions: &[u32], _total: u32, _ext: ImageExt) -> Vec<String> {
    Vec::new()
}
