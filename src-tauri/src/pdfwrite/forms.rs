//! AcroForm fields, read and written (ADR-041 §1 and §3).
//!
//! [`read_fields`] walks the field tree once with lopdf (after the pre-scan of `load_untrusted`): iteratively, with a visited set and
//! bounded depth, counts and strings. [`write_values`] appends the fields whose value changed, and a regenerated appearance for every
//! widget of them, as an incremental update. `/NeedAppearances` is never set and no script is run.

use std::collections::{BTreeMap, HashMap, HashSet};

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};

use super::appearance::FONT_NAME;
use super::coords::{page_mapper, Mapper};
use super::field_ap::{self, ChoiceView, FieldAp, Frame, Mark, TextStyle};
use crate::documents::{sanitize_text, PageId};
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::Rgb;
use crate::model::form::{
    Align, ChoiceOption, FieldId, FieldKind, FieldSync, FieldValue, FormField, ObjRef, ReadForm,
    Widget, WidgetPdf, Xfa,
};
use crate::model::geometry::Rect;

// Field flags (ISO 32000-1, tables 221, 226, 228, 230).
const FF_READ_ONLY: i64 = 1;
const FF_REQUIRED: i64 = 1 << 1;
const FF_MULTILINE: i64 = 1 << 12;
const FF_PASSWORD: i64 = 1 << 13;
const FF_NO_TOGGLE_OFF: i64 = 1 << 14;
const FF_RADIO: i64 = 1 << 15;
const FF_PUSHBUTTON: i64 = 1 << 16;
const FF_COMBO: i64 = 1 << 17;
const FF_EDIT: i64 = 1 << 18;
const FF_FILE_SELECT: i64 = 1 << 20;
const FF_MULTI_SELECT: i64 = 1 << 21;
const FF_COMB: i64 = 1 << 24;
// Annotation flags: Hidden and NoView.
const ANNOT_HIDDEN: i64 = 2;
const ANNOT_NO_VIEW: i64 = 32;
/// Longest `/DA` string looked at.
const MAX_DA_BYTES: usize = 4096;

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

// --- Reading small values ------------------------------------------------------------------------------------------

fn deref<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, object)| object)
}

pub(super) fn entry<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    dict.get(key).ok().and_then(|object| deref(doc, object))
}

pub(super) fn int(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<i64> {
    match entry(doc, dict, key)? {
        Object::Integer(value) => Some(*value),
        Object::Real(value) if value.is_finite() => Some(f64::from(*value) as i64),
        _ => None,
    }
}

pub(super) fn number(object: &Object) -> Option<f32> {
    object.as_float().ok().filter(|value| value.is_finite())
}

fn name_of(object: &Object) -> Option<Vec<u8>> {
    object.as_name().ok().map(<[u8]>::to_vec)
}

pub(super) fn dict_of<'a>(
    doc: &'a Document,
    dict: &'a Dictionary,
    key: &[u8],
) -> Option<&'a Dictionary> {
    entry(doc, dict, key)?.as_dict().ok()
}

