//! Editing existing text (v1.5, ADR-125, ARCHITECTURE §13.5): the engine-free shapes the UI and the model share. A *line* is what the
//! user clicks; it is named by a [`LineKey`] that is only valid for one edit revision of its page. Nothing here names PDFium or lopdf.
//!
//! The edits a page has ([`PageEdits`]), the model step that applies one ([`plan`], run as `DocCommand::RestoreTextEdit`) and its inverse
//! ([`restore`]).

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::command::DocCommand;
use super::doc_state::{Delta, DocState};
use super::geometry::Rect;
use super::page::{PageSlot, PageSource};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

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

impl TextEditRefusal {
    /// The word the UI gets in `params.reason` (the serde name).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Signed => "signed",
            Self::Permission => "permission",
            Self::Type3 => "type3",
            Self::Invisible => "invisible",
            Self::Clip => "clip",
            Self::Vertical => "vertical",
            Self::Cmap => "cmap",
            Self::InForm => "inForm",
            Self::ActualText => "actualText",
            Self::Script => "script",
            Self::NotFileSource => "notFileSource",
            Self::Unmapped => "unmapped",
            Self::TooComplex => "tooComplex",
        }
    }

    /// The typed error of a refusal: `unsupported_feature`, `what: "textEdit"`, `params.reason`.
    pub const fn error(self) -> AppError {
        AppError::text_edit_refused(self.as_str())
    }
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
    /// The font name carried a subset tag (`ABCDEF+Name`).
    #[serde(default)]
    pub subset: bool,
}

/// How the lines of a paragraph are aligned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineAlign {
    #[default]
    Left,
    Center,
    Right,
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
    #[serde(default)]
    pub align: LineAlign,
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

/// The edits of one page in the order they were made, with the page of the file they replay over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageEdits {
    /// Index of the page in the file the document was opened from (the original stream the edits replay over).
    pub file_index: u32,
    pub edits: Vec<TextEdit>,
}

/// The made preview of an edit: the one-page PDF, where the engine holds it, and the file page it comes from.
#[derive(Debug, Clone)]
pub struct Preview {
    pub bytes: Arc<[u8]>,
    pub engine_index: u32,
    pub file_index: u32,
}

impl DocState {
    /// The edits of `page` (`LineKey.rev` of the next edit is their count).
    pub fn text_edits(&self, page: PageId) -> Option<&PageEdits> {
        self.text_edits.get(&page.get())
    }

    /// The edit revision of `page`: how many edits it has.
    pub fn text_rev(&self, page: PageId) -> u32 {
        self.text_edits(page).map_or(0, |kept| {
            u32::try_from(kept.edits.len()).unwrap_or(u32::MAX)
        })
    }
}

/// The model step of one edit (label `editText.undo`): `edit` is checked against the page's revision and the limits, and the page's slot
/// becomes a [`PageSource::TextEdited`] one holding `preview`. The result is a [`DocCommand::RestoreTextEdit`] for `DocState::execute`; its
/// inverse is the same command with the slot and edits before (undo = pop). `invalid_argument` (`page`, `lineKey`), `limit_exceeded`.
pub fn plan(
    state: &DocState,
    page: PageId,
    edit: TextEdit,
    preview: Preview,
) -> Result<DocCommand, AppError> {
    let slot = state.slot(page).ok_or(AppError::invalid("page"))?;
    if edit.key.rev != state.text_rev(page) {
        return Err(AppError::invalid("lineKey"));
    }
    let mut kept = state.text_edits(page).cloned().unwrap_or(PageEdits {
        file_index: preview.file_index,
        edits: Vec::new(),
    });
    if kept.edits.len() >= limits::TEXT_EDITS_PER_PAGE {
        return Err(AppError::limit(
            "textEdits",
            limits::TEXT_EDITS_PER_PAGE as u64,
        ));
    }
    let total: usize = state.text_edits.values().map(|pe| pe.edits.len()).sum();
    if total >= limits::TEXT_EDITS_PER_DOC {
        return Err(AppError::limit(
            "textEdits",
            limits::TEXT_EDITS_PER_DOC as u64,
        ));
    }
    kept.edits.push(edit);
    Ok(DocCommand::RestoreTextEdit {
        page_id: page,
        slot: PageSlot {
            source: PageSource::TextEdited {
                bytes: preview.bytes,
            },
            engine_index: preview.engine_index,
            ..slot.clone()
        },
        edits: Some(kept),
    })
}

