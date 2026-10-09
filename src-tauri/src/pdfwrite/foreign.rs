//! What other programs wrote into an annotation and PDFium does not report, read with lopdf so a comment made in Acrobat, Foxit,
//! PDF-XChange, Preview, Edge or Okular comes into Sheer as a regular, editable comment (F19.1, ADR-141).
//!
//! The engine reads the page through PDFium (`engine::import`); that gives the kind, the geometry of the common kinds and the colours of
//! the appearance. What it leaves out is read here, after it, by position in the page's `/Annots` (every dictionary counts, popups do
//! not, as in `reviews`): the text of `/RC` when `/Contents` is empty, the date in any of its spellings (normalised to ISO 8601 UTC),
//! `/CA`, `/C`, `/IC`, the border width and dash, the icon of a note, `/DA` and `/Q` of a free text, the strokes of an ink, the quads of
//! a squiggly line, the lines (`lines`) and the reply links (`reviews`). [`lift`] puts them on the imported annotation. Whatever cannot be
//! lifted (polygons, carets, stamps of other programs, ...) stays opaque, but its text, author and date show in the comments panel.
//!
//! A file is hostile input: the page's array is capped, every string is cut and cleaned, every number is checked, and a value of the
//! wrong type is ignored. Nothing here fails the open of a document.

use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object, ObjectId};

use super::forms::{color_of, decode_text, dict_of, entry, int, number, parse_da};
use super::lines::{read_line, LineRead};
use super::reviews::{break_cycles, link_of, Groups, ReviewLink};
use crate::engine::import::clean;
use crate::error::AppError;
use crate::limits;
use crate::model::annotation::{AnnotationBody, Imported, NoteIcon, Rgb, Stroke, TextAlign};
use crate::model::geometry::{normalize_quad, Point};

/// Most bytes of a text string that are decoded: the longest wanted text in UTF-16 with its byte order mark.
const fn raw_cap(chars: usize) -> usize {
    chars * 4 + 8
}

/// Longest rich text (`/RC`) that is looked at, in bytes: markup around the text takes a multiple of it.
const MAX_RC_BYTES: usize = 8 * limits::MAX_ANNOT_CONTENTS_CHARS;
/// Most numbers read from one `/InkList`.
const MAX_INK_NUMBERS: usize = 2 * limits::MAX_INK_POINTS_TOTAL;
/// Most numbers read from one `/QuadPoints`.
const MAX_QUAD_NUMBERS: usize = 8 * limits::MAX_ANNOT_QUADS;

/// What the file says about one annotation, beyond what PDFium reported.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ForeignRead {
    pub link: ReviewLink,
    pub line: Option<LineRead>,
    /// `/Contents`, or, when that is empty, the plain text of `/RC`.
    pub contents: Option<String>,
    pub author: Option<String>,
    /// ISO 8601 UTC of `/M`, else of `/CreationDate`; `None` for a date that cannot be read.
    pub modified: Option<String>,
    pub opacity: Option<f32>,
    pub color: Option<Rgb>,
    pub interior: Option<Rgb>,
    /// `/BS /W` or the third number of `/Border`.
    pub width: Option<f32>,
    pub dashed: bool,
    pub icon: Option<NoteIcon>,
    /// The size and the text colour `/DA` sets (a size of 0 is "automatic" and is left out).
    pub font_size: Option<f32>,
    pub text_color: Option<Rgb>,
    pub align: Option<TextAlign>,
    /// `/InkList` in user space, one list of points per stroke; `None` if absent or not usable.
    pub ink: Option<Vec<Vec<(f32, f32)>>>,
    /// `/QuadPoints` of a squiggly line in user space, four corners per quad.
    pub squiggly: Option<Vec<[(f32, f32); 4]>>,
    /// `/Rect`: left, bottom, right, top (normalised).
    pub rect: Option<[f32; 4]>,
}

fn is_popup(dict: &Dictionary) -> bool {
    matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == b"Popup")
}

fn subtype_is(dict: &Dictionary, wanted: &[u8]) -> bool {
    matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == wanted)
}

// --- Texts ---------------------------------------------------------------------------------------------------------

/// A text string of `dict[key]`, cleaned, at most `max` characters. `None` if it is absent, not a string, or empty.
fn text_at(doc: &Document, dict: &Dictionary, key: &[u8], max: usize) -> Option<String> {
    match entry(doc, dict, key)? {
        Object::String(bytes, _) if bytes.len() <= raw_cap(max) => {
            Some(clean(&decode_text(bytes, max), max)).filter(|text| !text.is_empty())
        }
        _ => None,
    }
}