/// A text string of the file (UTF-16 with a byte order mark, UTF-8 with one, else Latin-1 as an approximation of PDFDocEncoding) as
/// text with line feeds only, at most `max` characters, without other control characters.
pub fn decode_text(bytes: &[u8], max: usize) -> String {
    let raw: String = if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_be_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else {
        bytes.iter().map(|b| char::from(*b)).collect()
    };
    let mut out = String::new();
    let mut count = 0usize;
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if count >= max {
            break;
        }
        count += 1;
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\n' => out.push('\n'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

fn text_value(doc: &Document, object: &Object, max: usize) -> Option<String> {
    match deref(doc, object)? {
        Object::String(bytes, _) => Some(decode_text(bytes, max)),
        _ => None,
    }
}

/// A name or a string as text (what a button's `/V` can be).
fn state_text(doc: &Document, object: &Object) -> Option<String> {
    match deref(doc, object)? {
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Object::String(bytes, _) => Some(decode_text(bytes, limits::MAX_FIELD_NAME_CHARS)),
        _ => None,
    }
}

/// A colour array of 1, 3 or 4 numbers (gray, RGB, CMYK); empty means transparent.
pub(super) fn color_of(doc: &Document, object: &Object) -> Option<Rgb> {
    let array = deref(doc, object)?.as_array().ok()?;
    let mut values = [0.0f32; 4];
    if array.len() > 4 {
        return None;
    }
    for (slot, item) in values.iter_mut().zip(array) {
        *slot = number(deref(doc, item)?)?.clamp(0.0, 1.0);
    }
    let channel = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    match array.len() {
        1 => Some(Rgb([channel(values[0]); 3])),
        3 => Some(Rgb([
            channel(values[0]),
            channel(values[1]),
            channel(values[2]),
        ])),
        4 => {
            let key = 1.0 - values[3];
            Some(Rgb([
                channel((1.0 - values[0]) * key),
                channel((1.0 - values[1]) * key),
                channel((1.0 - values[2]) * key),
            ]))
        }
        _ => None,
    }
}

/// The font size and the colour a default appearance string sets (`/Helv 12 Tf 0 0 1 rg`): the last of each.
pub fn parse_da(da: &[u8]) -> (f32, Rgb) {
    let da = &da[..da.len().min(MAX_DA_BYTES)];
    let text = String::from_utf8_lossy(da);
    let tokens: Vec<&str> = text.split_ascii_whitespace().collect();
    let mut size = 0.0f32;
    let mut color = Rgb([0, 0, 0]);
    let operands = |at: usize, count: usize| -> Option<Vec<f32>> {
        let start = at.checked_sub(count)?;
        tokens[start..at]
            .iter()
            .map(|t| t.parse::<f32>().ok().filter(|v| v.is_finite()))
            .collect()
    };
    let channel = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    for (at, token) in tokens.iter().enumerate() {
        match *token {
            "Tf" => {
                if let Some(v) = operands(at, 1) {
                    size = v[0].clamp(0.0, 1000.0);
                }
            }
            "g" => {
                if let Some(v) = operands(at, 1) {
                    color = Rgb([channel(v[0]); 3]);
                }
            }
            "rg" => {
                if let Some(v) = operands(at, 3) {
                    color = Rgb([channel(v[0]), channel(v[1]), channel(v[2])]);
                }
            }
            "k" => {
                if let Some(v) = operands(at, 4) {
                    let key = 1.0 - v[3].clamp(0.0, 1.0);
                    color = Rgb([
                        channel((1.0 - v[0].clamp(0.0, 1.0)) * key),
                        channel((1.0 - v[1].clamp(0.0, 1.0)) * key),
                        channel((1.0 - v[2].clamp(0.0, 1.0)) * key),
                    ]);
                }
            }
            _ => {}
        }
    }
    (size, color)
}

// --- Reading the field tree ----------------------------------------------------------------------------------------

/// What a field inherits from the nodes above it.
#[derive(Clone, Default)]
struct Inherited {
    ft: Option<Vec<u8>>,
    ff: Option<i64>,
    v: Option<Object>,
    dv: Option<Object>,
    da: Option<Vec<u8>>,
    q: Option<i64>,
    opt: Option<Object>,
    max_len: Option<i64>,
    name: String,
    depth: usize,
}

impl Inherited {
    fn below(&self, doc: &Document, dict: &Dictionary) -> Self {
        let mut next = self.clone();
        next.depth += 1;
        if let Some(ft) = entry(doc, dict, b"FT").and_then(name_of) {
            next.ft = Some(ft);
        }
        if let Some(ff) = int(doc, dict, b"Ff") {
            next.ff = Some(ff);
        }
        if let Some(v) = entry(doc, dict, b"V") {
            next.v = Some(v.clone());
        }
        if let Some(dv) = entry(doc, dict, b"DV") {
            next.dv = Some(dv.clone());
        }
        if let Some(Object::String(da, _)) = entry(doc, dict, b"DA") {
            next.da = Some(da.clone());
        }
        if let Some(q) = int(doc, dict, b"Q") {
            next.q = Some(q);
        }
        if let Some(opt) = entry(doc, dict, b"Opt") {
            next.opt = Some(opt.clone());
        }
        if let Some(max_len) = int(doc, dict, b"MaxLen") {
            next.max_len = Some(max_len);
        }
        if let Some(Object::String(part, _)) = entry(doc, dict, b"T") {
            let part = decode_text(part, limits::MAX_FIELD_NAME_CHARS);
            if next.name.is_empty() {
                next.name = part;
            } else {
                next.name = format!("{}.{part}", next.name);
            }
            next.name = next
                .name
                .chars()
                .take(limits::MAX_FIELD_NAME_CHARS)
                .collect();
        }
        next
    }
}

struct Reader<'a> {
    doc: &'a Document,
    acro_da: Option<Vec<u8>>,
    acro_q: i64,
    /// Where each annotation in a page's `/Annots` is: the page (position in the file) and its position in the array.
    annot_at: HashMap<ObjectId, (u32, usize)>,
    page_index: HashMap<ObjectId, u32>,
    pages: BTreeMap<u32, ObjectId>,
    mappers: HashMap<u32, Mapper>,
    scripts: bool,
    widgets: usize,
}

/// Dictionary has an action that runs JavaScript, or additional actions (`/AA`).
fn has_script(doc: &Document, dict: &Dictionary) -> bool {
    if dict.has(b"AA") {
        return true;
    }
    dict_of(doc, dict, b"A")
        .and_then(|action| entry(doc, action, b"S"))
        .and_then(name_of)
        .is_some_and(|s| s == b"JavaScript")
}

