//! Editing existing text (v1.5, ADR-125, ARCHITECTURE §13.5): the engine-free shapes the UI and the model share. A *line* is what the
//! user clicks; it is named by a [`LineKey`] that is only valid for one edit revision of its page. Nothing here names PDFium or lopdf.
//!
//! W0 seam: types only. The logic arrives with the packages of v1.5.1.

use serde::{Deserialize, Serialize};

use super::geometry::Rect;

/// Names a line of a page: `rev` is the page's text-edit revision (the number of edits applied to it, so a key from before an edit is
/// refused), `line` the index in the reading order of `text_edit_lines`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineKey {
    pub rev: u32,
    pub line: u32,
}

/// Why a line cannot be edited (`unsupported_feature`, `what: "textEdit"`, `params.reason`; the UI maps it to a tooltip).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextEditRefusal {
    Signed,
    Permission,
    Type3,
    Invisible,
    Clip,
    Vertical,
    Cmap,
    InForm,
    ActualText,
    Script,
    NotFileSource,
    Unmapped,
    TooComplex,
}

/// The bundled substitute family (ADR-125 §3): Arimo, Tinos or Cousine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FallbackFace {
    Sans,
    Serif,
    Mono,
}

/// Whether the line can be edited, and in which font the new text would be drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LineEditable {
    Same,
    Fallback { face: FallbackFace },
    No { reason: TextEditRefusal },
}

/// The line's original font as shown to the user: the display name (subset tag removed), the effective size in points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineFont {
    pub name: String,
    pub size: f32,
    pub embedded: bool,
}

/// What `text_edit_probe` and `text_edit_lines` tell about one line. `text` is at most `limits::TEXT_EDIT_LINE_CHARS` characters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLineInfo {
    pub key: LineKey,
    pub text: String,
    /// Union of the glyph boxes, in page space (the UI's `Rect`).
    #[serde(rename = "box")]
    pub bounds: Rect,
    /// Index of the paragraph the line belongs to (reading order).
    pub paragraph: u32,
    pub justified: bool,
    pub font: LineFont,
    pub editable: LineEditable,
}

/// The answer of `text_edit_lines`: every line of the page in reading order (page, paragraph, line), at most
/// `limits::TEXT_EDIT_LINES_PER_PAGE`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTextLines {
    pub lines: Vec<TextLineInfo>,
}

/// How a line that got wider or narrower is fitted (ARCHITECTURE §13.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextFit {
    KeepStart,
    Squeeze,
}

/// What an edit changes: one line, or (v1.5.2) the whole paragraph with a re-break.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextScope {
    Line,
    Paragraph,
}

/// One applied edit as the document state keeps it (`DocState.text_edits`, replayed over the original stream).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub key: LineKey,
    pub text: String,
    pub fit: TextFit,
    pub scope: TextScope,
}

/// Notes of an applied edit, in `ChangeSet.warnings` (together with the ones of other commands).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeWarning {
    /// The new text reaches a neighbour or the paragraph's right edge.
    TextOverflow,
    /// Part of the line is drawn in a bundled substitute font.
    FontFallback,
}

/// One character of a page as PDFium has it (`Job::PageChars`): UTF-16 index into the text layer, Unicode scalar, origin in page space.
/// Never sent over IPC.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CharGeom {
    pub utf16: u32,
    pub unicode: u32,
    pub origin: [f32; 2],
    pub size: f32,
    pub generated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_info_has_the_wire_shape_of_the_architecture() {
        let info = TextLineInfo {
            key: LineKey { rev: 0, line: 3 },
            text: "Hi".into(),
            bounds: Rect {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0,
            },
            paragraph: 1,
            justified: false,
            font: LineFont {
                name: "Arial".into(),
                size: 11.0,
                embedded: true,
            },
            editable: LineEditable::Fallback {
                face: FallbackFace::Sans,
            },
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["box"]["w"], 3.0);
        assert_eq!(json["editable"]["type"], "fallback");
        assert_eq!(json["editable"]["face"], "sans");
        let no = serde_json::to_value(LineEditable::No {
            reason: TextEditRefusal::NotFileSource,
        })
        .unwrap();
        assert_eq!(no["reason"], "notFileSource");
        let back: TextLineInfo = serde_json::from_value(json).unwrap();
        assert_eq!(back, info);
    }
}
