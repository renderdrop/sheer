//! Commands on a document (ADR-003 §6): the only way the annotations change.
//!
//! The UI sends a [`DocCommand`]; [`DocState::execute`] checks its shape ([`DocCommand::check_shape`]: counts, depth, labels) and runs
//! it ([`DocCommand::run`]), which validates every value it touches before it changes anything and returns the exact inverse as a
//! list of [`Slot`]s: the previous content of every id it touched. That one primitive (`Restore`, never sent by the UI) undoes
//! creates, updates, deletes and moves alike, and its own inverse redoes them, with the same ids.
//!
//! A `Batch` is one undo step made of several commands, run in order; if one fails the ones before it are rolled back.

use std::collections::BTreeSet;

use serde::Deserialize;

use super::annotation::{
    Annotation, AnnotationBody, AnnotationDraft, AnnotationPatch, SignatureArtRef,
};
use super::doc_state::{Delta, DocState, Entry, Slot, Stamp};
use super::form::{FieldId, FieldUndo, FieldValue};
use super::ids::AnnotId;
use super::metadata::{self, MetadataPatch};
use super::page::{NewPage, PageSlot, SourceId};
use super::page_ops::CropSpec;
use super::protection;
use super::redaction::{self, MarkSpec};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;
use crate::security::secret::Ticket;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DocCommand {
    /// Adds an annotation; the answer has the id.
    CreateAnnotation { draft: AnnotationDraft },
    /// Changes some fields of an annotation. Updates of one annotation with the same `coalesce` key within 1.5 s of each other
    /// (a slider, a colour being dragged) are one undo step.
    UpdateAnnotation {
        id: AnnotId,
        patch: AnnotationPatch,
        #[serde(default)]
        coalesce: Option<String>,
    },
    /// Deletes annotations, and the replies to them.
    DeleteAnnotations { ids: Vec<AnnotId> },
    /// Moves annotations by (`dx`, `dy`) points.
    MoveAnnotations { ids: Vec<AnnotId>, dx: f32, dy: f32 },
    /// Sets the value of a form field (ADR-041). Edits of one field with the same `coalesce` key (`field:<id>`) within 1.5 s of each
    /// other are one undo step.
    SetFieldValue {
        field: FieldId,
        value: FieldValue,
        #[serde(default)]
        coalesce: Option<String>,
    },
    /// Puts form values back. Internal: the inverse of a field change; not accepted from the UI.
    #[serde(skip_deserializing)]
    RestoreFields { values: Vec<(FieldId, FieldValue)> },
    /// Several commands as one undo step. `label` is a key of the UI catalogs (`[A-Za-z0-9._-]`).
    Batch {
        label: String,
        commands: Vec<DocCommand>,
    },
    /// Turns pages by `quarter_turns` quarter turns clockwise (-1, 1 or 2); the page's `/Rotate` changes (ADR-036).
    RotatePages {
        pages: Vec<PageId>,
        quarter_turns: i8,
    },
    /// Deletes pages, and their annotations; never every page.
    DeletePages { pages: Vec<PageId> },
    /// Moves pages, in their current relative order, to `to_index` of the list without them.
    MovePages { pages: Vec<PageId>, to_index: u32 },
    /// Adds a blank page at position `at`; without a size, the size of the page before it (else after it, else A4).
    InsertBlankPage {
        at: u32,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        height: Option<f32>,
    },
    /// Adds pages of an import source (`pages` are indices in the source) at position `at`.
    InsertPages {
        source: SourceId,
        pages: Vec<u32>,
        at: u32,
    },
    /// Crops pages, or takes the crop off (ADR-047 §2); the annotations, content objects and form widgets move with the page origin.
    CropPages { pages: Vec<PageId>, spec: CropSpec },
    /// Marks areas for true redaction, up to 10 000 as one step (ADR-047 §3). The marks are model state; a save never writes them.
    MarkRedactions { marks: Vec<MarkSpec> },
    /// Makes the staged protection change named by `ticket` the document's pending one (ADR-047 §4). The passwords are in
    /// `DocState.secrets`, never in the history. Made by `stage_protection` and `stage_unprotection`; not accepted from the UI.
    #[serde(skip_deserializing)]
    SetProtection { ticket: Ticket },
    /// Changes the title, author, subject or keywords written at the next save (ADR-047 §5).
    SetMetadata { patch: MetadataPatch },
    /// Stages the removal of all metadata, written by the next (full) save.
    RemoveMetadata,
    /// Puts the given content back into the given ids. The inverse of every command; not accepted from the UI.
    #[serde(skip_deserializing)]
    Restore { slots: Vec<Slot> },
    /// Puts redacted page slots, annotation entries and the staged metadata removal in place (ADR-047 §3). Internal: what the redaction job
    /// makes of its result (`redaction::plan`), and its own inverse.
    #[serde(skip_deserializing)]
    RestoreRedaction {
        slots: Vec<PageSlot>,
        entries: Vec<Slot>,
        strip: Option<bool>,
    },
    /// Sets the rotation of pages. Internal: the inverse of a rotation.
    #[serde(skip_deserializing)]
    SetRotations { rotations: Vec<(PageId, u16)> },
    /// Puts the pages in this order. Internal: the inverse of a move.
    #[serde(skip_deserializing)]
    ReorderPages { order: Vec<PageId> },
    /// Takes pages out of the list (with their annotations). Internal: the inverse of an insert.
    #[serde(skip_deserializing)]
    RemovePages { pages: Vec<PageId> },
    /// Puts pages back at the given positions together with the annotations they had. Internal: the inverse of a delete.
    #[serde(skip_deserializing)]
    RestorePages {
        slots: Vec<(u32, PageSlot)>,
        annotations: Vec<Slot>,
    },
    /// Adds pages that the engine's copy already holds. Internal: what an insert becomes once the engine has made the pages.
    #[serde(skip_deserializing)]
    AddPages {
        label: String,
        at: u32,
        pages: Vec<NewPage>,
    },
}

/// Label of the undo step of a command that is not a batch (keys of the UI catalogs).
pub const LABEL_CREATE: &str = "annotation.create";
pub const LABEL_UPDATE: &str = "annotation.update";
pub const LABEL_DELETE: &str = "annotation.delete";
pub const LABEL_MOVE: &str = "annotation.move";
const LABEL_RESTORE: &str = "annotation.restore";
pub const LABEL_FIELD_SET: &str = "field.set";
pub const LABEL_ROTATE_PAGES: &str = "page.rotate";
pub const LABEL_DELETE_PAGES: &str = "page.delete";
pub const LABEL_MOVE_PAGES: &str = "page.move";
pub const LABEL_INSERT_BLANK: &str = "page.insertBlank";
pub const LABEL_INSERT_PAGES: &str = "page.insert";
const LABEL_RESTORE_PAGES: &str = "page.restore";
pub const LABEL_CROP_PAGES: &str = "page.crop";
pub const LABEL_MARK_REDACTIONS: &str = "redact.mark";
pub const LABEL_REDACT_APPLY: &str = "redact.apply";
pub const LABEL_PROTECT_SET: &str = "protect.set";
pub const LABEL_PROTECT_REMOVE: &str = "protect.remove";
pub const LABEL_METADATA_SET: &str = "metadata.set";
pub const LABEL_METADATA_REMOVE: &str = "metadata.remove";