impl Reader<'_> {
    fn mapper(&mut self, page: u32) -> Option<Mapper> {
        if let Some(mapper) = self.mappers.get(&page) {
            return Some(*mapper);
        }
        let id = *self.pages.get(&(page + 1))?;
        let mapper = page_mapper(self.doc, id);
        self.mappers.insert(page, mapper);
        Some(mapper)
    }

    fn widget(
        &mut self,
        id: ObjectId,
        inherited: &Inherited,
    ) -> Option<(Widget, Option<String>, usize)> {
        let doc = self.doc;
        let dict = doc.get_dictionary(id).ok()?;
        self.scripts |= has_script(doc, dict);
        let flags = int(doc, dict, b"F").unwrap_or(0);
        if flags & (ANNOT_HIDDEN | ANNOT_NO_VIEW) != 0 {
            return None;
        }
        let (page, position) = match self.annot_at.get(&id) {
            Some((page, position)) => (*page, *position),
            None => {
                let page = dict
                    .get(b"P")
                    .ok()
                    .and_then(|p| p.as_reference().ok())
                    .and_then(|p| self.page_index.get(&p).copied())?;
                (page, usize::MAX)
            }
        };
        let rect = entry(doc, dict, b"Rect")?.as_array().ok()?;
        if rect.len() != 4 {
            return None;
        }
        let mut v = [0.0f32; 4];
        for (slot, item) in v.iter_mut().zip(rect) {
            *slot = number(deref(doc, item)?)?;
        }
        let (left, right) = (v[0].min(v[2]), v[0].max(v[2]));
        let (bottom, top) = (v[1].min(v[3]), v[1].max(v[3]));
        if right - left <= 0.0 || top - bottom <= 0.0 {
            return None;
        }
        let mapper = self.mapper(page)?;
        let origin = mapper.page_point(left, top);
        let mk = dict_of(doc, dict, b"MK");
        let fill = mk
            .and_then(|mk| mk.get(b"BG").ok())
            .and_then(|c| color_of(doc, c));
        let border = mk
            .and_then(|mk| mk.get(b"BC").ok())
            .and_then(|c| color_of(doc, c));
        let rotation = mk
            .and_then(|mk| int(doc, mk, b"R"))
            .map_or(0, |r| u16::try_from(r.rem_euclid(360)).unwrap_or(0));
        let rotation = if rotation.is_multiple_of(90) {
            rotation
        } else {
            0
        };
        let border_width = dict_of(doc, dict, b"BS")
            .and_then(|bs| entry(doc, bs, b"W"))
            .and_then(number)
            .or_else(|| {
                entry(doc, dict, b"Border")
                    .and_then(|b| b.as_array().ok())
                    .and_then(|b| b.get(2))
                    .and_then(|w| deref(doc, w))
                    .and_then(number)
            })
            .unwrap_or(1.0)
            .clamp(0.0, 20.0);
        let da = match entry(doc, dict, b"DA") {
            Some(Object::String(da, _)) => Some(da.clone()),
            _ => inherited.da.clone().or_else(|| self.acro_da.clone()),
        };
        let (font_size, text_color) = da.as_deref().map_or((0.0, Rgb([0, 0, 0])), parse_da);
        // The on-state of a button is the key of its normal appearance that is not `Off`.
        let ap_n = dict_of(doc, dict, b"AP").and_then(|ap| entry(doc, ap, b"N"));
        let on_state = ap_n.and_then(|n| n.as_dict().ok()).and_then(|n| {
            n.iter()
                .map(|(key, _)| key)
                .find(|key| key.as_slice() != b"Off")
                .map(|key| String::from_utf8_lossy(key).into_owned())
        });
        let current = entry(doc, dict, b"AS")
            .and_then(name_of)
            .map(|state| String::from_utf8_lossy(&state).into_owned());
        let widget = Widget {
            page_id: PageId::new(0),
            rect: Rect {
                x: origin.x,
                y: origin.y,
                w: right - left,
                h: top - bottom,
            },
            tab_order: 0,
            state: None,
            fill,
            border,
            text_color,
            pdf: WidgetPdf {
                obj: ObjRef {
                    num: id.0,
                    generation: id.1,
                },
                file_page: page,
                on_state,
                border_width,
                rotation,
                font_size,
            },
        };
        Some((widget, current, position))
    }
}

/// A value of a field as text: a string, or a name.
fn button_state(doc: &Document, object: Option<&Object>) -> Option<String> {
    state_text(doc, object?)
}

fn read_options(doc: &Document, opt: Option<&Object>) -> Vec<ChoiceOption> {
    let Some(Object::Array(items)) = opt.and_then(|o| deref(doc, o)) else {
        return Vec::new();
    };
    items
        .iter()
        .take(limits::MAX_FIELD_OPTIONS)
        .filter_map(|item| match deref(doc, item)? {
            Object::String(bytes, _) => {
                let text = decode_text(bytes, limits::MAX_FIELD_NAME_CHARS);
                Some(ChoiceOption {
                    export: text.clone(),
                    label: sanitize_text(&text, limits::MAX_FIELD_NAME_CHARS),
                })
            }
            Object::Array(pair) => {
                let export = text_value(doc, pair.first()?, limits::MAX_FIELD_NAME_CHARS)?;
                let label = pair
                    .get(1)
                    .and_then(|l| text_value(doc, l, limits::MAX_FIELD_NAME_CHARS))
                    .unwrap_or_else(|| export.clone());
                Some(ChoiceOption {
                    export,
                    label: sanitize_text(&label, limits::MAX_FIELD_NAME_CHARS),
                })
            }
            _ => None,
        })
        .collect()
}

fn read_choice_value(
    doc: &Document,
    object: Option<&Object>,
    options: &[ChoiceOption],
    editable: bool,
) -> FieldValue {
    let mut values: Vec<String> = Vec::new();
    match object.and_then(|o| deref(doc, o)) {
        Some(Object::String(bytes, _)) => {
            values.push(decode_text(bytes, limits::MAX_FIELD_NAME_CHARS));
        }
        Some(Object::Array(items)) => {
            for item in items.iter().take(limits::MAX_FIELD_OPTIONS) {
                if let Some(text) = text_value(doc, item, limits::MAX_FIELD_NAME_CHARS) {
                    values.push(text);
                }
            }
        }
        _ => {}
    }
    values.dedup();
    let known = |value: &String| options.iter().any(|option| option.export == *value);
    if editable && values.len() == 1 && !known(&values[0]) {
        return FieldValue::Choice {
            selected: Vec::new(),
            custom: values.pop(),
        };
    }
    FieldValue::Choice {
        selected: values,
        custom: None,
    }
}