/// `/RC` of `dict` as plain text: a string, or a stream without filters (a filtered one is not inflated: that is a bomb's way in).
fn rich_text(doc: &Document, dict: &Dictionary) -> Option<String> {
    let markup = match entry(doc, dict, b"RC")? {
        Object::String(bytes, _) if bytes.len() <= MAX_RC_BYTES => decode_text(bytes, MAX_RC_BYTES),
        Object::Stream(stream)
            if !stream.dict.has(b"Filter") && stream.content.len() <= MAX_RC_BYTES =>
        {
            let bytes = &stream.content;
            if bytes.starts_with(&[0xFE, 0xFF])
                || bytes.starts_with(&[0xFF, 0xFE])
                || bytes.starts_with(&[0xEF, 0xBB, 0xBF])
            {
                decode_text(bytes, MAX_RC_BYTES)
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
        _ => return None,
    };
    let plain = rich_to_plain(&markup);
    Some(clean(&plain, limits::MAX_ANNOT_CONTENTS_CHARS)).filter(|text| !text.is_empty())
}

/// The plain text of the XHTML of an `/RC`: tags go, `</p>` and `<br>` become line breaks, the common entities are decoded, runs of
/// white space are one space (as in XHTML).
fn rich_to_plain(markup: &str) -> String {
    let mut out = String::new();
    let mut chars = markup.chars().peekable();
    let mut skip_until: Option<&'static str> = None;
    let newline = |out: &mut String| {
        while out.ends_with(' ') {
            out.pop();
        }
        if !out.is_empty() && out.chars().rev().take_while(|c| *c == '\n').count() < 2 {
            out.push('\n');
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                let mut tag = String::new();
                for next in chars.by_ref() {
                    if next == '>' {
                        break;
                    }
                    if tag.chars().count() < 256 {
                        tag.push(next);
                    }
                }
                let lower = tag.to_ascii_lowercase();
                let closing = lower.starts_with('/');
                let name: String = lower
                    .trim_start_matches('/')
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                if let Some(end) = skip_until {
                    if closing && name == end {
                        skip_until = None;
                    }
                    continue;
                }
                match (name.as_str(), closing) {
                    ("style", false) => skip_until = Some("style"),
                    ("script", false) => skip_until = Some("script"),
                    ("br", _) | ("p" | "div" | "li", true) => newline(&mut out),
                    _ => {}
                }
            }
            _ if skip_until.is_some() => {}
            '&' => {
                let mut entity = String::new();
                while let Some(&next) = chars.peek() {
                    if next == ';' || entity.chars().count() >= 10 || next == '<' || next == ' ' {
                        break;
                    }
                    entity.push(next);
                    chars.next();
                }
                let decoded = if chars.peek() == Some(&';') {
                    let found = match entity.as_str() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        "nbsp" => Some(' '),
                        _ => entity
                            .strip_prefix("#x")
                            .or_else(|| entity.strip_prefix("#X"))
                            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                            .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                            .and_then(char::from_u32),
                    };
                    found.inspect(|_| {
                        chars.next();
                    })
                } else {
                    None
                };
                match decoded {
                    Some(c) => out.push(c),
                    None => {
                        out.push('&');
                        out.push_str(&entity);
                    }
                }
            }
            c if c.is_whitespace() => {
                if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                    out.push(' ');
                }
            }
            c => out.push(c),
        }
    }
    out.trim_end().to_owned()
}

// --- Dates ---------------------------------------------------------------------------------------------------------

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted = (month + 9) % 12;
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        _ => 28,
    }
}

/// A date of a PDF in any of the spellings programs use, as ISO 8601 UTC: `D:YYYYMMDDHHmmSSOHH'mm'` (every part after the year
/// optional, `D:` optional, the offset as `Z`, `+01'00'`, `+0100`, `+01`, or `Z00'00'`), and `YYYY-MM-DD[T ]HH:mm[:SS[.f]][Z|+HH[:mm]]`.
/// A date without an offset is taken as UTC. `None` for anything else, and before 1970 or after 9999.
pub fn normalize_date(text: &str) -> Option<String> {
    let text = text.trim();
    let text = text
        .strip_prefix("D:")
        .or_else(|| text.strip_prefix("d:"))
        .unwrap_or(text);
    if text.len() > 64 || !text.is_ascii() {
        return None;
    }
    let bytes = text.as_bytes();
    let digits = |from: usize, count: usize| -> Option<i64> {
        let slice = bytes.get(from..from + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(slice).ok()?.parse().ok()
    };
    let (year, month, day, hour, minute, second, rest): (i64, i64, i64, i64, i64, i64, &str);
    if bytes.get(4) == Some(&b'-') {
        year = digits(0, 4)?;
        month = digits(5, 2)?;
        day = digits(8, 2)?;
        let mut at = 10;
        let (mut h, mut mi, mut s) = (0, 0, 0);
        if matches!(bytes.get(at), Some(b'T' | b't' | b' ')) {
            h = digits(at + 1, 2)?;
            at += 3;
            if bytes.get(at) == Some(&b':') {
                mi = digits(at + 1, 2)?;
                at += 3;
                if bytes.get(at) == Some(&b':') {
                    s = digits(at + 1, 2)?;
                    at += 3;
                    if bytes.get(at) == Some(&b'.') || bytes.get(at) == Some(&b',') {
                        at += 1;
                        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                            at += 1;
                        }
                    }
                }
            }
        }
        (hour, minute, second, rest) = (h, mi, s, &text[at.min(text.len())..]);
    } else {
        let count = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
        if !matches!(count, 4 | 6 | 8 | 10 | 12 | 14) {
            return None;
        }
        year = digits(0, 4)?;
        month = if count >= 6 { digits(4, 2)? } else { 1 };
        day = if count >= 8 { digits(6, 2)? } else { 1 };
        hour = if count >= 10 { digits(8, 2)? } else { 0 };
        minute = if count >= 12 { digits(10, 2)? } else { 0 };
        second = if count >= 14 { digits(12, 2)? } else { 0 };
        rest = &text[count..];
    }
    // `second` 60 (a leap second) counts as 59.
    let second = second.min(59);
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
    {
        return None;
    }
    let rest = rest.trim();
    let offset_minutes = match rest.chars().next() {
        None | Some('Z' | 'z') => 0,
        Some(sign @ ('+' | '-')) => {
            let digits: Vec<i64> = rest[1..]
                .chars()
                .filter(|c| !matches!(c, '\'' | ':'))
                .map_while(|c| c.to_digit(10).map(i64::from))
                .collect();
            let (h, m) = match digits.as_slice() {
                [a, b] => (a * 10 + b, 0),
                [a, b, c, d] => (a * 10 + b, c * 10 + d),
                _ => return None,
            };
            if h > 23 || m > 59 {
                return None;
            }
            (h * 60 + m) * if sign == '-' { -1 } else { 1 }
        }
        Some(_) => return None,
    };
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second
        - offset_minutes * 60;
    Some(crate::commands::annotations::iso8601_utc(
        u64::try_from(secs).ok()?,
    ))
}

