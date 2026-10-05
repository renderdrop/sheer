//! Tags (ADR-119): global definitions in `settings.json` (`Settings.tags`), names on annotations (`/SHR_Tags`).
//!
//! Seam of package W0; package C1 validates tag names on annotations, package C4 validates the definitions.

use serde::{Deserialize, Serialize};

use super::annotation::Rgb;

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