/// Builds a field from its terminal node. `widget_ids`: the objects that are its widgets.
fn build_field(
    reader: &mut Reader<'_>,
    id: ObjectId,
    inherited: &Inherited,
    widget_ids: &[ObjectId],
) -> Result<Option<(FormField, Vec<usize>)>, AppError> {
    let doc = reader.doc;
    let Ok(dict) = doc.get_dictionary(id) else {
        return Ok(None);
    };
    reader.scripts |= has_script(doc, dict);
    let flags = inherited.ff.unwrap_or(0);
    let mut widgets: Vec<Widget> = Vec::new();
    let mut current: Vec<Option<String>> = Vec::new();
    let mut positions: Vec<usize> = Vec::new();
    for widget_id in widget_ids {
        if reader.widgets >= limits::MAX_FORM_WIDGETS {
            return Err(AppError::limit("widgets", limits::MAX_FORM_WIDGETS as u64));
        }
        if let Some((widget, state, position)) = reader.widget(*widget_id, inherited) {
            reader.widgets += 1;
            widgets.push(widget);
            current.push(state);
            positions.push(position);
        }
    }
    let ft = inherited.ft.as_deref().unwrap_or(b"");
    let align = match inherited.q.unwrap_or(reader.acro_q) {
        1 => Align::Center,
        2 => Align::Right,
        _ => Align::Left,
    };
    let text_of_value = |object: Option<&Object>| -> FieldValue {
        FieldValue::Text {
            text: object
                .and_then(|o| text_value(doc, o, limits::MAX_FIELD_TEXT_CHARS))
                .unwrap_or_default(),
        }
    };
    let (kind, value, default_value) = match ft {
        b"Tx" if flags & FF_FILE_SELECT == 0 => {
            let multiline = flags & FF_MULTILINE != 0;
            let password = flags & FF_PASSWORD != 0;
            let max_len = inherited
                .max_len
                .and_then(|m| u32::try_from(m).ok())
                .filter(|m| (1..=limits::MAX_FIELD_TEXT_CHARS as u32).contains(m));
            (
                FieldKind::Text {
                    multiline,
                    max_len,
                    comb: flags & FF_COMB != 0 && max_len.is_some() && !multiline && !password,
                    password,
                    align,
                    font_size: widgets.first().map_or(0.0, |w| w.pdf.font_size),
                },
                text_of_value(inherited.v.as_ref()),
                Some(text_of_value(inherited.dv.as_ref())),
            )
        }
        b"Btn" if flags & FF_PUSHBUTTON != 0 => {
            (FieldKind::Button, FieldValue::Checked { on: false }, None)
        }
        b"Btn" => {
            let mut states: Vec<String> = Vec::new();
            for widget in &widgets {
                if let Some(state) = &widget.pdf.on_state {
                    if !states.contains(state) && states.len() < limits::MAX_FIELD_OPTIONS {
                        states.push(state.clone());
                    }
                }
            }
            let v = button_state(doc, inherited.v.as_ref()).filter(|s| s != "Off");
            let dv = button_state(doc, inherited.dv.as_ref()).filter(|s| s != "Off");
            if flags & FF_RADIO != 0 || states.len() > 1 {
                for widget in &mut widgets {
                    widget.state = widget
                        .pdf
                        .on_state
                        .as_ref()
                        .and_then(|s| states.iter().position(|o| o == s))
                        .and_then(|index| u32::try_from(index).ok());
                }
                let from_widgets = || {
                    widgets
                        .iter()
                        .zip(&current)
                        .find(|(w, now)| w.pdf.on_state.is_some() && w.pdf.on_state == **now)
                        .and_then(|(w, _)| w.state)
                };
                let index_of = |name: &Option<String>| {
                    name.as_ref()
                        .and_then(|n| states.iter().position(|s| s == n))
                        .and_then(|i| u32::try_from(i).ok())
                };
                let selected = if v.is_some() {
                    index_of(&v)
                } else {
                    from_widgets()
                };
                let default = index_of(&dv);
                (
                    FieldKind::Radio {
                        states: states
                            .iter()
                            .map(|s| sanitize_text(s, limits::MAX_FIELD_NAME_CHARS))
                            .collect(),
                        no_toggle_off: flags & FF_NO_TOGGLE_OFF != 0,
                    },
                    FieldValue::Radio { selected },
                    Some(FieldValue::Radio { selected: default }),
                )
            } else {
                let on = v.is_some()
                    || (inherited.v.is_none()
                        && widgets.iter().zip(&current).any(|(w, now)| {
                            now.as_deref().is_some_and(|s| s != "Off") && w.pdf.on_state.is_some()
                        }));
                (
                    FieldKind::Checkbox,
                    FieldValue::Checked { on },
                    Some(FieldValue::Checked { on: dv.is_some() }),
                )
            }
        }
        b"Ch" => {
            let combo = flags & FF_COMBO != 0;
            let editable = combo && flags & FF_EDIT != 0;
            let options = read_options(doc, inherited.opt.as_ref());
            let value = read_choice_value(doc, inherited.v.as_ref(), &options, editable);
            let default = read_choice_value(doc, inherited.dv.as_ref(), &options, editable);
            (
                FieldKind::Choice {
                    combo,
                    editable,
                    multi_select: !combo && flags & FF_MULTI_SELECT != 0,
                    options,
                },
                value,
                Some(default),
            )
        }
        b"Sig" => (
            FieldKind::Signature,
            FieldValue::Checked { on: false },
            None,
        ),
        _ => (
            FieldKind::Unsupported,
            FieldValue::Checked { on: false },
            None,
        ),
    };
    let tooltip = entry(doc, dict, b"TU")
        .and_then(|t| text_value(doc, t, limits::MAX_FIELD_NAME_CHARS))
        .map(|t| sanitize_text(&t, limits::MAX_FIELD_NAME_CHARS))
        .filter(|t| !t.is_empty());
    let top_index = int(doc, dict, b"TI")
        .and_then(|t| u32::try_from(t).ok())
        .unwrap_or(0);
    let field = FormField {
        id: FieldId::new(0),
        name: sanitize_text(&inherited.name, limits::MAX_FIELD_NAME_CHARS),
        tooltip,
        kind,
        read_only: flags & FF_READ_ONLY != 0,
        required: flags & FF_REQUIRED != 0,
        value,
        default_value,
        widgets,
        sync: FieldSync::Clean,
        obj: ObjRef {
            num: id.0,
            generation: id.1,
        },
        saved: None,
        top_index,
    };
    Ok(Some((field, positions)))
}