fn is_key(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= limits::MAX_LABEL_CHARS
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

impl DocCommand {
    /// The label of the undo step this command becomes.
    pub fn label(&self) -> String {
        match self {
            Self::CreateAnnotation { .. } => LABEL_CREATE.to_owned(),
            Self::UpdateAnnotation { .. } => LABEL_UPDATE.to_owned(),
            Self::DeleteAnnotations { .. } => LABEL_DELETE.to_owned(),
            Self::MoveAnnotations { .. } => LABEL_MOVE.to_owned(),
            Self::Batch { label, .. } => label.clone(),
            Self::Restore { .. } | Self::RestoreFields { .. } => LABEL_RESTORE.to_owned(),
            Self::SetFieldValue { .. } => LABEL_FIELD_SET.to_owned(),
            Self::RotatePages { .. } => LABEL_ROTATE_PAGES.to_owned(),
            Self::DeletePages { .. } => LABEL_DELETE_PAGES.to_owned(),
            Self::MovePages { .. } => LABEL_MOVE_PAGES.to_owned(),
            Self::InsertBlankPage { .. } => LABEL_INSERT_BLANK.to_owned(),
            Self::InsertPages { .. } => LABEL_INSERT_PAGES.to_owned(),
            Self::AddPages { label, .. } => label.clone(),
            Self::CropPages { .. } => LABEL_CROP_PAGES.to_owned(),
            Self::MarkRedactions { .. } => LABEL_MARK_REDACTIONS.to_owned(),
            Self::RestoreRedaction { .. } => LABEL_REDACT_APPLY.to_owned(),
            // `DocState::execute` says `protect.remove` when the ticket is a removal.
            Self::SetProtection { .. } => LABEL_PROTECT_SET.to_owned(),
            Self::SetMetadata { .. } => LABEL_METADATA_SET.to_owned(),
            Self::RemoveMetadata => LABEL_METADATA_REMOVE.to_owned(),
            Self::SetRotations { .. }
            | Self::ReorderPages { .. }
            | Self::RemovePages { .. }
            | Self::RestorePages { .. } => LABEL_RESTORE_PAGES.to_owned(),
        }
    }

    /// Whether this is a command of its own (pages, crop, redaction marks, protection, metadata: not annotations). Such commands are not part of a batch.
    pub fn is_page_command(&self) -> bool {
        matches!(
            self,
            Self::RotatePages { .. }
                | Self::CropPages { .. }
                | Self::MarkRedactions { .. }
                | Self::RestoreRedaction { .. }
                | Self::SetProtection { .. }
                | Self::SetMetadata { .. }
                | Self::RemoveMetadata
                | Self::DeletePages { .. }
                | Self::MovePages { .. }
                | Self::InsertBlankPage { .. }
                | Self::InsertPages { .. }
                | Self::SetRotations { .. }
                | Self::ReorderPages { .. }
                | Self::RemovePages { .. }
                | Self::RestorePages { .. }
                | Self::AddPages { .. }
        )
    }

    /// The annotation and the key that let this step merge with the one before it.
    pub fn coalesce_key(&self) -> Option<(AnnotId, String)> {
        match self {
            Self::UpdateAnnotation {
                id,
                coalesce: Some(key),
                ..
            } => Some((*id, key.clone())),
            // A field has its own ids; the key text keeps them apart from the annotations'.
            Self::SetFieldValue {
                field,
                coalesce: Some(key),
                ..
            } => Some((AnnotId::new(field.get()), key.clone())),
            _ => None,
        }
    }

    /// Checks the sizes of what the UI sent, before anything runs: at most `MAX_BATCH_COMMANDS` commands in all, batches nested at
    /// most `MAX_BATCH_DEPTH` deep, `MAX_COMMAND_IDS` ids per command, labels and keys that are keys.
    pub fn check_shape(&self) -> Result<(), AppError> {
        let mut count = 0usize;
        self.shape(1, &mut count)
    }

    fn shape(&self, depth: usize, count: &mut usize) -> Result<(), AppError> {
        *count += 1;
        if *count > limits::MAX_BATCH_COMMANDS {
            return Err(AppError::limit(
                "commands",
                limits::MAX_BATCH_COMMANDS as u64,
            ));
        }
        match self {
            Self::CreateAnnotation { .. } | Self::Restore { .. } | Self::RestoreFields { .. } => {
                Ok(())
            }
            Self::SetFieldValue { coalesce, .. } => match coalesce {
                Some(key) if !is_key(&key.replace(':', ".")) => Err(AppError::invalid("coalesce")),
                _ => Ok(()),
            },
            Self::RotatePages { pages, .. }
            | Self::DeletePages { pages }
            | Self::MovePages { pages, .. }
            | Self::CropPages { pages, .. } => {
                if pages.is_empty() {
                    Err(AppError::invalid("pages"))
                } else if pages.len() > limits::MAX_PAGES as usize {
                    Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)))
                } else {
                    Ok(())
                }
            }
            Self::InsertBlankPage { width, height, .. } => {
                let fits = |side: &Option<f32>| {
                    side.is_none_or(|side| {
                        side.is_finite()
                            && (limits::MIN_NEW_PAGE_SIDE_PT..=limits::MAX_PAGE_SIDE_PT)
                                .contains(&side)
                    })
                };
                if fits(width) && fits(height) {
                    Ok(())
                } else {
                    Err(AppError::invalid("size"))
                }
            }
            Self::InsertPages { pages, .. } => {
                if pages.is_empty() {
                    Err(AppError::invalid("pages"))
                } else if pages.len() > limits::MAX_INSERT_PAGES {
                    Err(AppError::limit("pages", limits::MAX_INSERT_PAGES as u64))
                } else {
                    Ok(())
                }
            }
            Self::SetRotations { .. }
            | Self::ReorderPages { .. }
            | Self::RemovePages { .. }
            | Self::RestorePages { .. }
            | Self::AddPages { .. }
            | Self::RestoreRedaction { .. } => Ok(()),
            Self::MarkRedactions { marks } => {
                if marks.is_empty() {
                    Err(AppError::invalid("marks"))
                } else if marks.len() > limits::MAX_REDACT_MARKS_PER_COMMAND {
                    Err(AppError::limit(
                        "marks",
                        limits::MAX_REDACT_MARKS_PER_COMMAND as u64,
                    ))
                } else {
                    Ok(())
                }
            }
            Self::SetProtection { .. } | Self::RemoveMetadata => Ok(()),
            Self::SetMetadata { patch } => patch.check(),
            Self::UpdateAnnotation { coalesce, .. } => match coalesce {
                Some(key) if !is_key(key) => Err(AppError::invalid("coalesce")),
                _ => Ok(()),
            },
            Self::DeleteAnnotations { ids } | Self::MoveAnnotations { ids, .. } => {
                if ids.is_empty() {
                    Err(AppError::invalid("ids"))
                } else if ids.len() > limits::MAX_COMMAND_IDS {
                    Err(AppError::limit("ids", limits::MAX_COMMAND_IDS as u64))
                } else {
                    Ok(())
                }
            }
            Self::Batch { label, commands } => {
                if depth > limits::MAX_BATCH_DEPTH {
                    return Err(AppError::limit("depth", limits::MAX_BATCH_DEPTH as u64));
                }
                if !is_key(label)
                    || commands.is_empty()
                    || commands.iter().any(DocCommand::is_page_command)
                {
                    return Err(AppError::invalid("batch"));
                }
                commands
                    .iter()
                    .try_for_each(|command| command.shape(depth + 1, count))
            }
        }
    }

    /// Runs an annotation or form command on `state`. Returns the slots (and, for form values, the values) that undo it and what
    /// changed. On an error nothing has changed.
    fn run_slots(
        &self,
        state: &mut DocState,
        stamp: &Stamp,
    ) -> Result<(Vec<Slot>, FieldUndo, Delta), AppError> {
        let mut delta = Delta::default();
        let mut field_inverse: FieldUndo = Vec::new();
        let inverse = match self {
            Self::CreateAnnotation { draft } => create(state, draft, stamp, &mut delta)?,
            Self::UpdateAnnotation { id, patch, .. } => {
                let entry = editable(state, *id)?;
                if entry.annotation.locked && !only_unlocks(patch) {
                    return Err(AppError::invalid("locked"));
                }
                let annotation = entry.annotation.patched(patch, &stamp.modified)?;
                let next = Entry {
                    annotation,
                    ..entry.clone()
                };
                state.set_slots(vec![(*id, Some(next))], &mut delta)
            }
            Self::DeleteAnnotations { ids } => delete(state, ids, &mut delta)?,
            Self::MoveAnnotations { ids, dx, dy } => {
                let mut slots = Vec::new();
                let mut seen = BTreeSet::new();
                for id in ids {
                    if !seen.insert(*id) {
                        continue;
                    }
                    let entry = editable(state, *id)?;
                    if entry.annotation.locked {
                        return Err(AppError::invalid("locked"));
                    }
                    let annotation = entry.annotation.moved(*dx, *dy, &stamp.modified)?;
                    slots.push((
                        *id,
                        Some(Entry {
                            annotation,
                            ..entry.clone()
                        }),
                    ));
                }
                state.set_slots(slots, &mut delta)
            }
            Self::SetFieldValue { field, value, .. } => {
                field_inverse = state.set_field_value(*field, value, &mut delta)?;
                Vec::new()
            }
            Self::RestoreFields { values } => {
                field_inverse = state.restore_fields(values, &mut delta);
                Vec::new()
            }
            Self::Batch { commands, .. } => {
                let mut inverses: Vec<(Vec<Slot>, FieldUndo)> = Vec::with_capacity(commands.len());
                for command in commands {
                    match command.run_slots(state, stamp) {
                        Ok((inverse, fields, step)) => {
                            inverses.push((inverse, fields));
                            delta.merge(step);
                        }
                        Err(error) => {
                            // The ones before it are taken back, last first.
                            for (slots, fields) in inverses.into_iter().rev() {
                                state.set_slots(slots, &mut Delta::default());
                                state.restore_fields(&fields, &mut Delta::default());
                            }
                            return Err(error);
                        }
                    }
                }
                let mut slots = Vec::new();
                for (undo, fields) in inverses.into_iter().rev() {
                    slots.extend(undo);
                    field_inverse.extend(fields);
                }
                slots
            }
            Self::Restore { slots } => state.set_slots(slots.clone(), &mut delta),
            // Page commands are steps of their own (and the inserts need the engine first).
            _ => return Err(AppError::invalid("batch")),
        };
        Ok((inverse, field_inverse, delta))
    }

    /// Runs the command on `state`. Returns the command that undoes it and what changed. On an error nothing has changed.
    pub(crate) fn run(
        &self,
        state: &mut DocState,
        stamp: &Stamp,
    ) -> Result<(DocCommand, Delta), AppError> {
        let mut delta = Delta::default();
        let inverse = match self {
            Self::RotatePages {
                pages,
                quarter_turns,
            } => state.rotate_pages(pages, *quarter_turns, &mut delta)?,
            Self::DeletePages { pages } => state.remove_pages(pages, true, &mut delta)?,
            Self::MovePages { pages, to_index } => {
                state.move_pages(pages, *to_index, &mut delta)?
            }
            Self::SetRotations { rotations } => state.set_rotations(rotations, &mut delta)?,
            Self::ReorderPages { order } => state.reorder_pages(order, &mut delta)?,
            Self::RemovePages { pages } => state.remove_pages(pages, false, &mut delta)?,
            Self::RestorePages { slots, annotations } => {
                state.restore_pages(slots, annotations, &mut delta)?
            }
            Self::AddPages { at, pages, .. } => state.insert_pages(*at, pages, &mut delta)?,
            Self::CropPages { pages, spec } => state.crop_pages(pages, spec, &mut delta)?,
            Self::MarkRedactions { marks } => redaction::mark(state, marks, &mut delta)?,
            Self::RestoreRedaction {
                slots,
                entries,
                strip,
            } => redaction::restore(state, slots, entries, *strip, &mut delta)?,
            Self::SetProtection { ticket } => {
                protection::run_set_protection(state, *ticket, &mut delta)?
            }
            Self::SetMetadata { patch } => metadata::set(state, patch, &mut delta)?,
            Self::RemoveMetadata => metadata::remove(state, &mut delta)?,
            // The engine makes the pages first (`commands::pages`); the model alone cannot.
            Self::InsertBlankPage { .. } | Self::InsertPages { .. } => {
                return Err(AppError::invalid("command"))
            }
            _ => {
                let (slots, fields, step) = self.run_slots(state, stamp)?;
                delta = step;
                match (slots.is_empty(), fields.is_empty()) {
                    (_, true) => Self::Restore { slots },
                    (true, false) => Self::RestoreFields { values: fields },
                    (false, false) => Self::Batch {
                        label: LABEL_RESTORE.to_owned(),
                        commands: vec![
                            Self::Restore { slots },
                            Self::RestoreFields { values: fields },
                        ],
                    },
                }
            }
        };
        Ok((inverse, delta))
    }
}

