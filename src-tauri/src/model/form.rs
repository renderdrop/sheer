//! The form of a document (ADR-041): the AcroForm fields as a model that the UI fills. Nothing here names PDFium or lopdf.
//!
//! `pdfwrite::forms::read_fields` reads the field tree once (`FormModel::from_read`); values are model state from then on. A value
//! changes only through `DocCommand::SetFieldValue` (checked here: [`FormModel::set_value`]) and its undo ([`FormModel::restore`]).
//! `pdfwrite::forms::write_values` writes the fields whose value differs from the one in the file ([`FormModel::changed`]).
//! PDF object numbers stay in Rust: the UI sees a [`FieldId`].

use serde::{Deserialize, Serialize};

use super::annotation::Rgb;
use super::geometry::Rect;
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// The id of a field: unique within a document for the session, never reused. A plain number on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FieldId(u32);

impl FieldId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Where an object is in the file (object number and generation), without naming the library that reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct ObjRef {
    pub num: u32,
    pub generation: u16,
}

/// Values to put back into fields: the inverse of a change.
pub type FieldUndo = Vec<(FieldId, FieldValue)>;

/// What the user typed or chose (wire `{ type, ..fields }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FieldValue {
    Text {
        text: String,
    },
    Checked {
        on: bool,
    },
    /// An index into the field's `states`.
    Radio {
        selected: Option<u32>,
    },
    /// Export values; `custom` only for an editable combo box.
    Choice {
        selected: Vec<String>,
        custom: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChoiceOption {
    pub export: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FieldKind {
    Text {
        multiline: bool,
        max_len: Option<u32>,
        comb: bool,
        password: bool,
        align: Align,
        /// Points; 0 = automatic.
        font_size: f32,
    },
    Checkbox,
    Radio {
        /// The on-state names, sanitized; for display only.
        states: Vec<String>,
        no_toggle_off: bool,
    },
    Choice {
        combo: bool,
        editable: bool,
        multi_select: bool,
        options: Vec<ChoiceOption>,
    },
    Signature,
    Button,
    Unsupported,
}

/// What only Rust knows about a widget: where it is in the file and how it is drawn.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WidgetPdf {
    pub obj: ObjRef,
    /// The page's position in the file the form was read from.
    pub file_page: u32,
    /// The exact on-state name of a check box or radio button (`None`: no on-state is known).
    pub on_state: Option<String>,
    pub border_width: f32,
    /// `/MK /R`: 0, 90, 180 or 270.
    pub rotation: u16,
    /// The size of the `/DA` of this widget (0 = automatic).
    pub font_size: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub page_id: PageId,
    /// Page space.
    pub rect: Rect,
    /// Position among the widgets of its page in the page's tab order.
    pub tab_order: u32,
    /// Radio: index into the field's `states`.
    pub state: Option<u32>,
    pub fill: Option<Rgb>,
    pub border: Option<Rgb>,
    pub text_color: Rgb,
    #[serde(skip)]
    pub pdf: WidgetPdf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldSync {
    Clean,
    Modified,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub id: FieldId,
    /// Fully qualified, at most `MAX_FIELD_NAME_CHARS`.
    pub name: String,
    pub tooltip: Option<String>,
    pub kind: FieldKind,
    pub read_only: bool,
    pub required: bool,
    pub value: FieldValue,
    pub default_value: Option<FieldValue>,
    pub widgets: Vec<Widget>,
    pub sync: FieldSync,
    /// The field dictionary in the file.
    #[serde(skip)]
    pub obj: ObjRef,
    /// The value the file has.
    #[serde(skip)]
    pub saved: Option<FieldValue>,
    /// `/TI` of a list box: the first visible option.
    #[serde(skip)]
    pub top_index: u32,
}

impl FormField {
    fn is_fillable(&self) -> bool {
        matches!(
            self.kind,
            FieldKind::Text { .. }
                | FieldKind::Checkbox
                | FieldKind::Radio { .. }
                | FieldKind::Choice { .. }
        )
    }

    fn refresh_sync(&mut self) {
        let same = self.saved.as_ref() == Some(&self.value);
        self.sync = if same {
            FieldSync::Clean
        } else {
            FieldSync::Modified
        };
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Xfa {
    #[default]
    None,
    Hybrid,
    Full,
}

/// What the UI asks for first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormInfo {
    pub fields: Vec<FormField>,
    pub has_scripts: bool,
    pub xfa: Xfa,
    pub need_appearances: bool,
}

impl FormInfo {
    pub const fn empty() -> Self {
        Self {
            fields: Vec::new(),
            has_scripts: false,
            xfa: Xfa::None,
            need_appearances: false,
        }
    }
}

/// A field's value and whether it is saved, as the change set carries it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldState {
    pub id: FieldId,
    pub value: FieldValue,
    pub sync: FieldSync,
}

/// What `pdfwrite::forms::read_fields` found, before ids are given.
#[derive(Debug, Clone, Default)]
pub struct ReadForm {
    pub fields: Vec<FormField>,
    pub has_scripts: bool,
    pub xfa: Xfa,
    pub need_appearances: bool,
}

#[derive(Debug, Clone, Default)]
pub struct FormModel {
    fields: Vec<FormField>,
    next_id: u32,
    has_scripts: bool,
    xfa: Xfa,
    need_appearances: bool,
    /// The file changed under the model (a save): the next read of the field tree replaces the file side of every field.
    reread: bool,
}

/// The byte WinAnsiEncoding gives `c`, if it has one (the characters a form field can hold: Latin text, no other scripts).
pub fn winansi_byte(c: char) -> Option<u8> {
    let code = u32::from(c);
    match code {
        0x20..=0x7E | 0xA0..=0xFF => u8::try_from(code).ok(),
        0x20AC => Some(0x80),
        0x201A => Some(0x82),
        0x0192 => Some(0x83),
        0x201E => Some(0x84),
        0x2026 => Some(0x85),
        0x2020 => Some(0x86),
        0x2021 => Some(0x87),
        0x02C6 => Some(0x88),
        0x2030 => Some(0x89),
        0x0160 => Some(0x8A),
        0x2039 => Some(0x8B),
        0x0152 => Some(0x8C),
        0x017D => Some(0x8E),
        0x2018 => Some(0x91),
        0x2019 => Some(0x92),
        0x201C => Some(0x93),
        0x201D => Some(0x94),
        0x2022 => Some(0x95),
        0x2013 => Some(0x96),
        0x2014 => Some(0x97),
        0x02DC => Some(0x98),
        0x2122 => Some(0x99),
        0x0161 => Some(0x9A),
        0x203A => Some(0x9B),
        0x0153 => Some(0x9C),
        0x017E => Some(0x9E),
        0x0178 => Some(0x9F),
        _ => None,
    }
}

/// A text a field may hold: at most `MAX_FIELD_TEXT_CHARS`, WinAnsi characters only, a line feed only where `multiline`.
fn check_text(text: &str, multiline: bool) -> Result<(), AppError> {
    if text.chars().count() > limits::MAX_FIELD_TEXT_CHARS {
        return Err(AppError::limit("text", limits::MAX_FIELD_TEXT_CHARS as u64));
    }
    for c in text.chars() {
        let allowed = if c == '\n' {
            multiline
        } else {
            winansi_byte(c).is_some()
        };
        if !allowed {
            return Err(AppError::invalid("text"));
        }
    }
    Ok(())
}

impl FormModel {
    /// A model of what was read: ids from 1.
    pub fn from_read(read: ReadForm) -> Self {
        let mut model = Self {
            fields: Vec::new(),
            next_id: 1,
            has_scripts: read.has_scripts,
            xfa: read.xfa,
            need_appearances: read.need_appearances,
            reread: false,
        };
        model.fields = read
            .fields
            .into_iter()
            .map(|field| model.adopt(field))
            .collect();
        model
    }

    fn adopt(&mut self, mut field: FormField) -> FormField {
        field.id = FieldId::new(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        field.saved = Some(field.value.clone());
        field.refresh_sync();
        field
    }

    /// A save wrote the values: every field is clean, and the file's page order and object numbers may have changed (`reread`).
    pub fn finish_save(&mut self) {
        for field in &mut self.fields {
            field.saved = Some(field.value.clone());
            field.refresh_sync();
        }
        self.reread = true;
    }

    /// The field tree has to be read again (after a save, when the file may have changed shape).
    pub const fn needs_reread(&self) -> bool {
        self.reread
    }

    /// Takes the file side of `read` (positions, object numbers, widgets) and keeps the ids by fully qualified name. Values are the
    /// file's: the model is clean after a save.
    pub fn refresh(&mut self, read: ReadForm) {
        let mut old: Vec<Option<FieldId>> =
            self.fields.iter().map(|field| Some(field.id)).collect();
        let names: Vec<String> = self.fields.iter().map(|field| field.name.clone()).collect();
        let mut fields = Vec::with_capacity(read.fields.len());
        for mut field in read.fields {
            let taken = names
                .iter()
                .zip(old.iter_mut())
                .find(|(name, id)| **name == field.name && id.is_some())
                .and_then(|(_, id)| id.take());
            match taken {
                Some(id) => {
                    field.id = id;
                    field.saved = Some(field.value.clone());
                    field.refresh_sync();
                    fields.push(field);
                }
                None => fields.push(self.adopt(field)),
            }
        }
        self.fields = fields;
        self.has_scripts = read.has_scripts;
        self.xfa = read.xfa;
        self.need_appearances = read.need_appearances;
        self.reread = false;
    }

    pub fn has_scripts(&self) -> bool {
        self.has_scripts
    }

    pub const fn xfa(&self) -> Xfa {
        self.xfa
    }

    pub fn field(&self, id: FieldId) -> Option<&FormField> {
        self.fields.iter().find(|field| field.id == id)
    }

    fn field_mut(&mut self, id: FieldId) -> Option<&mut FormField> {
        self.fields.iter_mut().find(|field| field.id == id)
    }

    pub fn state(&self, id: FieldId) -> Option<FieldState> {
        self.field(id).map(|field| FieldState {
            id,
            value: field.value.clone(),
            sync: field.sync,
        })
    }

    /// The fields whose value is not the file's: what a save writes.
    pub fn changed(&self) -> Vec<&FormField> {
        self.fields
            .iter()
            .filter(|field| field.sync == FieldSync::Modified)
            .collect()
    }

    /// The form as the UI sees it. `resolve` says which page of the document a page of the file is now (`None`: the page is not in the
    /// document); widgets on pages that are not there are left out, and so are fields that have none left.
    pub fn info(&self, resolve: impl Fn(u32) -> Option<PageId>) -> FormInfo {
        let fields = self
            .fields
            .iter()
            .filter_map(|field| {
                let mut field = field.clone();
                field.widgets = field
                    .widgets
                    .into_iter()
                    .filter_map(|mut widget| {
                        widget.page_id = resolve(widget.pdf.file_page)?;
                        Some(widget)
                    })
                    .collect();
                (!field.widgets.is_empty()).then_some(field)
            })
            .collect();
        FormInfo {
            fields,
            has_scripts: self.has_scripts,
            xfa: self.xfa,
            need_appearances: self.need_appearances,
        }
    }

    /// Checks `value` against `field`. `invalid_argument` for a field the user cannot fill (`field`), a read-only one (`readOnly`), a
    /// value of another type (`value`), text that does not fit (`text`, `maxLen`), a choice that is not one (`value`); `limit_exceeded`
    /// for text over the limit.
    fn validate(field: &FormField, value: &FieldValue) -> Result<(), AppError> {
        if !field.is_fillable() {
            return Err(AppError::invalid("field"));
        }
        if field.read_only {
            return Err(AppError::invalid("readOnly"));
        }
        match (&field.kind, value) {
            (
                FieldKind::Text {
                    multiline, max_len, ..
                },
                FieldValue::Text { text },
            ) => {
                check_text(text, *multiline)?;
                if let Some(max) = max_len {
                    if text.chars().count() > *max as usize {
                        return Err(AppError::invalid("maxLen"));
                    }
                }
                Ok(())
            }
            (FieldKind::Checkbox, FieldValue::Checked { .. }) => Ok(()),
            (FieldKind::Radio { states, .. }, FieldValue::Radio { selected }) => match selected {
                Some(index) if *index as usize >= states.len() => Err(AppError::invalid("value")),
                _ => Ok(()),
            },
            (
                FieldKind::Choice {
                    editable,
                    multi_select,
                    options,
                    ..
                },
                FieldValue::Choice { selected, custom },
            ) => {
                if selected.len() > options.len().max(1) || (!multi_select && selected.len() > 1) {
                    return Err(AppError::invalid("value"));
                }
                for (position, export) in selected.iter().enumerate() {
                    let known = options.iter().any(|option| option.export == *export);
                    if !known || selected[..position].contains(export) {
                        return Err(AppError::invalid("value"));
                    }
                }
                if let Some(text) = custom {
                    if !editable || !selected.is_empty() {
                        return Err(AppError::invalid("value"));
                    }
                    check_text(text, false)?;
                }
                Ok(())
            }
            _ => Err(AppError::invalid("value")),
        }
    }

    /// Sets the value of a field (after [`FormModel::validate`]) and returns the one it had. `not_found` for an unknown field.
    pub fn set_value(&mut self, id: FieldId, value: &FieldValue) -> Result<FieldValue, AppError> {
        let field = self.field_mut(id).ok_or(AppError::not_found("field"))?;
        Self::validate(field, value)?;
        let old = std::mem::replace(&mut field.value, value.clone());
        field.refresh_sync();
        Ok(old)
    }

    /// Puts values back (the inverse of a change; not checked again) and returns what they replace, in the order that puts them
    /// back again. Unknown ids are skipped.
    pub fn restore(&mut self, values: &[(FieldId, FieldValue)]) -> FieldUndo {
        let mut inverse = Vec::with_capacity(values.len());
        for (id, value) in values {
            if let Some(field) = self.field_mut(*id) {
                let old = std::mem::replace(&mut field.value, value.clone());
                field.refresh_sync();
                inverse.push((*id, old));
            }
        }
        inverse.reverse();
        inverse
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn field(kind: FieldKind, value: FieldValue) -> FormField {
        FormField {
            id: FieldId::new(0),
            name: "f".into(),
            tooltip: None,
            kind,
            read_only: false,
            required: false,
            value,
            default_value: None,
            widgets: Vec::new(),
            sync: FieldSync::Clean,
            obj: ObjRef::default(),
            saved: None,
            top_index: 0,
        }
    }

    fn text_field(multiline: bool, max_len: Option<u32>) -> FormField {
        field(
            FieldKind::Text {
                multiline,
                max_len,
                comb: false,
                password: false,
                align: Align::Left,
                font_size: 0.0,
            },
            FieldValue::Text {
                text: String::new(),
            },
        )
    }

    fn model(fields: Vec<FormField>) -> FormModel {
        FormModel::from_read(ReadForm {
            fields,
            ..ReadForm::default()
        })
    }

    fn text(text: &str) -> FieldValue {
        FieldValue::Text { text: text.into() }
    }

    fn code(result: Result<FieldValue, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn text_is_winansi_with_line_feeds_only_in_multiline_fields_and_within_maxlen() {
        let mut m = model(vec![text_field(false, Some(3)), text_field(true, None)]);
        let (a, b) = (FieldId::new(1), FieldId::new(2));
        assert!(m.set_value(a, &text("abc")).is_ok());
        assert_eq!(
            code(m.set_value(a, &text("abcd"))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(a, &text("a\nb"))),
            ErrorCode::InvalidArgument
        );
        assert!(m.set_value(b, &text("a\nb \u{E4}\u{20AC}")).is_ok());
        assert_eq!(
            code(m.set_value(b, &text("\u{4E2D}"))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(b, &text("a\rb"))),
            ErrorCode::InvalidArgument
        );
        let long = "x".repeat(limits::MAX_FIELD_TEXT_CHARS + 1);
        assert_eq!(code(m.set_value(b, &text(&long))), ErrorCode::LimitExceeded);
    }

    #[test]
    fn a_value_of_another_type_or_for_a_read_only_field_is_refused() {
        let mut ro = text_field(false, None);
        ro.read_only = true;
        let mut m = model(vec![ro, text_field(false, None)]);
        assert_eq!(
            code(m.set_value(FieldId::new(1), &text("a"))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(FieldId::new(2), &FieldValue::Checked { on: true })),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(FieldId::new(9), &text("a"))),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn radio_and_choice_values_must_be_members() {
        let radio = field(
            FieldKind::Radio {
                states: vec!["A".into(), "B".into()],
                no_toggle_off: false,
            },
            FieldValue::Radio { selected: None },
        );
        let option = |export: &str| ChoiceOption {
            export: export.into(),
            label: export.into(),
        };
        let choice = |editable, multi_select| {
            field(
                FieldKind::Choice {
                    combo: true,
                    editable,
                    multi_select,
                    options: vec![option("a"), option("b")],
                },
                FieldValue::Choice {
                    selected: Vec::new(),
                    custom: None,
                },
            )
        };
        let mut m = model(vec![radio, choice(false, false), choice(true, true)]);
        let pick = |values: &[&str], custom: Option<&str>| FieldValue::Choice {
            selected: values.iter().map(|v| (*v).to_owned()).collect(),
            custom: custom.map(str::to_owned),
        };
        assert!(m
            .set_value(FieldId::new(1), &FieldValue::Radio { selected: Some(1) })
            .is_ok());
        assert_eq!(
            code(m.set_value(FieldId::new(1), &FieldValue::Radio { selected: Some(2) })),
            ErrorCode::InvalidArgument
        );
        assert!(m.set_value(FieldId::new(2), &pick(&["a"], None)).is_ok());
        assert_eq!(
            code(m.set_value(FieldId::new(2), &pick(&["c"], None))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(FieldId::new(2), &pick(&["a", "b"], None))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(FieldId::new(2), &pick(&[], Some("x")))),
            ErrorCode::InvalidArgument
        );
        assert!(m
            .set_value(FieldId::new(3), &pick(&["a", "b"], None))
            .is_ok());
        assert!(m
            .set_value(FieldId::new(3), &pick(&[], Some("free")))
            .is_ok());
        assert_eq!(
            code(m.set_value(FieldId::new(3), &pick(&["a"], Some("free")))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(m.set_value(FieldId::new(3), &pick(&["a", "a"], None))),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn sync_follows_the_value_and_restore_is_its_own_inverse() {
        let mut m = model(vec![text_field(false, None)]);
        let id = FieldId::new(1);
        assert_eq!(m.state(id).map(|s| s.sync), Some(FieldSync::Clean));
        let old = m.set_value(id, &text("x")).unwrap();
        assert_eq!(m.state(id).map(|s| s.sync), Some(FieldSync::Modified));
        assert_eq!(m.changed().len(), 1);
        let redo = m.restore(&[(id, old)]);
        assert_eq!(m.state(id).map(|s| s.sync), Some(FieldSync::Clean));
        m.restore(&redo);
        assert_eq!(m.state(id).map(|s| s.value), Some(text("x")));
        m.finish_save();
        assert!(m.changed().is_empty());
        assert!(m.needs_reread());
    }

    #[test]
    fn a_refresh_keeps_ids_by_name_and_gives_new_fields_new_ids() {
        let mut a = text_field(false, None);
        a.name = "a".into();
        let mut b = text_field(false, None);
        b.name = "b".into();
        let mut m = model(vec![a.clone(), b.clone()]);
        m.finish_save();
        let mut c = text_field(false, None);
        c.name = "c".into();
        m.refresh(ReadForm {
            fields: vec![b, c, a],
            ..ReadForm::default()
        });
        let ids: Vec<u32> = m.fields.iter().map(|f| f.id.get()).collect();
        assert_eq!(ids, vec![2, 3, 1]);
        assert!(!m.needs_reread());
    }

    #[test]
    fn winansi_has_the_euro_and_not_cjk() {
        assert_eq!(winansi_byte('A'), Some(0x41));
        assert_eq!(winansi_byte('\u{E9}'), Some(0xE9));
        assert_eq!(winansi_byte('\u{20AC}'), Some(0x80));
        assert_eq!(winansi_byte('\u{4E2D}'), None);
        assert_eq!(winansi_byte('\t'), None);
    }
}