/// Orders the widgets of each page by the page's `/Tabs` (ADR-041 §1) and writes the position into each.
fn assign_tab_order(
    doc: &Document,
    pages: &BTreeMap<u32, ObjectId>,
    fields: &mut [FormField],
    positions: &[Vec<usize>],
) {
    struct Item {
        field: usize,
        widget: usize,
        position: usize,
        x: f32,
        y: f32,
    }
    let mut by_page: BTreeMap<u32, Vec<Item>> = BTreeMap::new();
    for (field_index, field) in fields.iter().enumerate() {
        for (widget_index, widget) in field.widgets.iter().enumerate() {
            by_page.entry(widget.pdf.file_page).or_default().push(Item {
                field: field_index,
                widget: widget_index,
                position: positions[field_index][widget_index],
                x: widget.rect.x,
                y: widget.rect.y,
            });
        }
    }
    for (page, mut items) in by_page {
        let tabs = pages
            .get(&(page + 1))
            .and_then(|id| doc.get_dictionary(*id).ok())
            .and_then(|dict| entry(doc, dict, b"Tabs"))
            .and_then(name_of)
            .unwrap_or_default();
        match tabs.as_slice() {
            b"R" | b"S" => items.sort_by(|a, b| {
                (a.y.round() as i64, a.x.round() as i64, a.position).cmp(&(
                    b.y.round() as i64,
                    b.x.round() as i64,
                    b.position,
                ))
            }),
            b"C" => items.sort_by(|a, b| {
                (a.x.round() as i64, a.y.round() as i64, a.position).cmp(&(
                    b.x.round() as i64,
                    b.y.round() as i64,
                    b.position,
                ))
            }),
            _ => items.sort_by_key(|item| item.position),
        }
        for (order, item) in items.iter().enumerate() {
            fields[item.field].widgets[item.widget].tab_order =
                u32::try_from(order).unwrap_or(u32::MAX);
        }
    }
}

/// Reads the AcroForm of `bytes` (a PDF that is not encrypted). No AcroForm: an empty form.
pub fn read_fields(bytes: &[u8]) -> Result<ReadForm, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    read_from(&doc)
}

fn read_from(doc: &Document) -> Result<ReadForm, AppError> {
    let mut form = ReadForm::default();
    let Ok(catalog) = doc.catalog() else {
        return Ok(form);
    };
    let Some(acro) = dict_of(doc, catalog, b"AcroForm") else {
        return Ok(form);
    };
    form.need_appearances = entry(doc, acro, b"NeedAppearances")
        .and_then(|o| o.as_bool().ok())
        .unwrap_or(false);
    let has_xfa = acro.has(b"XFA");
    let pages = doc.get_pages();
    let mut annot_at = HashMap::new();
    let mut page_index = HashMap::new();
    let mut scripts = dict_of(doc, catalog, b"Names").is_some_and(|names| names.has(b"JavaScript"))
        || has_script(doc, catalog)
        || dict_of(doc, catalog, b"OpenAction").is_some_and(|action| {
            entry(doc, action, b"S")
                .and_then(name_of)
                .is_some_and(|s| s == b"JavaScript")
        })
        || entry(doc, acro, b"CO")
            .and_then(|co| co.as_array().ok())
            .is_some_and(|co| !co.is_empty());
    for (number, page_id) in &pages {
        let index = number - 1;
        page_index.insert(*page_id, index);
        let Ok(page) = doc.get_dictionary(*page_id) else {
            continue;
        };
        if let Some(Object::Array(annots)) = entry(doc, page, b"Annots") {
            for (position, item) in annots.iter().take(limits::MAX_ANNOTS_ARRAY).enumerate() {
                if let Ok(id) = item.as_reference() {
                    annot_at.entry(id).or_insert((index, position));
                }
            }
        }
    }
    let acro_da = match entry(doc, acro, b"DA") {
        Some(Object::String(da, _)) => Some(da.clone()),
        _ => None,
    };
    let mut reader = Reader {
        doc,
        acro_da,
        acro_q: int(doc, acro, b"Q").unwrap_or(0),
        annot_at,
        page_index,
        pages: pages.clone(),
        mappers: HashMap::new(),
        scripts: false,
        widgets: 0,
    };
    let roots: Vec<ObjectId> = match entry(doc, acro, b"Fields") {
        Some(Object::Array(items)) => items
            .iter()
            .take(limits::MAX_FORM_NODES)
            .filter_map(|item| item.as_reference().ok())
            .collect(),
        _ => Vec::new(),
    };
    let root = Inherited::default();
    let mut stack: Vec<(ObjectId, Inherited)> = roots
        .into_iter()
        .rev()
        .map(|id| (id, root.clone()))
        .collect();
    let mut visited: HashSet<ObjectId> = HashSet::new();
    let mut fields: Vec<FormField> = Vec::new();
    let mut positions: Vec<Vec<usize>> = Vec::new();
    while let Some((id, parent)) = stack.pop() {
        if !visited.insert(id) {
            continue;
        }
        if visited.len() > limits::MAX_FORM_NODES {
            return Err(AppError::limit("fields", limits::MAX_FORM_NODES as u64));
        }
        let Ok(dict) = doc.get_dictionary(id) else {
            continue;
        };
        let here = parent.below(doc, dict);
        let kids: Vec<ObjectId> = match entry(doc, dict, b"Kids") {
            Some(Object::Array(items)) => items
                .iter()
                .take(limits::MAX_FORM_NODES)
                .filter_map(|item| item.as_reference().ok())
                .collect(),
            _ => Vec::new(),
        };
        let is_field = |kid: &ObjectId| {
            doc.get_dictionary(*kid)
                .is_ok_and(|d| d.has(b"T") || d.has(b"Kids"))
        };
        let field_kids: Vec<ObjectId> = kids.iter().copied().filter(is_field).collect();
        if !field_kids.is_empty() {
            if here.depth < limits::MAX_FORM_DEPTH {
                for kid in field_kids.into_iter().rev() {
                    stack.push((kid, here.clone()));
                }
            }
            continue;
        }
        if fields.len() >= limits::MAX_FORM_FIELDS {
            return Err(AppError::limit("fields", limits::MAX_FORM_FIELDS as u64));
        }
        let widget_ids: Vec<ObjectId> = if kids.is_empty() { vec![id] } else { kids };
        if let Some((field, at)) = build_field(&mut reader, id, &here, &widget_ids)? {
            fields.push(field);
            positions.push(at);
        }
    }
    scripts |= reader.scripts;
    assign_tab_order(doc, &pages, &mut fields, &positions);
    form.has_scripts = scripts;
    form.xfa = match (has_xfa, fields.is_empty()) {
        (false, _) => Xfa::None,
        (true, false) => Xfa::Hybrid,
        (true, true) => Xfa::Full,
    };
    form.fields = fields;
    Ok(form)
}