// --- Small values --------------------------------------------------------------------------------------------------

/// Up to `max` numbers of the array at `dict[key]`.
fn numbers_at(doc: &Document, dict: &Dictionary, key: &[u8], max: usize) -> Vec<f32> {
    let Some(Object::Array(items)) = entry(doc, dict, key) else {
        return Vec::new();
    };
    items
        .iter()
        .take(max)
        .filter_map(|item| number(doc.dereference(item).ok()?.1))
        .collect()
}

fn color_at(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Rgb> {
    color_of(doc, dict.get(key).ok()?)
}

/// The width of the border (`/BS /W`, else the third number of `/Border`) and whether it is dashed.
fn border_of(doc: &Document, dict: &Dictionary) -> (Option<f32>, bool) {
    let mut width = None;
    let mut dashed = false;
    if let Some(style) = dict_of(doc, dict, b"BS") {
        width = entry(doc, style, b"W").and_then(number);
        dashed = matches!(entry(doc, style, b"S"), Some(Object::Name(name)) if name == b"D");
    }
    if width.is_none() {
        let border = numbers_at(doc, dict, b"Border", 3);
        width = border.get(2).copied();
        if let Some(Object::Array(parts)) = entry(doc, dict, b"Border").filter(|_| width.is_some())
        {
            dashed = matches!(parts.get(3), Some(Object::Array(dash)) if !dash.is_empty());
        }
    }
    let width = width
        .filter(|w| w.is_finite() && *w >= 0.0)
        .map(|w| w.min(limits::MAX_ANNOT_STROKE_PT));
    (width, dashed)
}

fn icon_of(doc: &Document, dict: &Dictionary) -> Option<NoteIcon> {
    match entry(doc, dict, b"Name")? {
        Object::Name(name) if name == b"Comment" => Some(NoteIcon::Comment),
        Object::Name(name) if name == b"Help" => Some(NoteIcon::Help),
        // Note, and the icons the model has no picture for (Key, Insert, Paragraph, ...), are a note.
        Object::Name(_) => Some(NoteIcon::Note),
        _ => None,
    }
}

/// Whether the default appearance string sets a text colour (`g`, `rg` or `k`).
fn da_sets_color(da: &[u8]) -> bool {
    String::from_utf8_lossy(&da[..da.len().min(4096)])
        .split_ascii_whitespace()
        .any(|token| matches!(token, "g" | "rg" | "k"))
}

fn ink_of(doc: &Document, dict: &Dictionary) -> Option<Vec<Vec<(f32, f32)>>> {
    let Some(Object::Array(list)) = entry(doc, dict, b"InkList") else {
        return None;
    };
    let range = limits::MAX_PAGE_SIDE_PT * 4.0;
    let mut budget = MAX_INK_NUMBERS;
    let mut strokes = Vec::new();
    for item in list.iter().take(limits::MAX_INK_STROKES + 1) {
        let Ok((_, Object::Array(coords))) = doc.dereference(item) else {
            continue;
        };
        if coords.len() > budget {
            return None;
        }
        budget -= coords.len();
        let values: Vec<f32> = coords
            .iter()
            .filter_map(|c| number(doc.dereference(c).ok()?.1))
            .collect();
        if values.len() != coords.len() || values.iter().any(|v| v.abs() > range) {
            return None;
        }
        let points: Vec<(f32, f32)> = values
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| (p[0], p[1]))
            .collect();
        if !points.is_empty() {
            strokes.push(points);
        }
    }
    (!strokes.is_empty() && strokes.len() <= limits::MAX_INK_STROKES).then_some(strokes)
}

fn quads_of(doc: &Document, dict: &Dictionary) -> Option<Vec<[(f32, f32); 4]>> {
    let values = numbers_at(doc, dict, b"QuadPoints", MAX_QUAD_NUMBERS);
    let range = limits::MAX_PAGE_SIDE_PT * 4.0;
    if values.iter().any(|v| v.abs() > range) {
        return None;
    }
    let quads: Vec<[(f32, f32); 4]> = values
        .as_chunks::<8>()
        .0
        .iter()
        .map(|q| [(q[0], q[1]), (q[2], q[3]), (q[4], q[5]), (q[6], q[7])])
        .collect();
    (!quads.is_empty()).then_some(quads)
}

