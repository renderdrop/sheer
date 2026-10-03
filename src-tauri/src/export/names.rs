// owned by package A
//! File names of exported images (ADR-049 §2): `{stem}-p{NNN}.{png|jpg}`, built from the sanitised display name only.

use crate::commands::jobs::file_stem;

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

/// The stem of every file of an export of the document called `display`: the sanitised file name without `.pdf`. Never the `/Title`
/// or a page label (PDF strings never become file names).
pub fn export_stem(display: &str) -> String {
    file_stem(display)
}

/// The names without extension for the pages at 1-based `positions` of a document of `total` pages: `{stem}-p{NNN}`, `NNN` zero-padded to
/// the width of `total`.
pub fn image_stems(stem: &str, positions: &[u32], total: u32) -> Vec<String> {
    let width = total.max(1).to_string().len();
    positions
        .iter()
        .map(|position| format!("{stem}-p{position:0width$}"))
        .collect()
}

/// The file names (with extension) for the pages at 1-based `positions` of a document of `total` pages. `stem` is the output of
/// [`export_stem`].
pub fn image_names(stem: &str, positions: &[u32], total: u32, ext: ImageExt) -> Vec<String> {
    image_stems(stem, positions, total)
        .into_iter()
        .map(|name| format!("{name}.{}", ext.extension()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_padded_to_the_page_count() {
        assert_eq!(
            image_names("doc", &[1, 12], 120, ImageExt::Png),
            ["doc-p001.png", "doc-p012.png"]
        );
        assert_eq!(image_names("doc", &[3], 9, ImageExt::Jpeg), ["doc-p3.jpg"]);
        assert_eq!(image_stems("a", &[10], 10), ["a-p10"]);
    }

    #[test]
    fn hostile_display_names_become_safe_stems() {
        for (display, expected) in [
            (r"..\..\evil.pdf", "_.._evil"),
            ("a/b:c*?.pdf", "a_b_c__"),
            ("CON.pdf", "_CON"),
            ("com1", "_com1"),
            ("lpt9.txt.pdf", "_lpt9.txt"),
            ("  ..  ", "document"),
            ("", "document"),
            ("report\u{202e}\n.pdf", "report\u{202e}_"),
        ] {
            let stem = export_stem(display);
            assert_eq!(stem, expected, "{display:?}");
            let name = &image_names(&stem, &[1], 1, ImageExt::Png)[0];
            assert!(!name.contains(['/', '\\', ':', '*', '?', '\n']));
        }
    }
}