// --- Writing -------------------------------------------------------------------------------------------------------

/// A text string for `/V`: PDFDocEncoding (here Latin-1 without the C1 range) if every character is in it, else UTF-16BE with a mark.
pub fn pdf_text_string(text: &str) -> Object {
    let plain = text.chars().all(|c| {
        matches!(c, '\n' | '\r' | '\t')
            || (' '..='~').contains(&c)
            || (('\u{A1}'..='\u{FF}').contains(&c) && c != '\u{AD}')
    });
    let bytes = if plain {
        text.chars()
            .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
            .collect()
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        bytes
    };
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn name_object(text: &str) -> Object {
    Object::Name(text.as_bytes().to_vec())
}

fn id_of(reference: ObjRef) -> ObjectId {
    (reference.num, reference.generation)
}

/// The on-state name of a check box (a generated one when the file has none).
fn check_state(field: &FormField) -> String {
    field
        .widgets
        .iter()
        .find_map(|w| w.pdf.on_state.clone())
        .unwrap_or_else(|| "Yes".to_owned())
}

/// The on-state name of the radio button `index`.
fn radio_state(field: &FormField, index: u32) -> Option<String> {
    field
        .widgets
        .iter()
        .find(|w| w.state == Some(index))
        .and_then(|w| w.pdf.on_state.clone())
}

/// Sets `/V` (and `/I`) of a field dictionary from its value; `/RV` goes.
fn set_field_value(dict: &mut Dictionary, field: &FormField) {
    dict.remove(b"RV");
    match (&field.kind, &field.value) {
        (FieldKind::Text { .. }, FieldValue::Text { text }) => {
            dict.set("V", pdf_text_string(text));
        }
        (FieldKind::Checkbox, FieldValue::Checked { on }) => {
            let state = if *on {
                check_state(field)
            } else {
                "Off".to_owned()
            };
            dict.set("V", name_object(&state));
        }
        (FieldKind::Radio { .. }, FieldValue::Radio { selected }) => {
            let state = selected
                .and_then(|index| radio_state(field, index))
                .unwrap_or_else(|| "Off".to_owned());
            dict.set("V", name_object(&state));
        }
        (
            FieldKind::Choice {
                multi_select,
                options,
                ..
            },
            FieldValue::Choice { selected, custom },
        ) => {
            dict.remove(b"I");
            if let Some(custom) = custom {
                dict.set("V", pdf_text_string(custom));
            } else if *multi_select {
                dict.set(
                    "V",
                    Object::Array(selected.iter().map(|s| pdf_text_string(s)).collect()),
                );
                let mut indices: Vec<i64> = selected
                    .iter()
                    .filter_map(|s| options.iter().position(|o| o.export == *s))
                    .filter_map(|i| i64::try_from(i).ok())
                    .collect();
                indices.sort_unstable();
                dict.set(
                    "I",
                    Object::Array(indices.into_iter().map(Object::Integer).collect()),
                );
            } else if let Some(first) = selected.first() {
                dict.set("V", pdf_text_string(first));
            } else {
                dict.remove(b"V");
            }
        }
        _ => {}
    }
}

fn stream_of(ap: &FieldAp) -> Stream {
    let real = |v: f32| Object::Real(if v.is_finite() { v } else { 0.0 });
    let mut dict = Dictionary::new();
    dict.set("Type", name_object("XObject"));
    dict.set("Subtype", name_object("Form"));
    dict.set(
        "BBox",
        Object::Array(ap.bbox.iter().map(|v| real(*v)).collect()),
    );
    if let Some(matrix) = ap.matrix {
        dict.set(
            "Matrix",
            Object::Array(matrix.iter().map(|v| real(*v)).collect()),
        );
    }
    let mut resources = Dictionary::new();
    if ap.uses_font {
        let mut font = Dictionary::new();
        font.set("Type", name_object("Font"));
        font.set("Subtype", name_object("Type1"));
        font.set("BaseFont", name_object("Helvetica"));
        font.set("Encoding", name_object("WinAnsiEncoding"));
        let mut fonts = Dictionary::new();
        fonts.set(FONT_NAME, Object::Dictionary(font));
        resources.set("Font", Object::Dictionary(fonts));
    }
    dict.set("Resources", Object::Dictionary(resources));
    Stream::new(dict, ap.content.clone().into_bytes())
}

/// The appearance a widget gets, before it is an object.
enum NewAp {
    /// The widget keeps what it has.
    Keep,
    /// One appearance, the normal one.
    Normal(FieldAp),
    /// A button: the on-state and the off-state.
    States {
        on: String,
        on_ap: FieldAp,
        off_ap: FieldAp,
    },
}

fn user_rect(doc: &Document, dict: &Dictionary) -> Option<(f32, f32)> {
    let rect = entry(doc, dict, b"Rect")?.as_array().ok()?;
    if rect.len() != 4 {
        return None;
    }
    let mut v = [0.0f32; 4];
    for (slot, item) in v.iter_mut().zip(rect) {
        *slot = number(deref(doc, item)?)?;
    }
    let (w, h) = ((v[2] - v[0]).abs(), (v[3] - v[1]).abs());
    (w > 0.0 && h > 0.0).then_some((w, h))
}

/// Whether the normal appearance of a widget has a stream for `state`.
fn has_state(doc: &Document, dict: &Dictionary, state: &str) -> bool {
    dict_of(doc, dict, b"AP")
        .and_then(|ap| dict_of(doc, ap, b"N"))
        .is_some_and(|n| n.has(state.as_bytes()))
}

fn text_color_style(field: &FormField, widget: &Widget) -> TextStyle {
    let (align, multiline, comb, max_len, password) = match &field.kind {
        FieldKind::Text {
            align,
            multiline,
            comb,
            max_len,
            password,
            ..
        } => (*align, *multiline, *comb, *max_len, *password),
        _ => (Align::Left, false, false, None, false),
    };
    TextStyle {
        align,
        font_size: widget.pdf.font_size,
        color: widget.text_color,
        multiline,
        comb,
        max_len,
        password,
    }
}

/// What the widget's appearance becomes for the field's value.
fn new_appearance(prev: &Document, dict: &Dictionary, field: &FormField, widget: &Widget) -> NewAp {
    let Some((w, h)) = user_rect(prev, dict) else {
        return NewAp::Keep;
    };
    let frame = Frame {
        w,
        h,
        fill: widget.fill,
        border: widget.border,
        border_width: widget.pdf.border_width,
        rotation: widget.pdf.rotation,
    };
    match (&field.kind, &field.value) {
        (FieldKind::Text { .. }, FieldValue::Text { text }) => NewAp::Normal(field_ap::text_ap(
            &frame,
            &text_color_style(field, widget),
            text,
        )),
        (FieldKind::Choice { combo, options, .. }, FieldValue::Choice { selected, custom }) => {
            NewAp::Normal(field_ap::choice_ap(
                &frame,
                &text_color_style(field, widget),
                &ChoiceView {
                    combo: *combo,
                    options,
                    selected,
                    custom: custom.as_deref(),
                    top_index: field.top_index as usize,
                },
            ))
        }
        (FieldKind::Checkbox | FieldKind::Radio { .. }, _) => {
            let mark = if matches!(field.kind, FieldKind::Radio { .. }) {
                Mark::Radio
            } else {
                Mark::Check
            };
            let on = widget_state_name(field, widget);
            if on
                .as_deref()
                .is_some_and(|state| has_state(prev, dict, state))
            {
                return NewAp::Keep;
            }
            let state = on.unwrap_or_else(|| "Yes".to_owned());
            NewAp::States {
                on_ap: field_ap::mark_ap(&frame, mark, true, widget.text_color),
                off_ap: field_ap::mark_ap(&frame, mark, false, widget.text_color),
                on: state,
            }
        }
        _ => NewAp::Keep,
    }
}

/// The on-state name of a button widget (`None` for a check box widget that has none).
fn widget_state_name(field: &FormField, widget: &Widget) -> Option<String> {
    match field.kind {
        FieldKind::Checkbox => Some(check_state(field)),
        _ => widget.pdf.on_state.clone(),
    }
}

/// `/AS` of a button widget for the field's value.
fn appearance_state(field: &FormField, widget: &Widget) -> Option<String> {
    match (&field.kind, &field.value) {
        (FieldKind::Checkbox, FieldValue::Checked { on }) => Some(if *on {
            widget_state_name(field, widget).unwrap_or_else(|| "Yes".to_owned())
        } else {
            "Off".to_owned()
        }),
        (FieldKind::Radio { .. }, FieldValue::Radio { selected }) => {
            let own = widget.state?;
            Some(if *selected == Some(own) {
                widget
                    .pdf
                    .on_state
                    .clone()
                    .unwrap_or_else(|| "Yes".to_owned())
            } else {
                "Off".to_owned()
            })
        }
        _ => None,
    }
}

/// The file with the values written, and whether `/XFA` was taken out of the AcroForm.
#[derive(Debug)]
pub struct Written {
    pub bytes: Vec<u8>,
    pub xfa_removed: bool,
}

/// Appends the changed `fields` to `original` (a PDF that is not encrypted): the field dictionaries with `/V`, and the widgets with
/// `/AS` and a regenerated `/AP` where the field needs one. With `strip_xfa` (a hybrid form) `/XFA` goes out of the AcroForm.
/// Nothing to write: the original comes back as it is.
pub fn write_values(
    original: Vec<u8>,
    fields: &[FormField],
    strip_xfa: bool,
) -> Result<Written, AppError> {
    if fields.is_empty() {
        return Ok(Written {
            bytes: original,
            xfa_removed: false,
        });
    }
    let doc = super::prescan::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let mut inc = IncrementalDocument::create_from(original, doc);
    for field in fields {
        let field_id = id_of(field.obj);
        let mut field_dict = inc
            .get_prev_documents()
            .get_dictionary(field_id)
            .map_err(|e| failed(format!("lopdf: {e}")))?
            .clone();
        set_field_value(&mut field_dict, field);
        let mut separate: Vec<(ObjectId, Dictionary)> = Vec::new();
        for widget in &field.widgets {
            let widget_id = id_of(widget.pdf.obj);
            let merged = widget_id == field_id;
            let mut dict = if merged {
                field_dict.clone()
            } else {
                match inc.get_prev_documents().get_dictionary(widget_id) {
                    Ok(dict) => dict.clone(),
                    Err(_) => continue,
                }
            };
            let appearance = new_appearance(inc.get_prev_documents(), &dict, field, widget);
            if let Some(state) = appearance_state(field, widget) {
                dict.set("AS", name_object(&state));
            }
            match appearance {
                NewAp::Keep => {}
                NewAp::Normal(ap) => {
                    let stream = inc.new_document.add_object(stream_of(&ap));
                    let mut normal = Dictionary::new();
                    normal.set("N", Object::Reference(stream));
                    dict.set("AP", Object::Dictionary(normal));
                }
                NewAp::States { on, on_ap, off_ap } => {
                    let on_id = inc.new_document.add_object(stream_of(&on_ap));
                    let off_id = inc.new_document.add_object(stream_of(&off_ap));
                    let mut states = Dictionary::new();
                    states.set(on.as_bytes().to_vec(), Object::Reference(on_id));
                    states.set("Off", Object::Reference(off_id));
                    let mut normal = Dictionary::new();
                    normal.set("N", Object::Dictionary(states));
                    dict.set("AP", Object::Dictionary(normal));
                }
            }
            if merged {
                field_dict = dict;
            } else {
                separate.push((widget_id, dict));
            }
        }
        inc.new_document
            .set_object(field_id, Object::Dictionary(field_dict));
        for (id, dict) in separate {
            inc.new_document.set_object(id, Object::Dictionary(dict));
        }
    }
    let xfa_removed = if strip_xfa {
        remove_xfa(&mut inc)?
    } else {
        false
    };
    let mut bytes = Vec::new();
    inc.save_to(&mut bytes)
        .map_err(|e| failed(format!("lopdf: {e}")))?;
    Ok(Written { bytes, xfa_removed })
}

/// Takes `/XFA` out of the AcroForm (a new copy of it, or of the catalog when the AcroForm is written in it). `true` if there was one.
fn remove_xfa(inc: &mut IncrementalDocument) -> Result<bool, AppError> {
    let (root_id, catalog) = {
        let prev = inc.get_prev_documents();
        let root_id = prev
            .trailer
            .get(b"Root")
            .and_then(Object::as_reference)
            .map_err(|e| failed(format!("lopdf: {e}")))?;
        (
            root_id,
            prev.get_dictionary(root_id)
                .map_err(|e| failed(format!("lopdf: {e}")))?
                .clone(),
        )
    };
    match catalog.get(b"AcroForm") {
        Ok(Object::Reference(id)) => {
            let mut acro = inc
                .get_prev_documents()
                .get_dictionary(*id)
                .map_err(|e| failed(format!("lopdf: {e}")))?
                .clone();
            let removed = acro.remove(b"XFA").is_some();
            if removed {
                inc.new_document.set_object(*id, Object::Dictionary(acro));
            }
            Ok(removed)
        }
        Ok(Object::Dictionary(acro)) => {
            let mut acro = acro.clone();
            let removed = acro.remove(b"XFA").is_some();
            if removed {
                let mut catalog = catalog;
                catalog.set("AcroForm", Object::Dictionary(acro));
                inc.new_document
                    .set_object(root_id, Object::Dictionary(catalog));
            }
            Ok(removed)
        }
        _ => Ok(false),
    }
}

/// What a widget of a saved file shows, for the tests that must not use lopdf themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WidgetLook {
    /// The content of the normal appearance stream (for a button: the one `/AS` names).
    pub appearance: Option<String>,
    /// `/AS`.
    pub state: Option<String>,
    /// `/V` of the object as a name or a text.
    pub value: Option<String>,
}