fn read_one(
    doc: &Document,
    dict: &Dictionary,
    position: u32,
    positions: &HashMap<ObjectId, u32>,
) -> ForeignRead {
    let (width, dashed) = border_of(doc, dict);
    let contents = text_at(doc, dict, b"Contents", limits::MAX_ANNOT_CONTENTS_CHARS)
        .or_else(|| rich_text(doc, dict));
    let da = match entry(doc, dict, b"DA") {
        Some(Object::String(bytes, _)) if bytes.len() <= 4096 => Some(bytes.as_slice()),
        _ => None,
    };
    let (size, da_color) = da.map(parse_da).unzip();
    let rect = numbers_at(doc, dict, b"Rect", 4);
    let range = limits::MAX_PAGE_SIDE_PT * 4.0;
    let rect = match rect.as_slice() {
        [a, b, c, d] if [a, b, c, d].iter().all(|v| v.abs() <= range) => {
            Some([a.min(*c), b.min(*d), a.max(*c), b.max(*d)])
        }
        _ => None,
    };
    let modified =
        ["M", "CreationDate"]
            .iter()
            .find_map(|key| match entry(doc, dict, key.as_bytes())? {
                Object::String(bytes, _) if bytes.len() <= 128 => {
                    normalize_date(&decode_text(bytes, 64))
                }
                _ => None,
            });
    ForeignRead {
        link: link_of(doc, dict, position, positions),
        line: if subtype_is(dict, b"Line") {
            read_line(doc, dict)
        } else {
            None
        },
        contents,
        author: text_at(doc, dict, b"T", limits::MAX_ANNOT_AUTHOR_CHARS),
        modified,
        opacity: entry(doc, dict, b"CA")
            .and_then(number)
            .map(|o| o.clamp(0.0, 1.0)),
        color: color_at(doc, dict, b"C"),
        interior: color_at(doc, dict, b"IC"),
        width,
        dashed,
        icon: icon_of(doc, dict),
        font_size: size
            .filter(|s| (limits::MIN_FONT_SIZE_PT..=limits::MAX_FONT_SIZE_PT).contains(s)),
        text_color: da.filter(|bytes| da_sets_color(bytes)).and(da_color),
        align: match int(doc, dict, b"Q") {
            Some(0) => Some(TextAlign::Left),
            Some(1) => Some(TextAlign::Center),
            Some(2) => Some(TextAlign::Right),
            _ => None,
        },
        ink: if subtype_is(dict, b"Ink") {
            ink_of(doc, dict)
        } else {
            None
        },
        squiggly: if subtype_is(dict, b"Squiggly") {
            quads_of(doc, dict)
        } else {
            None
        },
        rect,
    }
}

/// What the file says about the annotations of page `page_index` of `bytes`, by position (every annotation but a popup has an entry).
pub fn read_page(bytes: &[u8], page_index: u32) -> Result<HashMap<u32, ForeignRead>, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    let groups = cached_groups(bytes, &doc);
    Ok(read_doc_page(&doc, page_index, &groups))
}

/// The groups of the last document read by [`read_page`], keyed by a hash of its bytes: reading page after page (scrolling) scans the
/// whole document's annotations once, not once per page. Any save or change of the file changes the bytes and so the key.
fn cached_groups(bytes: &[u8], doc: &Document) -> std::sync::Arc<Groups> {
    use std::hash::{Hash, Hasher};
    type Cache = Option<(u64, usize, std::sync::Arc<Groups>)>;
    static CACHE: std::sync::Mutex<Cache> = std::sync::Mutex::new(None);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let key = hasher.finish();
    let Ok(mut cache) = CACHE.lock() else {
        return std::sync::Arc::new(Groups::of(doc));
    };
    if let Some((cached_key, len, groups)) = cache.as_ref() {
        if *cached_key == key && *len == bytes.len() {
            return groups.clone();
        }
    }
    let groups = std::sync::Arc::new(Groups::of(doc));
    *cache = Some((key, bytes.len(), groups.clone()));
    groups
}

/// What the file says about the annotations of every page, by page index, then by position: one parse for the whole document. The
/// annotations read are capped at `limits::MAX_ANNOTATIONS_PER_DOC`; pages beyond it have no entry.
pub fn read_all(bytes: &[u8]) -> Result<HashMap<u32, HashMap<u32, ForeignRead>>, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    let groups = Groups::of(&doc);
    let mut all = HashMap::new();
    let mut total = 0usize;
    for number in doc.get_pages().keys() {
        if total >= limits::MAX_ANNOTATIONS_PER_DOC {
            break;
        }
        let page_index = number.saturating_sub(1);
        let page = read_doc_page(&doc, page_index, &groups);
        total += page.len();
        if !page.is_empty() {
            all.insert(page_index, page);
        }
    }
    Ok(all)
}

/// Whether the entry of `/Annots` takes a position. The engine and this reader count the same way (one counter, `engine::import`):
/// every entry takes one, a broken one (not a dictionary, a missing object) included, except a popup; at most
/// `limits::MAX_IMPORT_PER_PAGE` entries are scanned. So a crafted array cannot move one annotation's text onto another.
fn takes_a_position(entry: Option<&Dictionary>) -> bool {
    !entry.is_some_and(is_popup)
}

fn read_doc_page(doc: &Document, page_index: u32, groups: &Groups) -> HashMap<u32, ForeignRead> {
    let pages = doc.get_pages();
    let Some(page_id) = pages.get(&page_index.saturating_add(1)) else {
        return HashMap::new();
    };
    let Ok(page) = doc.get_dictionary(*page_id) else {
        return HashMap::new();
    };
    let entries: Vec<Object> = match page
        .get(b"Annots")
        .ok()
        .and_then(|annots| doc.dereference(annots).ok())
        .map(|(_, object)| object)
    {
        Some(Object::Array(array)) => array
            .iter()
            .take(limits::MAX_IMPORT_PER_PAGE)
            .cloned()
            .collect(),
        _ => return HashMap::new(),
    };
    let mut counted: Vec<(Option<ObjectId>, Option<&Dictionary>)> = Vec::new();
    for entry in &entries {
        let found = match doc.dereference(entry) {
            Ok((id, Object::Dictionary(dict))) => (entry.as_reference().ok().or(id), Some(dict)),
            _ => (None, None),
        };
        if takes_a_position(found.1) {
            counted.push(found);
        }
    }
    let positions: HashMap<ObjectId, u32> = counted
        .iter()
        .zip(0u32..)
        .filter_map(|((id, _), position)| id.map(|id| (id, position)))
        .collect();
    let mut read: HashMap<u32, ForeignRead> = counted
        .iter()
        .zip(0u32..)
        .filter_map(|((own, dict), position)| {
            let dict = (*dict)?;
            let mut one = read_one(doc, dict, position, &positions);
            one.link.group = groups.group_of(doc, dict, *own);
            Some((position, one))
        })
        .collect();
    let mut links: HashMap<u32, ReviewLink> = read.iter().map(|(p, r)| (*p, r.link)).collect();
    break_cycles(&mut links);
    for (position, link) in links {
        if let Some(entry) = read.get_mut(&position) {
            entry.link = link;
        }
    }
    read
}

