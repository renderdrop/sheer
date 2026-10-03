//! Widths of the standard 14 fonts used by text boxes: Helvetica, Times-Roman and Courier (ADR-047 §1). owned by package A.

use crate::model::annotation::StdFont;

/// The PDF base font name of `font`.
pub const fn base_font(font: StdFont) -> &'static str {
    match font {
        StdFont::Sans => "Helvetica",
        StdFont::Serif => "Times-Roman",
        StdFont::Mono => "Courier",
    }
}