/// Looks at object `num` of `bytes`.
pub fn inspect_widget(bytes: &[u8], num: u32) -> Result<WidgetLook, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    let dict = doc
        .get_dictionary((num, 0))
        .map_err(|e| failed(format!("lopdf: {e}")))?;
    let state = entry(&doc, dict, b"AS")
        .and_then(name_of)
        .map(|n| String::from_utf8_lossy(&n).into_owned());
    let normal = dict_of(&doc, dict, b"AP").and_then(|ap| entry(&doc, ap, b"N"));
    let stream = match normal {
        Some(Object::Stream(stream)) => Some(stream),
        Some(Object::Dictionary(states)) => state
            .as_ref()
            .and_then(|s| entry(&doc, states, s.as_bytes()))
            .and_then(|o| o.as_stream().ok()),
        _ => None,
    };
    Ok(WidgetLook {
        appearance: stream.map(|s| String::from_utf8_lossy(&s.content).into_owned()),
        state,
        value: entry(&doc, dict, b"V").and_then(|v| state_text(&doc, v)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_strings_are_decoded_from_utf16_utf8_and_latin1_with_line_feeds() {
        assert_eq!(
            decode_text(&[0xFE, 0xFF, 0x00, 0x41, 0x20, 0xAC], 100),
            "A\u{20AC}"
        );
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x41, 0x00], 100), "A");
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, 0xC3, 0xA4], 100), "\u{E4}");
        assert_eq!(decode_text(b"a\r\nb\rc\x07d", 100), "a\nb\ncd");
        assert_eq!(decode_text(b"abcdef", 3), "abc");
        assert_eq!(decode_text(&[0xE4], 10), "\u{E4}");
    }

    #[test]
    fn a_default_appearance_gives_the_size_and_the_last_colour() {
        assert_eq!(parse_da(b"/Helv 12 Tf 0 g"), (12.0, Rgb([0, 0, 0])));
        assert_eq!(parse_da(b"0 0 1 rg /Arial 0 Tf"), (0.0, Rgb([0, 0, 255])));
        assert_eq!(parse_da(b"/F 9.5 Tf 1 0 0 0 k"), (9.5, Rgb([0, 255, 255])));
        assert_eq!(parse_da(b"junk Tf rg"), (0.0, Rgb([0, 0, 0])));
    }

    #[test]
    fn values_are_written_as_pdfdoc_when_they_can_be_and_utf16_when_not() {
        let Object::String(plain, _) = pdf_text_string("Gr\u{FC}n") else {
            panic!("not a string")
        };
        assert_eq!(plain, [b'G', b'r', 0xFC, b'n']);
        let Object::String(wide, _) = pdf_text_string("\u{20AC}") else {
            panic!("not a string")
        };
        assert_eq!(wide, [0xFE, 0xFF, 0x20, 0xAC]);
    }
}