// --- Lifting -------------------------------------------------------------------------------------------------------

/// The outline polygon of a stroke of `width` through `points`: the offsets to the left going forward, to the right coming back.
fn outline_of(points: &[Point], width: f32) -> Vec<Point> {
    let radius = (width / 2.0).max(0.25);
    let unit = |from: Point, to: Point| {
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        let length = dx.hypot(dy);
        (length > 1.0e-4).then(|| (dx / length, dy / length))
    };
    let mut left = Vec::with_capacity(points.len());
    let mut right = Vec::with_capacity(points.len());
    for (at, point) in points.iter().enumerate() {
        let before = at.checked_sub(1).and_then(|i| unit(points[i], *point));
        let after = points.get(at + 1).and_then(|next| unit(*point, *next));
        let (dx, dy) = match (before, after) {
            (Some(a), Some(b)) => {
                let sum = (a.0 + b.0, a.1 + b.1);
                if sum.0.hypot(sum.1) > 1.0e-3 {
                    let length = sum.0.hypot(sum.1);
                    (sum.0 / length, sum.1 / length)
                } else {
                    b
                }
            }
            (Some(d), None) | (None, Some(d)) => d,
            (None, None) => (1.0, 0.0),
        };
        let (nx, ny) = (-dy * radius, dx * radius);
        left.push(Point {
            x: point.x + nx,
            y: point.y + ny,
        });
        right.push(Point {
            x: point.x - nx,
            y: point.y - ny,
        });
    }
    right.reverse();
    left.extend(right);
    left
}

fn strokes_of(item: &Imported, read: &ForeignRead, width: f32) -> Option<Vec<Stroke>> {
    let list = read.ink.as_ref()?;
    let [left, _, _, top] = read.rect?;
    let at = |(x, y): (f32, f32)| Point {
        x: item.rect.x + (x - left),
        y: item.rect.y + (top - y),
    };
    let mut total = 0usize;
    let mut strokes = Vec::new();
    for stroke in list {
        let points: Vec<Point> = stroke.iter().map(|p| at(*p)).collect();
        let outline = outline_of(&points, width);
        total += points.len() + outline.len();
        if outline.len() > limits::MAX_INK_POINTS_PER_STROKE || total > limits::MAX_INK_POINTS_TOTAL
        {
            return None;
        }
        strokes.push(Stroke { points, outline });
    }
    (!strokes.is_empty()).then_some(strokes)
}

fn free_text_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .take(limits::MAX_FREE_TEXT_LINES)
        .map(|line| {
            line.chars()
                .take(limits::MAX_FREE_TEXT_LINE_CHARS)
                .collect()
        })
        .collect()
}

