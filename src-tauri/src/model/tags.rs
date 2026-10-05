//! Tags (ADR-119): global definitions in `settings.json` (`Settings.tags`), names on annotations (`/SHR_Tags`).
//!
//! Package C1 validates the tag names on annotations here, package C4 validates the definitions.

use serde::{Deserialize, Serialize};

use super::annotation::Rgb;
use crate::error::AppError;
use crate::limits;

/// The five highlight swatches (DESIGN 1.4, `src/features/inspector/palette.ts` `HIGHLIGHT_PALETTE`): the only colours a tag may have.
/// A test of package C4 keeps this list equal to the TS palette.
pub const TAG_PALETTE: [Rgb; 5] = [
    Rgb([255, 248, 77]),
    Rgb([125, 235, 181]),
    Rgb([163, 222, 255]),
    Rgb([255, 199, 215]),
    Rgb([220, 207, 255]),
];

/// One tag definition: a name (1..=`limits::TAG_NAME_MAX` characters, unique ignoring case) and a colour of [`TAG_PALETTE`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDef {
    pub name: String,
    pub color: Rgb,
}

fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= limits::TAG_NAME_MAX
        && !name.chars().any(char::is_control)
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The tag names of an annotation as the user gives them (a patch, a draft): trimmed, each 1..=`TAG_NAME_MAX` characters without control
/// characters, a repeat (ignoring case) dropped, at most `TAGS_PER_ANNOT` left. Anything else is `invalid_argument` (`tags`).
pub fn clean_names(names: &[String]) -> Result<Vec<String>, AppError> {
    // A hostile list is refused before it is walked.
    if names.len() > limits::TAGS_MAX {
        return Err(AppError::invalid("tags"));
    }
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim();
        if !name_ok(name) {
            return Err(AppError::invalid("tags"));
        }
        if !out.iter().any(|seen| same(seen, name)) {
            out.push(name.to_owned());
        }
    }
    if out.len() > limits::TAGS_PER_ANNOT {
        return Err(AppError::invalid("tags"));
    }
    Ok(out)
}

/// The tag names of a file: what is not a name is left out (a file is hostile input, nothing fails), the rest is trimmed, deduplicated
/// ignoring case and cut to `TAGS_PER_ANNOT`.
pub fn clean_names_lenient(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim();
        if !name_ok(name) || out.iter().any(|seen| same(seen, name)) {
            continue;
        }
        out.push(name.to_owned());
        if out.len() == limits::TAGS_PER_ANNOT {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn names_are_trimmed_and_deduplicated_ignoring_case() {
        assert_eq!(
            clean_names(&names(&[" Method ", "method", "Idea"])).unwrap(),
            ["Method", "Idea"]
        );
        assert!(clean_names(&[]).unwrap().is_empty());
    }

    #[test]
    fn bad_names_and_too_many_are_refused() {
        for bad in [
            names(&[""]),
            names(&["  "]),
            names(&["a\u{0}b"]),
            vec!["x".repeat(41)],
        ] {
            assert_eq!(
                clean_names(&bad).unwrap_err().code(),
                ErrorCode::InvalidArgument
            );
        }
        let nine: Vec<String> = (0..9).map(|i| format!("t{i}")).collect();
        assert!(clean_names(&nine).is_err());
        assert!(clean_names(&nine[..8]).is_ok());
        let many: Vec<String> = (0..65).map(|i| format!("t{i}")).collect();
        assert!(clean_names(&many).is_err());
        assert_eq!(clean_names(&["x".repeat(40)]).unwrap().len(), 1);
    }

    #[test]
    fn a_file_with_bad_names_keeps_the_good_ones() {
        let read = clean_names_lenient(
            ["ok", "", "OK", &"x".repeat(41), "b\u{7}", "fine"]
                .into_iter()
                .map(str::to_owned),
        );
        assert_eq!(read, ["ok", "fine"]);
        let many = clean_names_lenient((0..100).map(|i| format!("t{i}")));
        assert_eq!(many.len(), limits::TAGS_PER_ANNOT);
    }
}