/// The patch changes nothing but `locked`.
fn only_unlocks(patch: &AnnotationPatch) -> bool {
    patch.locked.is_some()
        && *patch
            == AnnotationPatch {
                locked: patch.locked,
                ..AnnotationPatch::default()
            }
}

/// The entry of `id`, if the user may change it: it exists, was not deleted, and is not an opaque annotation.
fn editable(state: &DocState, id: AnnotId) -> Result<&Entry, AppError> {
    let entry = state.live(id)?;
    if entry.annotation.is_opaque() {
        return Err(AppError::invalid("readOnly"));
    }
    Ok(entry)
}

fn create(
    state: &mut DocState,
    draft: &AnnotationDraft,
    stamp: &Stamp,
    delta: &mut Delta,
) -> Result<Vec<Slot>, AppError> {
    if state.slot(draft.page_id).is_none() {
        return Err(AppError::invalid("page"));
    }
    state.check_room(draft.page_id)?;
    // Validated under a placeholder id; the real one is taken only once the draft is known to be good.
    Annotation::from_draft(AnnotId::new(0), draft, &stamp.modified)?;
    // An image's pixels are an asset of this document (ADR-047 §1).
    if let AnnotationBody::Image {
        asset_id, aspect, ..
    } = &draft.body
    {
        crate::content::image::check_asset(state, *asset_id, *aspect)?;
    }
    // A signature's art is an asset of this document (ADR-041 §5).
    if let AnnotationBody::Signature {
        art: SignatureArtRef::Asset { asset_id, aspect },
        ..
    } = &draft.body
    {
        match state.assets().get(*asset_id) {
            Some(art) if (art.aspect() - aspect).abs() <= 0.01 * aspect.max(1.0) => {}
            _ => return Err(AppError::invalid("art")),
        }
    }
    if let Some(parent) = draft.in_reply_to {
        let parent = state.live(parent)?;
        if parent.annotation.page_id != draft.page_id {
            return Err(AppError::invalid("inReplyTo"));
        }
    }
    let id = state.alloc_id()?;
    let annotation = Annotation::from_draft(id, draft, &stamp.modified)?;
    Ok(state.set_slots(
        vec![(
            id,
            Some(Entry {
                annotation,
                persisted: None,
                tombstone: false,
            }),
        )],
        delta,
    ))
}