/// Puts what the file says on the annotation the engine imported: the text, author and date; the opacity and the colour; and, per
/// kind, the geometry and style PDFium could not report. A kind with no model type stays opaque, with its text.
pub fn lift(item: &mut Imported, read: &ForeignRead) {
    if let Some(line) = &read.line {
        super::lines::lift(item, line);
    }
    // A squiggly line is an underline of the model (it has no wavy one); an edit writes it as an underline.
    if let (AnnotationBody::Opaque { subtype }, Some(quads), Some([left, _, _, top])) =
        (&item.body, &read.squiggly, read.rect)
    {
        if subtype == "Squiggly" {
            let quads: Vec<_> = quads
                .iter()
                .take(limits::MAX_ANNOT_QUADS)
                .map(|q| {
                    normalize_quad(q.map(|(x, y)| Point {
                        x: item.rect.x + (x - left),
                        y: item.rect.y + (top - y),
                    }))
                })
                .collect();
            item.body = AnnotationBody::Underline { quads };
            if read.color.is_none() {
                item.color = Rgb([0, 0, 0]);
            }
        }
    }
    let had_contents = !item.contents.is_empty();
    if !had_contents {
        if let Some(text) = &read.contents {
            item.contents.clone_from(text);
        }
    }
    if item.author.is_none() {
        item.author.clone_from(&read.author);
    }
    if let Some(modified) = &read.modified {
        item.modified = Some(modified.clone());
    }
    if let Some(opacity) = read.opacity {
        item.opacity = opacity;
    }
    let width = read.width;
    let ink_width = width.filter(|w| *w > 0.0).unwrap_or(1.0);
    let ink = strokes_of(item, read, ink_width);
    let contents = item.contents.clone();
    // The stroke colour of the kinds that draw with `/C`; a free text's `/C` is its background and a stamp keeps its own look.
    let mut paint = None;
    match &mut item.body {
        AnnotationBody::Note { icon, .. } => {
            if let Some(found) = read.icon {
                *icon = found;
            }
            paint = read.color;
        }
        AnnotationBody::Highlight { .. }
        | AnnotationBody::Underline { .. }
        | AnnotationBody::Strikeout { .. } => paint = read.color,
        AnnotationBody::Rect {
            width: shape_width,
            fill,
            dashed,
            ..
        }
        | AnnotationBody::Ellipse {
            width: shape_width,
            fill,
            dashed,
            ..
        } => {
            if let Some(found) = width {
                *shape_width = found;
            }
            *dashed = read.dashed;
            if let Some(found) = read.interior {
                *fill = Some(found);
            }
            paint = read.color;
        }
        AnnotationBody::Line {
            width: line_width, ..
        } => {
            *line_width = width.filter(|w| *w > 0.0).unwrap_or(*line_width);
            paint = read.color;
        }
        AnnotationBody::FreeText {
            lines,
            font_size,
            fill,
            border_width,
            align,
            ..
        } => {
            if !had_contents && !contents.is_empty() {
                *lines = free_text_lines(&contents);
            }
            if let Some(found) = read.font_size {
                *font_size = found;
            }
            if let Some(found) = read.align {
                *align = found;
            }
            if let Some(found) = read.color.or(read.interior) {
                *fill = Some(found);
            }
            if let Some(found) = width {
                *border_width = found;
            }
            if let Some(found) = read.text_color {
                item.color = found;
            }
        }
        AnnotationBody::Opaque { subtype } if subtype == "Ink" => {
            if let Some(strokes) = ink {
                item.body = AnnotationBody::Ink {
                    strokes,
                    width: ink_width,
                };
                paint = read.color;
            }
        }
        AnnotationBody::Opaque { .. } => paint = read.color,
        AnnotationBody::Ink { width: w, .. } => {
            *w = ink_width;
            paint = read.color;
        }
        _ => {}
    }
    if let Some(color) = paint {
        item.color = color;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::annotation::PdfOrigin;
    use crate::model::geometry::Rect;
    use lopdf::{dictionary, StringFormat};

    fn s(text: &str) -> Object {
        Object::string_literal(text)
    }

    fn reals(values: &[f32]) -> Object {
        Object::Array(values.iter().map(|v| Object::Real(*v)).collect())
    }

    fn file(annots: Vec<Dictionary>) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let refs: Vec<Object> = annots
            .into_iter()
            .map(|dict| Object::Reference(doc.add_object(dict)))
            .collect();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Annots" => refs,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
            ),
        );
        let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn imported(body: AnnotationBody, rect: Rect) -> Imported {
        Imported {
            origin: PdfOrigin {
                page_index: 0,
                annot_index: 0,
                name: None,
            },
            body,
            rect,
            color: Rgb([9, 9, 9]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            locked: false,
            hidden: false,
        }
    }

    fn opaque(subtype: &str, rect: Rect) -> Imported {
        imported(
            AnnotationBody::Opaque {
                subtype: subtype.into(),
            },
            rect,
        )
    }

    const BOX: Rect = Rect {
        x: 10.0,
        y: 45.0,
        w: 120.0,
        h: 30.0,
    };

    #[test]
    fn dates_in_every_spelling_become_iso_utc() {
        for (given, expected) in [
            ("D:20261007100000Z", Some("2026-10-07T10:00:00Z")),
            ("D:20261007120000+02'00'", Some("2026-10-07T10:00:00Z")),
            ("D:20261007120000+0200", Some("2026-10-07T10:00:00Z")),
            ("D:20261007120000+02", Some("2026-10-07T10:00:00Z")),
            ("D:20261007020000-08'00", Some("2026-10-07T10:00:00Z")),
            ("D:20261007100000Z00'00'", Some("2026-10-07T10:00:00Z")),
            ("20261007100000", Some("2026-10-07T10:00:00Z")),
            ("D:20261007", Some("2026-10-07T00:00:00Z")),
            ("D:202610", Some("2026-10-01T00:00:00Z")),
            ("D:2026", Some("2026-01-01T00:00:00Z")),
            ("2026-10-07T10:00:00Z", Some("2026-10-07T10:00:00Z")),
            (
                "2026-10-07T12:00:00.250+02:00",
                Some("2026-10-07T10:00:00Z"),
            ),
            ("2026-10-07 10:00", Some("2026-10-07T10:00:00Z")),
            ("D:20240229235959Z", Some("2024-02-29T23:59:59Z")),
            ("D:20230229000000Z", None),
            ("D:20261301000000Z", None),
            ("D:20261007250000Z", None),
            ("D:19600101000000Z", None),
            ("D:2026100", None),
            ("yesterday", None),
            ("", None),
            ("D:20261007100000Q", None),
        ] {
            assert_eq!(normalize_date(given).as_deref(), expected, "{given}");
        }
    }

    #[test]
    fn rich_text_becomes_plain_text() {
        let rc = "<?xml version=\"1.0\"?><body xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:xfa=\"x\"><p dir=\"ltr\"><span style=\"font-size:12pt\">Hello &amp; <b>wor</b>ld</span></p><p>Second\n   line&#33; &#x41;&lt;b&gt; &bogus; &</p></body>";
        assert_eq!(
            rich_to_plain(rc),
            "Hello & world\nSecond line! A<b> &bogus; &"
        );
        assert_eq!(
            rich_to_plain("<style>p{color:red}</style><p>a<br/>b</p>"),
            "a\nb"
        );
        assert_eq!(rich_to_plain("<p></p><p></p><p>x</p>"), "x");
        // A broken tag at the end and a tag that never closes do not loop or panic.
        assert_eq!(rich_to_plain("a<b"), "a");
        assert_eq!(rich_to_plain("&#99999999999;"), "&#99999999999;");
    }

    #[test]
    fn the_text_fields_are_read_with_the_fallbacks_and_popups_do_not_count() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Text", "Rect" => reals(&[10.0, 10.0, 30.0, 30.0]), "T" => s("Ada"),
            "Contents" => s("first\rsecond"), "M" => s("D:20261007100000Z"), "CA" => 0.5, "C" => reals(&[1.0, 0.0, 0.0]),
            "Name" => Object::Name(b"Comment".to_vec()), "Popup" => Object::Reference((99, 0))},
            dictionary! {"Subtype" => "Popup", "Parent" => Object::Reference((2, 0))},
            dictionary! {"Subtype" => "FreeText", "Rect" => reals(&[10.0, 100.0, 90.0, 140.0]), "RC" => s("<p>from rc</p>"),
            "CreationDate" => s("D:20261008120000+02'00'"), "DA" => s("/Helv 14 Tf 0 0 1 rg"), "Q" => 2,
            "C" => reals(&[1.0, 1.0, 0.0]), "BS" => dictionary!{"W" => 2.0}},
            dictionary! {"Subtype" => "Text", "Rect" => reals(&[0.0, 0.0, 1.0, 1.0]), "IRT" => Object::Reference((2, 0)),
            "StateModel" => s("Review"), "State" => s("Accepted"), "RT" => Object::Name(b"R".to_vec())},
        ]);
        let read = read_page(&bytes, 0).unwrap();
        assert_eq!(read.len(), 3);
        let note = &read[&0];
        assert_eq!(note.contents.as_deref(), Some("first\nsecond"));
        assert_eq!(note.author.as_deref(), Some("Ada"));
        assert_eq!(note.modified.as_deref(), Some("2026-10-07T10:00:00Z"));
        assert_eq!(note.opacity, Some(0.5));
        assert_eq!(note.color, Some(Rgb([255, 0, 0])));
        assert_eq!(note.icon, Some(NoteIcon::Comment));
        let free = &read[&1];
        assert_eq!(free.contents.as_deref(), Some("from rc"));
        assert_eq!(free.modified.as_deref(), Some("2026-10-08T10:00:00Z"));
        assert_eq!(
            (free.font_size, free.text_color),
            (Some(14.0), Some(Rgb([0, 0, 255])))
        );
        assert_eq!(free.align, Some(TextAlign::Right));
        assert_eq!(free.width, Some(2.0));
        assert_eq!(free.rect.map(|r| r[2] - r[0]), Some(80.0));
        let reply = &read[&2];
        assert_eq!(reply.link.reply_to, Some(0));
        assert_eq!(
            reply.link.state,
            Some(crate::model::annotation::ReviewState::Accepted)
        );
    }

    #[test]
    fn hostile_values_are_ignored() {
        let long = Object::String(vec![b'x'; 140_000], StringFormat::Literal);
        let bytes = file(vec![
            dictionary! {"Subtype" => "Text", "Contents" => long.clone(), "T" => long, "M" => Object::Integer(5),
            "CA" => 7.0, "C" => reals(&[2.0, 2.0]), "DA" => Object::Integer(3), "Q" => 9,
            "Rect" => reals(&[1.0e9, 0.0, 1.0, 1.0]), "Name" => Object::Integer(1)},
            dictionary! {"Subtype" => "Ink", "InkList" => Object::Array(vec![reals(&[1.0e12, 0.0, 1.0, 1.0])])},
            dictionary! {"Subtype" => "Ink", "InkList" => Object::Array(vec![Object::Array(vec![Object::Null; 4])])},
            dictionary! {"Subtype" => "Squiggly", "QuadPoints" => reals(&[1.0, 2.0, 3.0])},
        ]);
        let read = read_page(&bytes, 0).unwrap();
        let first = &read[&0];
        assert_eq!((first.contents.clone(), first.author.clone()), (None, None));
        assert_eq!((first.modified.clone(), first.rect), (None, None));
        assert_eq!(first.color, None);
        assert_eq!(first.icon, None);
        assert!(read[&1].ink.is_none() && read[&2].ink.is_none());
        assert!(read[&3].squiggly.is_none());
        assert!(read_page(&bytes, 7).unwrap().is_empty());
    }

    #[test]
    fn an_ink_is_lifted_with_an_outline_around_each_stroke() {
        let read = ForeignRead {
            ink: Some(vec![
                vec![(20.0, 150.0), (60.0, 150.0), (60.0, 130.0)],
                vec![(30.0, 140.0)],
            ]),
            rect: Some([10.0, 125.0, 130.0, 155.0]),
            width: Some(4.0),
            color: Some(Rgb([1, 2, 3])),
            opacity: Some(0.25),
            ..ForeignRead::default()
        };
        let mut item = opaque("Ink", BOX);
        lift(&mut item, &read);
        let AnnotationBody::Ink { strokes, width } = &item.body else {
            panic!("not lifted: {:?}", item.body);
        };
        assert_eq!(*width, 4.0);
        assert_eq!(strokes.len(), 2);
        assert_eq!(
            strokes[0].points[0],
            Point { x: 20.0, y: 50.0 },
            "y is turned and the offset is the rectangle's"
        );
        assert_eq!(strokes[0].outline.len(), 6);
        assert_eq!(strokes[1].outline.len(), 2);
        assert_eq!((item.color, item.opacity), (Rgb([1, 2, 3]), 0.25));
        // Too many points leave it opaque.
        let many = ForeignRead {
            ink: Some(vec![vec![(1.0, 1.0); limits::MAX_INK_POINTS_PER_STROKE]]),
            rect: Some([10.0, 125.0, 130.0, 155.0]),
            ..ForeignRead::default()
        };
        let mut item = opaque("Ink", BOX);
        lift(&mut item, &many);
        assert!(matches!(item.body, AnnotationBody::Opaque { .. }));
    }

    #[test]
    fn a_squiggly_becomes_an_underline_in_any_corner_order() {
        let read = ForeignRead {
            // Counterclockwise from the bottom left, as the specification has it.
            squiggly: Some(vec![[
                (20.0, 140.0),
                (120.0, 140.0),
                (120.0, 155.0),
                (20.0, 155.0),
            ]]),
            rect: Some([10.0, 125.0, 130.0, 155.0]),
            color: Some(Rgb([0, 128, 0])),
            contents: Some("fix".into()),
            ..ForeignRead::default()
        };
        let mut item = opaque("Squiggly", BOX);
        lift(&mut item, &read);
        let AnnotationBody::Underline { quads } = &item.body else {
            panic!("not lifted");
        };
        assert_eq!(
            quads[0],
            [
                Point { x: 20.0, y: 45.0 },
                Point { x: 120.0, y: 45.0 },
                Point { x: 20.0, y: 60.0 },
                Point { x: 120.0, y: 60.0 }
            ]
        );
        assert_eq!(
            (item.color, item.contents.as_str()),
            (Rgb([0, 128, 0]), "fix")
        );
    }

    #[test]
    fn shapes_free_texts_and_notes_take_what_the_file_says() {
        let mut square = imported(
            AnnotationBody::Rect {
                bounds: BOX,
                width: 1.0,
                fill: None,
                dashed: false,
            },
            BOX,
        );
        lift(
            &mut square,
            &ForeignRead {
                width: Some(3.0),
                dashed: true,
                interior: Some(Rgb([5, 6, 7])),
                color: Some(Rgb([1, 1, 1])),
                author: Some("Bo".into()),
                ..ForeignRead::default()
            },
        );
        assert_eq!(
            square.body,
            AnnotationBody::Rect {
                bounds: BOX,
                width: 3.0,
                fill: Some(Rgb([5, 6, 7])),
                dashed: true
            }
        );
        assert_eq!(
            (square.color, square.author.as_deref()),
            (Rgb([1, 1, 1]), Some("Bo"))
        );

        let mut free = imported(
            AnnotationBody::FreeText {
                bounds: BOX,
                lines: vec![String::new()],
                font_size: 12.0,
                fill: None,
                border_width: 0.0,
                align: TextAlign::Left,
                border_color: None,
            },
            BOX,
        );
        lift(
            &mut free,
            &ForeignRead {
                contents: Some("one\ntwo".into()),
                font_size: Some(20.0),
                text_color: Some(Rgb([0, 0, 255])),
                align: Some(TextAlign::Center),
                color: Some(Rgb([255, 255, 0])),
                width: Some(1.5),
                ..ForeignRead::default()
            },
        );
        let AnnotationBody::FreeText {
            lines,
            font_size,
            fill,
            border_width,
            align,
            ..
        } = &free.body
        else {
            panic!()
        };
        assert_eq!(lines, &["one", "two"]);
        assert_eq!(
            (*font_size, *border_width, *align),
            (20.0, 1.5, TextAlign::Center)
        );
        assert_eq!(*fill, Some(Rgb([255, 255, 0])));
        assert_eq!(
            free.color,
            Rgb([0, 0, 255]),
            "the text colour, not the background"
        );

        let mut note = imported(
            AnnotationBody::Note {
                at: Point { x: 1.0, y: 1.0 },
                icon: NoteIcon::Note,
            },
            BOX,
        );
        note.contents = "kept".into();
        lift(
            &mut note,
            &ForeignRead {
                icon: Some(NoteIcon::Help),
                contents: Some("other".into()),
                modified: Some("2026-10-07T10:00:00Z".into()),
                ..ForeignRead::default()
            },
        );
        assert!(matches!(
            note.body,
            AnnotationBody::Note {
                icon: NoteIcon::Help,
                ..
            }
        ));
        assert_eq!(note.contents, "kept", "what PDFium read is not replaced");
        assert_eq!(note.modified.as_deref(), Some("2026-10-07T10:00:00Z"));
    }

    #[test]
    fn what_has_no_model_type_stays_opaque_with_its_text() {
        let mut polygon = opaque("Polygon", BOX);
        lift(
            &mut polygon,
            &ForeignRead {
                contents: Some("see this".into()),
                author: Some("Cy".into()),
                color: Some(Rgb([1, 2, 3])),
                ..ForeignRead::default()
            },
        );
        assert!(matches!(polygon.body, AnnotationBody::Opaque { .. }));
        assert_eq!(
            (
                polygon.contents.as_str(),
                polygon.author.as_deref(),
                polygon.color
            ),
            ("see this", Some("Cy"), Rgb([1, 2, 3]))
        );
    }

    #[test]
    fn a_broken_entry_takes_a_position_like_in_the_engine_and_a_popup_does_not() {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let note = doc.add_object(dictionary! {"Subtype" => "Text", "Contents" => s("mine")});
        let popup = doc.add_object(dictionary! {"Subtype" => "Popup"});
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => vec![Object::Integer(5), Object::Reference((999, 0)), popup.into(), Object::Null, note.into()],
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
            ),
        );
        let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let read = read_page(&bytes, 0).unwrap();
        // 5, the missing object and null take positions 0, 1 and 2; the popup none; the note is position 3.
        assert_eq!(read.keys().copied().collect::<Vec<_>>(), [3]);
        assert_eq!(read[&3].contents.as_deref(), Some("mine"));
        assert_eq!(
            read_all(&bytes).unwrap()[&0][&3].contents.as_deref(),
            Some("mine")
        );
    }

    #[test]
    fn a_line_is_lifted_through_the_same_read() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Line", "L" => reals(&[20.0, 150.0, 120.0, 130.0]), "Rect" => reals(&[10.0, 125.0, 130.0, 155.0]),
            "LE" => Object::Array(vec![Object::Name(b"None".to_vec()), Object::Name(b"OpenArrow".to_vec())]),
            "BS" => dictionary!{"W" => 2.0}},
        ]);
        let read = read_page(&bytes, 0).unwrap();
        let mut item = opaque("Line", BOX);
        lift(&mut item, &read[&0]);
        assert!(matches!(item.body, AnnotationBody::Line { width, .. } if width == 2.0));
    }
}