/// Runs [`DocCommand::RestoreTextEdit`]: puts `slot` in place of the page with its id (the `rev` goes past the one it has) and sets the
/// page's edits (`None`: it has none). Returns the command that undoes it, which is of the same kind. Nothing changes if the page is gone.
pub(crate) fn restore(
    state: &mut DocState,
    page: PageId,
    slot: &PageSlot,
    edits: Option<&PageEdits>,
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    let Some(position) = state.position(page).filter(|_| slot.id == page) else {
        return Err(AppError::invalid("page"));
    };
    let place = &mut state.pages[position as usize];
    let before = place.clone();
    *place = PageSlot {
        rev: place.rev.wrapping_add(1),
        ..slot.clone()
    };
    delta
        .engine_rotations
        .push((place.engine_index, place.rotation));
    if let Some(crop) = place.crop {
        delta.engine_crops.push((place.engine_index, crop));
    }
    delta.pages = true;
    let before_edits = match edits {
        Some(kept) => state.text_edits.insert(page.get(), kept.clone()),
        None => state.text_edits.remove(&page.get()),
    };
    Ok(DocCommand::RestoreTextEdit {
        page_id: page,
        slot: before,
        edits: before_edits,
    })
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
            align: LineAlign::Center,
            font: LineFont {
                name: "Arial".into(),
                size: 11.0,
                embedded: true,
                subset: true,
            },
            editable: LineEditable::Fallback {
                face: FallbackFace::Sans,
            },
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["box"]["w"], 3.0);
        assert_eq!(json["align"], "center");
        assert_eq!(json["font"]["subset"], true);
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

    fn edit(rev: u32, text: &str) -> TextEdit {
        TextEdit {
            key: LineKey { rev, line: 0 },
            text: text.into(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
        }
    }

    fn preview(bytes: &[u8], engine_index: u32) -> Preview {
        Preview {
            bytes: Arc::from(bytes),
            engine_index,
            file_index: 0,
        }
    }

    fn stamp() -> super::super::doc_state::Stamp {
        super::super::doc_state::Stamp {
            now_ms: 1,
            modified: "t".into(),
        }
    }

    fn source(state: &DocState) -> Option<Arc<[u8]>> {
        match &state.slot(PageId::new(0)).unwrap().source {
            PageSource::TextEdited { bytes } => Some(bytes.clone()),
            _ => None,
        }
    }

    #[test]
    fn an_edit_is_one_step_and_undo_pops_it() {
        let page = PageId::new(0);
        let mut state = DocState::new(2);
        let first = plan(&state, page, edit(0, "one"), preview(b"p1", 2)).unwrap();
        let changes = state.execute(first, &stamp()).unwrap();
        assert_eq!(changes.history.undo_label.as_deref(), Some("editText.undo"));
        let slots = changes.pages.expect("the swapped slot");
        assert_eq!((slots[0].origin, slots[0].rev), ("textEdited", 1));
        assert_eq!(state.text_rev(page), 1);
        let second = plan(&state, page, edit(1, "two"), preview(b"p2", 3)).unwrap();
        state.execute(second, &stamp()).unwrap();
        assert_eq!(state.text_rev(page), 2);
        let kept = source(&state).unwrap();
        assert_eq!(&*kept, b"p2");
        state.undo(&stamp()).unwrap();
        assert_eq!(state.text_rev(page), 1);
        assert_eq!(&*source(&state).unwrap(), b"p1");
        assert_eq!(state.slot(page).unwrap().engine_index, 2);
        state.undo(&stamp()).unwrap();
        assert_eq!(state.text_rev(page), 0);
        assert!(state.text_edits(page).is_none());
        let slot = state.slot(page).unwrap();
        assert!(matches!(slot.source, PageSource::File { index: 0 }));
        assert_eq!(slot.engine_index, 0);
        state.redo(&stamp()).unwrap();
        assert_eq!(&*source(&state).unwrap(), b"p1");
        assert_eq!(state.text_rev(page), 1);
    }

    #[test]
    fn a_key_of_another_revision_and_the_limits_are_refused() {
        let page = PageId::new(0);
        let mut state = DocState::new(1);
        let error = plan(&state, page, edit(1, "x"), preview(b"p", 1)).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::InvalidArgument);
        let error = plan(&state, PageId::new(9), edit(0, "x"), preview(b"p", 1)).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::InvalidArgument);
        state.text_edits.insert(
            page.get(),
            PageEdits {
                file_index: 0,
                edits: vec![edit(0, "x"); limits::TEXT_EDITS_PER_PAGE],
            },
        );
        let rev = state.text_rev(page);
        let error = plan(&state, page, edit(rev, "x"), preview(b"p", 1)).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::LimitExceeded);
        let mut state = DocState::new(30);
        for index in 0..20 {
            state.text_edits.insert(
                index,
                PageEdits {
                    file_index: index,
                    edits: vec![edit(0, "x"); limits::TEXT_EDITS_PER_PAGE],
                },
            );
        }
        let error = plan(&state, PageId::new(25), edit(0, "x"), preview(b"p", 1)).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::LimitExceeded);
    }

    #[test]
    fn the_apply_command_alone_is_not_a_model_step() {
        let mut state = DocState::new(1);
        let command = DocCommand::EditTextLine {
            page_id: PageId::new(0),
            key: LineKey { rev: 0, line: 0 },
            text: "x".into(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
        };
        assert!(state.execute(command, &stamp()).is_err());
    }
}