fn delete(state: &mut DocState, ids: &[AnnotId], delta: &mut Delta) -> Result<Vec<Slot>, AppError> {
    let mut doomed: BTreeSet<AnnotId> = BTreeSet::new();
    for id in ids {
        let entry = editable(state, *id)?;
        if entry.annotation.locked {
            return Err(AppError::invalid("locked"));
        }
        doomed.insert(*id);
    }
    // The replies go with what they reply to, and the replies to those.
    let mut frontier = doomed.clone();
    while !frontier.is_empty() {
        let replies = state.replies_to(&frontier);
        frontier = replies
            .into_iter()
            .filter(|reply| doomed.insert(*reply))
            .collect();
    }
    let mut slots = Vec::with_capacity(doomed.len());
    for id in doomed {
        let entry = state.live(id)?;
        slots.push((
            id,
            // In the file: kept as a tombstone, so that saving removes it. Created in this session: gone.
            entry.persisted.is_some().then(|| Entry {
                tombstone: true,
                ..entry.clone()
            }),
        ));
    }
    Ok(state.set_slots(slots, delta))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::documents::PageId;
    use crate::error::ErrorCode;
    use crate::model::annotation::{AnnotationBody, Imported, PdfOrigin, Rgb, Sync};
    use crate::model::geometry::Rect;
    use crate::security::secret::Ticket;

    fn stamp(now_ms: u64) -> Stamp {
        Stamp {
            now_ms,
            modified: format!("t{now_ms}"),
        }
    }

    fn draft_json(page: u32, x: f32) -> serde_json::Value {
        json!({
            "pageId": page, "kind": "highlight", "color": [255, 235, 0],
            "quads": [[{"x":x,"y":20.0},{"x":x+50.0,"y":20.0},{"x":x,"y":32.0},{"x":x+50.0,"y":32.0}]]
        })
    }

    fn create_cmd(page: u32, x: f32) -> DocCommand {
        serde_json::from_value(json!({"type": "createAnnotation", "draft": draft_json(page, x)}))
            .unwrap()
    }

    fn cmd(value: serde_json::Value) -> DocCommand {
        serde_json::from_value(value).unwrap()
    }

    fn state() -> DocState {
        DocState::new(3)
    }

    fn created(state: &mut DocState, page: u32, x: f32, ms: u64) -> AnnotId {
        let changes = state.execute(create_cmd(page, x), &stamp(ms)).unwrap();
        changes.upserted[0].id
    }

    fn code(result: Result<impl std::fmt::Debug, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    fn imported(name: &str, locked: bool) -> Imported {
        Imported {
            origin: PdfOrigin {
                page_index: 0,
                annot_index: 0,
                name: Some(name.into()),
            },
            body: AnnotationBody::Highlight {
                quads: vec![[
                    crate::model::geometry::Point { x: 1.0, y: 1.0 },
                    crate::model::geometry::Point { x: 5.0, y: 1.0 },
                    crate::model::geometry::Point { x: 1.0, y: 3.0 },
                    crate::model::geometry::Point { x: 5.0, y: 3.0 },
                ]],
            },
            rect: Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            color: Rgb([255, 255, 0]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            locked,
            hidden: false,
        }
    }

    // --- create, update, delete, move ---

    #[test]
    fn create_adds_an_annotation_with_a_fresh_id_and_reports_it_with_the_history() {
        let mut state = state();
        let first = state.execute(create_cmd(0, 10.0), &stamp(0)).unwrap();
        assert_eq!(first.rev, 1);
        assert_eq!(first.upserted.len(), 1);
        assert!(first.removed.is_empty());
        assert_eq!(first.pages, None);
        assert!(first.history.can_undo && first.history.dirty && !first.history.can_redo);
        assert_eq!(first.history.undo_label.as_deref(), Some(LABEL_CREATE));
        let second = state.execute(create_cmd(1, 10.0), &stamp(1)).unwrap();
        assert_eq!(second.rev, 2);
        assert_ne!(first.upserted[0].id, second.upserted[0].id);
        assert_eq!(state.list(PageId::new(0)).len(), 1);
        assert_eq!(state.list(PageId::new(1)).len(), 1);
        assert!(state.list(PageId::new(2)).is_empty());
    }

    #[test]
    fn create_refuses_a_page_the_document_does_not_have_and_a_bad_draft_changes_nothing() {
        let mut state = state();
        assert_eq!(
            code(state.execute(create_cmd(3, 0.0), &stamp(0))),
            ErrorCode::InvalidArgument
        );
        let bad = cmd(json!({"type": "createAnnotation", "draft": {
            "pageId": 0, "kind": "highlight", "color": [0, 0, 0], "quads": []
        }}));
        assert_eq!(
            code(state.execute(bad, &stamp(0))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(state.rev(), 0);
        assert!(!state.is_dirty());
        // The id of the next one is not wasted by the failures.
        assert_eq!(created(&mut state, 0, 0.0, 0).get(), 1);
    }

    #[test]
    fn update_changes_the_named_fields_and_undo_restores_the_exact_previous_state() {
        let mut state = state();
        let id = created(&mut state, 0, 10.0, 0);
        let before = state.list(PageId::new(0));
        let update = cmd(
            json!({"type": "updateAnnotation", "id": id, "patch": {"color": [1, 2, 3], "contents": "hello"}}),
        );
        let changes = state.execute(update, &stamp(5)).unwrap();
        assert_eq!(changes.upserted[0].color, Rgb([1, 2, 3]));
        assert_eq!(changes.upserted[0].modified.as_deref(), Some("t5"));
        assert_eq!(changes.upserted[0].sync, Sync::New, "still not in the file");
        let undone = state.undo(&stamp(6)).unwrap();
        assert_eq!(undone.upserted[0], before[0]);
        let redone = state.redo(&stamp(7)).unwrap();
        assert_eq!(redone.upserted[0].contents, "hello");
        assert_eq!(redone.rev, 4);
    }

    #[test]
    fn update_refuses_unknown_deleted_opaque_and_foreign_fields() {
        let mut state = state();
        let id = created(&mut state, 0, 10.0, 0);
        let missing =
            cmd(json!({"type": "updateAnnotation", "id": 99, "patch": {"contents": "x"}}));
        assert_eq!(code(state.execute(missing, &stamp(1))), ErrorCode::NotFound);
        let foreign = cmd(json!({"type": "updateAnnotation", "id": id, "patch": {"dashed": true}}));
        assert_eq!(
            code(state.execute(foreign, &stamp(1))),
            ErrorCode::InvalidArgument
        );
        let rev = state.rev();
        state
            .execute(
                cmd(json!({"type": "deleteAnnotations", "ids": [id]})),
                &stamp(2),
            )
            .unwrap();
        let gone = cmd(json!({"type": "updateAnnotation", "id": id, "patch": {"contents": "x"}}));
        assert_eq!(code(state.execute(gone, &stamp(3))), ErrorCode::NotFound);
        assert_eq!(state.rev(), rev + 1);
    }

    #[test]
    fn delete_removes_and_undo_brings_back_the_same_id() {
        let mut state = state();
        let a = created(&mut state, 0, 10.0, 0);
        let b = created(&mut state, 0, 100.0, 1);
        let changes = state
            .execute(
                cmd(json!({"type": "deleteAnnotations", "ids": [a, a]})),
                &stamp(2),
            )
            .unwrap();
        assert_eq!(changes.removed, [a]);
        assert_eq!(state.list(PageId::new(0)).len(), 1);
        let undone = state.undo(&stamp(3)).unwrap();
        assert_eq!(undone.upserted[0].id, a);
        assert_eq!(
            state
                .list(PageId::new(0))
                .iter()
                .map(|x| x.id)
                .collect::<Vec<_>>(),
            [a, b]
        );
        let redone = state.redo(&stamp(4)).unwrap();
        assert_eq!(redone.removed, [a]);
    }

    #[test]
    fn deleting_an_annotation_deletes_its_replies_and_undo_brings_all_back() {
        let mut state = state();
        let parent = created(&mut state, 0, 10.0, 0);
        let mut reply = draft_json(0, 70.0);
        reply["inReplyTo"] = json!(parent);
        let reply_id = state
            .execute(
                cmd(json!({"type": "createAnnotation", "draft": reply})),
                &stamp(1),
            )
            .unwrap()
            .upserted[0]
            .id;
        let mut grand = draft_json(0, 90.0);
        grand["inReplyTo"] = json!(reply_id);
        state
            .execute(
                cmd(json!({"type": "createAnnotation", "draft": grand})),
                &stamp(2),
            )
            .unwrap();
        let other = created(&mut state, 0, 200.0, 3);
        let changes = state
            .execute(
                cmd(json!({"type": "deleteAnnotations", "ids": [parent]})),
                &stamp(4),
            )
            .unwrap();
        assert_eq!(changes.removed.len(), 3);
        assert_eq!(
            state
                .list(PageId::new(0))
                .iter()
                .map(|a| a.id)
                .collect::<Vec<_>>(),
            [other]
        );
        assert_eq!(state.undo(&stamp(5)).unwrap().upserted.len(), 3);
        assert_eq!(state.list(PageId::new(0)).len(), 4);
    }

    #[test]
    fn a_reply_needs_a_live_parent_on_the_same_page() {
        let mut state = state();
        let parent = created(&mut state, 0, 10.0, 0);
        let mut elsewhere = draft_json(1, 0.0);
        elsewhere["inReplyTo"] = json!(parent);
        assert_eq!(
            code(state.execute(
                cmd(json!({"type": "createAnnotation", "draft": elsewhere})),
                &stamp(1)
            )),
            ErrorCode::InvalidArgument
        );
        let mut orphan = draft_json(0, 0.0);
        orphan["inReplyTo"] = json!(77);
        assert_eq!(
            code(state.execute(
                cmd(json!({"type": "createAnnotation", "draft": orphan})),
                &stamp(1)
            )),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn move_shifts_all_named_annotations_or_none() {
        let mut state = state();
        let a = created(&mut state, 0, 10.0, 0);
        let b = created(&mut state, 0, 100.0, 1);
        let changes = state
            .execute(
                cmd(json!({"type": "moveAnnotations", "ids": [a, b], "dx": 5.0, "dy": 7.0})),
                &stamp(2),
            )
            .unwrap();
        assert_eq!(changes.upserted.len(), 2);
        assert_eq!(changes.upserted[0].rect.x, 15.0);
        assert_eq!(changes.upserted[0].rect.y, 27.0);
        // One that cannot move stops the lot.
        let rev = state.rev();
        let bad = cmd(json!({"type": "moveAnnotations", "ids": [a, 55], "dx": 1.0, "dy": 1.0}));
        assert_eq!(code(state.execute(bad, &stamp(3))), ErrorCode::NotFound);
        let far = cmd(json!({"type": "moveAnnotations", "ids": [a], "dx": 1.0e7, "dy": 0.0}));
        assert_eq!(
            code(state.execute(far, &stamp(3))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(state.rev(), rev);
        assert_eq!(state.list(PageId::new(0))[0].rect.x, 15.0);
        // Undo moves back exactly.
        state.undo(&stamp(4)).unwrap();
        assert_eq!(state.list(PageId::new(0))[0].rect.x, 10.0);
    }

    // --- batches ---

    #[test]
    fn a_batch_is_one_undo_step_with_one_label() {
        let mut state = state();
        let batch = cmd(
            json!({"type": "batch", "label": "annotation.paste", "commands": [
                {"type": "createAnnotation", "draft": draft_json(0, 0.0)},
                {"type": "createAnnotation", "draft": draft_json(1, 0.0)},
                {"type": "createAnnotation", "draft": draft_json(2, 0.0)},
            ]}),
        );
        let changes = state.execute(batch, &stamp(0)).unwrap();
        assert_eq!(changes.upserted.len(), 3);
        assert_eq!(changes.rev, 1);
        assert_eq!(
            changes.history.undo_label.as_deref(),
            Some("annotation.paste")
        );
        let undone = state.undo(&stamp(1)).unwrap();
        assert_eq!(undone.removed.len(), 3);
        assert!(!undone.history.can_undo && undone.history.can_redo && !undone.history.dirty);
        assert_eq!(state.redo(&stamp(2)).unwrap().upserted.len(), 3);
    }

    #[test]
    fn a_batch_that_fails_halfway_leaves_nothing_behind() {
        let mut state = state();
        let keep = created(&mut state, 0, 10.0, 0);
        let rev = state.rev();
        let batch = cmd(json!({"type": "batch", "label": "x", "commands": [
            {"type": "updateAnnotation", "id": keep, "patch": {"contents": "changed"}},
            {"type": "createAnnotation", "draft": draft_json(0, 50.0)},
            {"type": "deleteAnnotations", "ids": [keep]},
            {"type": "deleteAnnotations", "ids": [keep]},
        ]}));
        assert_eq!(code(state.execute(batch, &stamp(1))), ErrorCode::NotFound);
        assert_eq!(state.rev(), rev);
        let now = state.list(PageId::new(0));
        assert_eq!(now.len(), 1);
        assert_eq!(now[0].contents, "");
        assert_eq!(
            state.history_state().undo_label.as_deref(),
            Some(LABEL_CREATE)
        );
    }

    #[test]
    fn a_move_to_another_page_is_a_batch_of_delete_and_create_and_one_step() {
        let mut state = state();
        let id = created(&mut state, 0, 10.0, 0);
        let batch = cmd(
            json!({"type": "batch", "label": "annotation.movePage", "commands": [
                {"type": "deleteAnnotations", "ids": [id]},
                {"type": "createAnnotation", "draft": draft_json(2, 10.0)},
            ]}),
        );
        let changes = state.execute(batch, &stamp(1)).unwrap();
        assert_eq!((changes.removed.len(), changes.upserted.len()), (1, 1));
        assert!(state.list(PageId::new(0)).is_empty());
        assert_eq!(state.list(PageId::new(2)).len(), 1);
        state.undo(&stamp(2)).unwrap();
        assert_eq!(state.list(PageId::new(0)).len(), 1);
        assert!(state.list(PageId::new(2)).is_empty());
    }

    #[test]
    fn batch_shape_is_bounded_and_the_ui_cannot_send_a_restore() {
        let mut state = state();
        let nested = |depth: usize| {
            let mut value = json!({"type": "deleteAnnotations", "ids": [1]});
            for _ in 0..depth {
                value = json!({"type": "batch", "label": "b", "commands": [value]});
            }
            cmd(value)
        };
        assert!(nested(limits::MAX_BATCH_DEPTH).check_shape().is_ok());
        assert_eq!(
            code(nested(limits::MAX_BATCH_DEPTH + 1).check_shape()),
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            code(state.execute(nested(3), &stamp(0))),
            ErrorCode::LimitExceeded
        );
        let long = DocCommand::Batch {
            label: "b".into(),
            commands: vec![create_cmd(0, 0.0); limits::MAX_BATCH_COMMANDS + 1],
        };
        assert_eq!(code(long.check_shape()), ErrorCode::LimitExceeded);
        let empty = cmd(json!({"type": "batch", "label": "b", "commands": []}));
        assert_eq!(code(empty.check_shape()), ErrorCode::InvalidArgument);
        for label in [
            "",
            "has space",
            "ünï",
            &"x".repeat(limits::MAX_LABEL_CHARS + 1),
        ] {
            let bad = cmd(
                json!({"type": "batch", "label": label, "commands": [{"type": "deleteAnnotations", "ids": [1]}]}),
            );
            assert_eq!(
                code(bad.check_shape()),
                ErrorCode::InvalidArgument,
                "{label}"
            );
        }
        let no_ids = cmd(json!({"type": "deleteAnnotations", "ids": []}));
        assert_eq!(code(no_ids.check_shape()), ErrorCode::InvalidArgument);
        let ids: Vec<u32> = (0..=limits::MAX_COMMAND_IDS as u32).collect();
        let many = cmd(json!({"type": "moveAnnotations", "ids": ids, "dx": 0.0, "dy": 0.0}));
        assert_eq!(code(many.check_shape()), ErrorCode::LimitExceeded);
        let bad_key =
            cmd(json!({"type": "updateAnnotation", "id": 1, "patch": {}, "coalesce": "a b"}));
        assert_eq!(code(bad_key.check_shape()), ErrorCode::InvalidArgument);
        assert!(
            serde_json::from_value::<DocCommand>(json!({"type": "restore", "slots": []})).is_err()
        );
        assert!(serde_json::from_value::<DocCommand>(json!({"type": "rotatePages"})).is_err());
    }

    // --- history ---

    #[test]
    fn undo_and_redo_walk_the_history_and_a_new_command_drops_the_redo_steps() {
        let mut state = state();
        let a = created(&mut state, 0, 10.0, 0);
        let b = created(&mut state, 0, 100.0, 1);
        state.undo(&stamp(2)).unwrap();
        state.undo(&stamp(3)).unwrap();
        assert!(!state.is_dirty());
        assert!(state.list(PageId::new(0)).is_empty());
        state.redo(&stamp(4)).unwrap();
        assert_eq!(state.list(PageId::new(0))[0].id, a);
        let c = created(&mut state, 0, 300.0, 5);
        assert!(!state.history_state().can_redo);
        assert_ne!(c, b, "an id is never used twice");
        assert_eq!(state.rev(), 6);
    }

    #[test]
    fn with_nothing_to_undo_or_redo_the_change_set_is_empty_and_the_revision_is_unchanged() {
        let mut state = state();
        let empty = state.undo(&stamp(0)).unwrap();
        assert!(empty.upserted.is_empty() && empty.removed.is_empty());
        assert_eq!(empty.rev, 0);
        assert_eq!(state.redo(&stamp(0)).unwrap().rev, 0);
    }

    #[test]
    fn updates_that_share_a_key_merge_into_one_step_that_undoes_to_before_the_first() {
        let mut state = state();
        let id = created(&mut state, 0, 10.0, 0);
        for (ms, opacity) in [(100, 0.9), (400, 0.8), (900, 0.7)] {
            let update = cmd(
                json!({"type": "updateAnnotation", "id": id, "coalesce": "opacity", "patch": {"opacity": opacity}}),
            );
            state.execute(update, &stamp(ms)).unwrap();
        }
        assert_eq!(state.list(PageId::new(0))[0].opacity, 0.7);
        assert_eq!(state.rev(), 4, "every update is a revision");
        let undone = state.undo(&stamp(1000)).unwrap();
        assert_eq!(undone.upserted[0].opacity, 1.0);
        assert!(undone.history.undo_label.as_deref() == Some(LABEL_CREATE));
    }

    #[test]
    fn save_marks_clean_and_the_history_survives_it() {
        let mut state = state();
        let id = created(&mut state, 0, 10.0, 0);
        state.mark_clean();
        assert!(!state.is_dirty());
        let update = cmd(json!({"type": "updateAnnotation", "id": id, "patch": {"contents": "x"}}));
        state.execute(update, &stamp(1)).unwrap();
        assert!(state.is_dirty());
        assert!(!state.undo(&stamp(2)).unwrap().history.dirty);
        assert!(state.undo(&stamp(3)).unwrap().history.dirty);
    }

    // --- imported annotations ---

    #[test]
    fn imported_annotations_are_clean_listed_once_and_do_not_touch_the_history() {
        let mut state = state();
        let items = [imported("a", false), imported("b", false)];
        assert_eq!(state.import_page(PageId::new(1), &items), 2);
        assert_eq!(
            state.import_page(PageId::new(1), &items),
            0,
            "a page is read once"
        );
        assert!(state.is_imported(PageId::new(1)));
        assert!(!state.is_imported(PageId::new(0)));
        assert_eq!(state.import_page(PageId::new(9), &items), 0);
        let listed = state.list(PageId::new(1));
        assert_eq!(listed.len(), 2);
        assert!(listed
            .iter()
            .all(|a| a.sync == Sync::Clean && a.page_id == PageId::new(1)));
        assert_eq!((state.rev(), state.is_dirty()), (0, false));
    }

    #[test]
    fn changing_an_imported_annotation_marks_it_modified_and_deleting_it_keeps_a_tombstone() {
        let mut state = state();
        state.import_page(PageId::new(0), &[imported("a", false)]);
        let id = state.list(PageId::new(0))[0].id;
        let update = cmd(json!({"type": "updateAnnotation", "id": id, "patch": {"contents": "x"}}));
        assert_eq!(
            state.execute(update, &stamp(1)).unwrap().upserted[0].sync,
            Sync::Modified
        );
        state
            .execute(
                cmd(json!({"type": "deleteAnnotations", "ids": [id]})),
                &stamp(2),
            )
            .unwrap();
        assert!(state.list(PageId::new(0)).is_empty());
        let tomb: Vec<_> = state.entries().filter(|e| e.tombstone).collect();
        assert_eq!(tomb.len(), 1);
        assert_eq!(
            tomb[0].persisted.as_ref().and_then(|o| o.name.as_deref()),
            Some("a")
        );
        state.undo(&stamp(3)).unwrap();
        assert_eq!(state.list(PageId::new(0)).len(), 1);
        assert!(state.entries().all(|e| !e.tombstone));
        state.undo(&stamp(4)).unwrap();
        assert_eq!(state.list(PageId::new(0))[0].sync, Sync::Clean);
    }

    #[test]
    fn opaque_and_locked_annotations_cannot_be_changed_and_a_lock_can_be_lifted() {
        let mut state = state();
        let mut opaque = imported("o", false);
        opaque.body = AnnotationBody::Opaque {
            subtype: "Ink".into(),
        };
        opaque.rect = Rect {
            x: 1.0,
            y: 1.0,
            w: 10.0,
            h: 10.0,
        };
        state.import_page(PageId::new(0), &[opaque, imported("l", true)]);
        let ids: Vec<AnnotId> = state.list(PageId::new(0)).iter().map(|a| a.id).collect();
        for id in &ids {
            for command in [
                json!({"type": "deleteAnnotations", "ids": [id]}),
                json!({"type": "moveAnnotations", "ids": [id], "dx": 1.0, "dy": 1.0}),
                json!({"type": "updateAnnotation", "id": id, "patch": {"contents": "x"}}),
            ] {
                assert_eq!(
                    code(state.execute(cmd(command), &stamp(0))),
                    ErrorCode::InvalidArgument
                );
            }
        }
        let unlock =
            cmd(json!({"type": "updateAnnotation", "id": ids[1], "patch": {"locked": false}}));
        assert!(!state.execute(unlock, &stamp(1)).unwrap().upserted[0].locked);
        let edit =
            cmd(json!({"type": "updateAnnotation", "id": ids[1], "patch": {"contents": "now"}}));
        assert!(state.execute(edit, &stamp(2)).is_ok());
    }

    #[test]
    fn undoing_a_change_to_an_annotation_hidden_in_the_file_keeps_it_hidden() {
        let mut state = state();
        let mut item = imported("h", false);
        item.hidden = true;
        item.origin.annot_index = 3;
        state.import_page(PageId::new(0), &[item]);
        let at = (0, 3);
        assert!(
            state.hidden_origins().contains(&at),
            "hidden before any change"
        );
        let id = state.list(PageId::new(0))[0].id;
        let edit = cmd(json!({"type": "updateAnnotation", "id": id, "patch": {"contents": "now"}}));
        state.execute(edit, &stamp(1)).unwrap();
        assert!(state.hidden_origins().contains(&at));
        state.undo(&stamp(2)).unwrap();
        // The set that decides what the engine shows again: the original stays in it, so it is never shown.
        assert!(state.hidden_origins().contains(&at));
    }

    // --- limits ---

    #[test]
    fn the_number_of_annotations_per_page_and_per_document_is_bounded() {
        let mut state = DocState::new(2);
        let items: Vec<Imported> = (0..limits::MAX_ANNOTATIONS_PER_PAGE + 5)
            .map(|n| imported(&n.to_string(), false))
            .collect();
        assert_eq!(
            state.import_page(PageId::new(0), &items),
            limits::MAX_ANNOTATIONS_PER_PAGE
        );
        // What did not fit is reported, not dropped silently; a page that was read completely has no warning.
        assert_eq!(
            state.import_warnings(),
            vec![crate::model::doc_state::ImportWarning::PageTruncated {
                page: 0,
                skipped: 5
            }]
        );
        assert_eq!(state.import_page(PageId::new(1), &items[..3]), 3);
        assert_eq!(state.import_warnings().len(), 1);
        assert_eq!(
            code(state.execute(create_cmd(0, 0.0), &stamp(0))),
            ErrorCode::LimitExceeded
        );
        assert!(state.execute(create_cmd(1, 0.0), &stamp(0)).is_ok());
    }

    // --- counters, reply index and the import budget ---

    #[test]
    fn the_counters_and_the_reply_index_follow_create_delete_undo_and_redo() {
        let mut state = state();
        let parent = created(&mut state, 0, 10.0, 0);
        let mut draft = draft_json(0, 40.0);
        draft["inReplyTo"] = json!(parent.get());
        let reply = state
            .execute(
                cmd(json!({"type": "createAnnotation", "draft": draft})),
                &stamp(1),
            )
            .unwrap()
            .upserted[0]
            .id;
        assert_eq!(state.replies_to(&BTreeSet::from([parent])), vec![reply]);
        assert_eq!(state.live_total, 2);
        let deleted = state
            .execute(
                cmd(json!({"type": "deleteAnnotations", "ids": [parent.get()]})),
                &stamp(2),
            )
            .unwrap();
        assert_eq!(deleted.removed.len(), 2, "the reply goes with its parent");
        assert_eq!(
            (state.live_total, state.live_per_page.get(&0)),
            (0, Some(&0))
        );
        assert!(state.replies_to(&BTreeSet::from([parent])).is_empty());
        state.undo(&stamp(3)).unwrap();
        assert_eq!(state.live_total, 2);
        assert_eq!(state.replies_to(&BTreeSet::from([parent])), vec![reply]);
        state.undo(&stamp(4)).unwrap();
        state.undo(&stamp(5)).unwrap();
        assert_eq!(state.live_total, 0);
        assert!(state.replies.is_empty());
        state.redo(&stamp(6)).unwrap();
        assert_eq!(state.live_total, 1);
    }

    #[test]
    fn imported_strings_are_budgeted_per_page_and_per_document() {
        let big = |chars: usize| {
            let mut item = imported("n", false);
            item.contents = "x".repeat(chars);
            item
        };
        let one = 32_000;
        let items: Vec<_> = (0..200).map(|_| big(one)).collect();
        let mut state = DocState::new(100);
        // 131 of them fit in the budget of a page.
        assert_eq!(
            state.import_page(PageId::new(0), &items),
            limits::MAX_IMPORT_BYTES_PER_PAGE / one
        );
        let skipped = items.len() - limits::MAX_IMPORT_BYTES_PER_PAGE / one;
        assert_eq!(
            state.import_warnings(),
            vec![crate::model::doc_state::ImportWarning::PageTruncated {
                page: 0,
                skipped: u32::try_from(skipped).unwrap()
            }]
        );
        // The document budget goes in whole pages of these.
        let mut pages = 0;
        for page in 1..100 {
            if state.import_page(PageId::new(page), &items) == 0 {
                break;
            }
            pages += 1;
        }
        assert!(
            pages < 10,
            "the document stops taking strings after about {} pages",
            limits::MAX_IMPORT_BYTES_PER_DOC / limits::MAX_IMPORT_BYTES_PER_PAGE
        );
    }

    #[test]
    fn reading_a_page_after_a_save_does_not_add_what_the_save_wrote_again() {
        let mut state = state();
        let id = created(&mut state, 0, 10.0, 0);
        let origin = PdfOrigin {
            page_index: 0,
            annot_index: 0,
            name: None,
        };
        state.finish_save(&std::collections::HashMap::from([(id, origin)]));
        // The file lists the annotation that was written (position 0) and an older one (position 1).
        let mut older = imported("old", false);
        older.origin.annot_index = 1;
        assert_eq!(
            state.import_page(PageId::new(0), &[imported("new", false), older]),
            1
        );
        assert_eq!(state.list(PageId::new(0)).len(), 2);
    }
    // --- Form fields (ADR-041) ---

    fn form_state() -> DocState {
        use crate::model::form::{
            Align, FieldId, FieldKind, FieldSync, FieldValue, FormField, ObjRef, ReadForm,
        };
        let text_field = |name: &str, max_len| FormField {
            id: FieldId::new(0),
            name: name.into(),
            tooltip: None,
            kind: FieldKind::Text {
                multiline: false,
                max_len,
                comb: false,
                password: false,
                align: Align::Left,
                font_size: 0.0,
            },
            read_only: false,
            required: false,
            value: FieldValue::Text {
                text: String::new(),
            },
            default_value: None,
            widgets: Vec::new(),
            sync: FieldSync::Clean,
            obj: ObjRef::default(),
            saved: None,
            top_index: 0,
        };
        let mut state = state();
        state.install_form(ReadForm {
            fields: vec![text_field("a", None), text_field("b", Some(2))],
            ..ReadForm::default()
        });
        state
    }

    fn set_field(field: u32, text: &str, coalesce: Option<&str>) -> DocCommand {
        cmd(json!({"type": "setFieldValue", "field": field,
            "value": {"type": "text", "text": text}, "coalesce": coalesce}))
    }

    #[test]
    fn a_field_value_is_one_undo_step_with_the_field_as_the_changed_state() {
        let mut state = form_state();
        let changes = state.execute(set_field(1, "x", None), &stamp(0)).unwrap();
        assert_eq!(changes.fields.len(), 1);
        assert!(changes.history.dirty);
        assert_eq!(changes.history.undo_label.as_deref(), Some(LABEL_FIELD_SET));
        let undone = state.undo(&stamp(1)).unwrap();
        assert_eq!(undone.fields[0].sync, crate::model::form::FieldSync::Clean);
        assert!(!undone.history.dirty);
        let redone = state.redo(&stamp(2)).unwrap();
        assert_eq!(
            redone.fields[0].sync,
            crate::model::form::FieldSync::Modified
        );
    }

    #[test]
    fn edits_of_one_field_with_one_key_within_the_window_are_one_step_and_other_fields_are_not() {
        let mut state = form_state();
        state
            .execute(set_field(1, "x", Some("field:1")), &stamp(0))
            .unwrap();
        state
            .execute(set_field(1, "xy", Some("field:1")), &stamp(100))
            .unwrap();
        state
            .execute(set_field(2, "z", Some("field:2")), &stamp(200))
            .unwrap();
        state.undo(&stamp(300)).unwrap();
        let undone = state.undo(&stamp(301)).unwrap();
        // The two edits of field 1 went back together, to the value the file has.
        assert_eq!(
            undone.fields[0].value,
            crate::model::form::FieldValue::Text {
                text: String::new()
            }
        );
        assert!(!state.undo(&stamp(302)).unwrap().history.can_undo);
    }

    #[test]
    fn a_batch_of_field_values_is_undone_together_and_a_refusal_changes_nothing() {
        let mut state = form_state();
        let bad = cmd(json!({"type": "batch", "label": "form.reset", "commands": [
            {"type": "setFieldValue", "field": 1, "value": {"type": "text", "text": "ok"}},
            {"type": "setFieldValue", "field": 2, "value": {"type": "text", "text": "toolong"}},
        ]}));
        assert_eq!(
            code(state.execute(bad, &stamp(0))),
            ErrorCode::InvalidArgument
        );
        assert!(state.form().unwrap().changed().is_empty());
        let good = cmd(json!({"type": "batch", "label": "form.reset", "commands": [
            {"type": "setFieldValue", "field": 1, "value": {"type": "text", "text": "ok"}},
            {"type": "setFieldValue", "field": 2, "value": {"type": "text", "text": "ab"}},
        ]}));
        assert_eq!(state.execute(good, &stamp(1)).unwrap().fields.len(), 2);
        assert_eq!(state.undo(&stamp(2)).unwrap().fields.len(), 2);
        assert!(state.form().unwrap().changed().is_empty());
        assert_eq!(
            code(state.execute(set_field(9, "x", None), &stamp(3))),
            ErrorCode::NotFound
        );
        let key = cmd(json!({"type": "setFieldValue", "field": 1,
            "value": {"type": "text", "text": "x"}, "coalesce": "bad key!"}));
        assert_eq!(
            code(state.execute(key, &stamp(4))),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn the_ui_cannot_send_the_internal_restore_of_fields() {
        let sent =
            serde_json::from_value::<DocCommand>(json!({"type": "restoreFields", "values": []}));
        assert!(sent.is_err());
    }

    #[test]
    fn the_edit_and_protect_commands_parse_and_refuse_bad_arguments() {
        let quad = json!([{"x":0.0,"y":0.0},{"x":9.0,"y":0.0},{"x":0.0,"y":9.0},{"x":9.0,"y":9.0}]);
        // The well-formed ones parse (what they do is tested with their packages).
        for command in [
            json!({"type": "cropPages", "pages": [0], "spec": {"type": "reset"}}),
            json!({"type": "markRedactions", "marks": [{"pageId": 0, "quads": [quad], "source": "text"}]}),
            json!({"type": "setMetadata", "patch": {"title": "t"}}),
        ] {
            assert!(serde_json::from_value::<DocCommand>(command).is_ok());
        }
        let mut state = state();
        for (command, expected) in [
            // Metadata that was not read cannot be edited; a control character is refused before anything runs.
            (
                json!({"type": "setMetadata", "patch": {"title": null}}),
                ErrorCode::InvalidArgument,
            ),
            (
                json!({"type": "setMetadata", "patch": {"title": "a\u{7}"}}),
                ErrorCode::InvalidArgument,
            ),
            // Shape checks come first.
            (
                json!({"type": "cropPages", "pages": [], "spec": {"type": "reset"}}),
                ErrorCode::InvalidArgument,
            ),
            (
                json!({"type": "markRedactions", "marks": []}),
                ErrorCode::InvalidArgument,
            ),
        ] {
            assert_eq!(code(state.execute(cmd(command), &stamp(0))), expected);
        }
        assert!(!state.is_dirty());
    }

    #[test]
    fn the_ui_cannot_send_a_protection_ticket() {
        let sent =
            serde_json::from_value::<DocCommand>(json!({"type": "setProtection", "ticket": 1}));
        assert!(sent.is_err());
        let labels = [
            (DocCommand::RemoveMetadata, "metadata.remove"),
            (
                DocCommand::SetProtection {
                    ticket: Ticket::new(1),
                },
                "protect.set",
            ),
        ];
        for (command, label) in labels {
            assert_eq!(command.label(), label);
            assert!(command.is_page_command());
        }
    }

    #[test]
    fn a_redact_mark_is_an_annotation_of_the_model_that_the_file_never_gets() {
        let mut state = state();
        let draft = cmd(json!({"type": "createAnnotation", "draft": {
            "pageId": 0, "kind": "redactMark", "color": [0, 0, 0], "source": "area",
            "quads": [[{"x":1.0,"y":1.0},{"x":9.0,"y":1.0},{"x":1.0,"y":9.0},{"x":9.0,"y":9.0}]]
        }}));
        let changes = state.execute(draft, &stamp(0)).unwrap();
        let mark = &changes.upserted[0];
        assert!(mark.body.is_redact_mark());
        assert!(!mark.body.is_written_as_annotation());
        // A text box is laid out by Rust: its lines and a box as tall as they are.
        let text_box = cmd(json!({"type": "createAnnotation", "draft": {
            "pageId": 0, "kind": "textBox", "color": [0, 0, 0], "box": {"x":1.0,"y":1.0,"w":80.0,"h":0.0},
            "text": "hi", "font": "sans", "fontSize": 12.0, "align": "left"
        }}));
        let made = state.execute(text_box, &stamp(1)).unwrap();
        assert!(made.upserted[0].body.is_content());
        assert!(made.upserted[0].rect.h > 12.0);
    }
}
